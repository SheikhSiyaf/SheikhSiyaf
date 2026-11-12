-- 0043 Automatic sending of simplified e-invoices to ZATCA (reporting within 24 hours), with retries and warnings.
--
--   * einvoices.next_attempt_at / last_attempt_at: when the server's sender tries next (retries after 2, 5, 10, 15,
--     then every 30 minutes while ZATCA cannot be reached). These are sending details, not the invoice: the e-invoice
--     itself still never changes.
--   * einvoice_send_leases: one sender at a time per device (several servers, or a slow run overlapping the next).
--   * einvoice_warnings: which warning (12, 20, 24 hours, rejected, login refused) each e-invoice already gave.
--   * job_runs: when each background job last ran, so monitoring can tell when one stops.

ALTER TABLE einvoices ADD COLUMN next_attempt_at timestamptz, ADD COLUMN last_attempt_at timestamptz;

CREATE OR REPLACE FUNCTION before_einvoice_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE dev einvoice_devices%ROWTYPE; doc documents%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO doc FROM documents WHERE id = NEW.document_id;
    IF doc.id IS NULL OR doc.company_id <> NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
    IF doc.status <> 'issued' OR doc.type NOT IN ('invoice', 'credit_note', 'debit_note') THEN RAISE EXCEPTION 'Only issued invoices, credit notes and debit notes are e-invoiced.'; END IF;
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now(); NEW.attempts := 0; NEW.submitted_at := NULL; NEW.cleared_xml := NULL; NEW.http_status := NULL;
    NEW.last_attempt_at := NULL; NEW.next_attempt_at := NULL;
    IF NEW.scheme = 'zatca' THEN
      -- The chain: each invoice takes the device's next counter and the hash of the one before.
      SELECT * INTO dev FROM einvoice_devices WHERE id = NEW.device_id FOR UPDATE;
      IF dev.id IS NULL OR dev.company_id <> NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
      IF dev.status <> 'active' THEN RAISE EXCEPTION 'This e-invoicing device is not active.'; END IF;
      IF NEW.icv <> dev.icv + 1 OR NEW.pih <> dev.last_hash THEN RAISE EXCEPTION 'The e-invoice chain moved on; prepare the invoice again.'; END IF;
      NEW.status := 'pending'; NEW.next_attempt_at := now();
      UPDATE einvoice_devices SET icv = NEW.icv, last_hash = NEW.invoice_hash WHERE id = dev.id;
    ELSE
      NEW.status := 'ready';
    END IF;
    RETURN NEW;
  END IF;
  -- Only the authority's answer and the sending schedule change; a cleared or reported invoice is final.
  IF (to_jsonb(NEW) - 'status' - 'cleared_xml' - 'warnings' - 'errors' - 'http_status' - 'attempts' - 'submitted_at' - 'next_attempt_at' - 'last_attempt_at')
     <> (to_jsonb(OLD) - 'status' - 'cleared_xml' - 'warnings' - 'errors' - 'http_status' - 'attempts' - 'submitted_at' - 'next_attempt_at' - 'last_attempt_at') THEN
    RAISE EXCEPTION 'An e-invoice is never changed. Only the authority''s answer is recorded.';
  END IF;
  IF OLD.status IN ('cleared', 'reported', 'rejected') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'The authority has answered for this e-invoice; it is final.';
  END IF;
  RETURN NEW;
END $$;

UPDATE einvoices SET next_attempt_at = created_at WHERE status = 'pending' AND scheme = 'zatca';
CREATE INDEX einvoices_to_send ON einvoices (device_id, icv) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- One sender per device
-- ---------------------------------------------------------------------------
CREATE TABLE einvoice_send_leases (
  device_id uuid PRIMARY KEY REFERENCES einvoice_devices(id),
  lease_id  uuid NOT NULL,
  until     timestamptz NOT NULL
);
ALTER TABLE einvoice_send_leases ENABLE ROW LEVEL SECURITY;   -- no policies: only the functions below

/** Devices with simplified e-invoices waiting to be reported, and the person the sender works as (who connected the device). */
CREATE FUNCTION einvoices_to_send(p_now timestamptz, p_all boolean) RETURNS TABLE (device_id uuid, company_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT d.id, d.company_id, d.created_by FROM einvoices e JOIN einvoice_devices d ON d.id = e.device_id
    JOIN companies c ON c.id = d.company_id JOIN users u ON u.id = d.created_by
  WHERE e.status = 'pending' AND e.scheme = 'zatca' AND e.kind = 'simplified' AND (p_all OR e.next_attempt_at <= p_now)
    AND d.status IN ('active', 'retired') AND c.status = 'active' AND u.status = 'active' AND app_user_id() IS NULL
$$;
/** Takes the device for one sender; false when another sender holds it. A lease ends by itself after p_seconds. */
CREATE FUNCTION einvoice_lease(p_device uuid, p_lease uuid, p_seconds int) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE got uuid;
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Only the server sends e-invoices.'; END IF;
  INSERT INTO einvoice_send_leases (device_id, lease_id, until) VALUES (p_device, p_lease, clock_timestamp() + make_interval(secs => p_seconds))
  ON CONFLICT (device_id) DO UPDATE SET lease_id = EXCLUDED.lease_id, until = EXCLUDED.until WHERE einvoice_send_leases.until < clock_timestamp()
  RETURNING lease_id INTO got;
  RETURN got = p_lease;
END $$;
CREATE FUNCTION einvoice_release(p_device uuid, p_lease uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM einvoice_send_leases WHERE device_id = p_device AND lease_id = p_lease AND app_user_id() IS NULL
$$;

-- ---------------------------------------------------------------------------
-- Warnings
-- ---------------------------------------------------------------------------
CREATE TABLE einvoice_warnings (
  einvoice_id uuid NOT NULL REFERENCES einvoices(id),
  stage       text NOT NULL CHECK (stage IN ('h12', 'h20', 'h24', 'rejected', 'login')),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (einvoice_id, stage)
);
ALTER TABLE einvoice_warnings ENABLE ROW LEVEL SECURITY;   -- no policies: only the functions below

/** Simplified e-invoices that may need a warning: still waiting, rejected (and not prepared again), or refused at login. */
CREATE FUNCTION einvoice_warnings_due(p_now timestamptz) RETURNS TABLE (einvoice_id uuid, company_id uuid, company text, number text, created_at timestamptz,
  status text, http_status int, warned text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.company_id, c.name, d.number, e.created_at, e.status, e.http_status,
         coalesce((SELECT array_agg(w.stage) FROM einvoice_warnings w WHERE w.einvoice_id = e.id), '{}')
  FROM einvoices e JOIN documents d ON d.id = e.document_id JOIN companies c ON c.id = e.company_id
  WHERE e.scheme = 'zatca' AND e.kind = 'simplified' AND c.status = 'active' AND app_user_id() IS NULL
    AND ((e.status = 'pending' AND (e.created_at <= p_now - interval '12 hours' OR e.http_status IN (401, 403)))
      OR (e.status = 'rejected' AND NOT EXISTS (SELECT 1 FROM einvoices x WHERE x.document_id = e.document_id AND x.status <> 'rejected')))
$$;
CREATE FUNCTION einvoice_warned(p_ids uuid[], p_stages text[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO einvoice_warnings (einvoice_id, stage) SELECT i, s FROM unnest(p_ids) i CROSS JOIN unnest(p_stages) s WHERE app_user_id() IS NULL
  ON CONFLICT DO NOTHING
$$;
/** Who is warned: the customer's Administrators, and the company's people who can enter sales. */
CREATE FUNCTION einvoice_warning_recipients(p_company uuid) RETURNS TABLE (name text, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT u.full_name, u.email FROM users u JOIN companies c ON c.id = p_company
  WHERE app_user_id() IS NULL AND u.status = 'active' AND (
        (u.kind = 'admin' AND u.firm_id = c.firm_id)
     OR EXISTS (SELECT 1 FROM memberships m LEFT JOIN client_roles r ON r.id = m.client_role_id
                WHERE m.user_id = u.id AND m.company_id = p_company
                  AND (m.role IN ('partner', 'staff_accountant') OR coalesce(r.permissions->>'Sales', '') = 'edit')))
$$;

/** The Administrator's list: unsent simplified e-invoices of the customer's companies. Only the invoice number,
 *  times, status, ZATCA's technical error and attempts: no amounts, customers or invoice contents. */
CREATE FUNCTION admin_einvoices_unsent() RETURNS TABLE (id uuid, company text, number text, issued_at timestamptz, hours_waiting int, status text,
  last_error text, attempts int, next_attempt_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_admin() THEN RAISE EXCEPTION 'Only the Administrator can do this.'; END IF;
  RETURN QUERY
  SELECT e.id, c.name, d.number, e.created_at, floor(extract(epoch FROM now() - e.created_at) / 3600)::int,
         CASE WHEN e.status = 'rejected' THEN 'rejected' WHEN e.attempts > 0 THEN 'retrying' ELSE 'waiting' END,
         left((SELECT string_agg(x, ' | ') FROM jsonb_array_elements_text(e.errors) x), 300), e.attempts,
         CASE WHEN e.status = 'pending' THEN e.next_attempt_at END
  FROM einvoices e JOIN documents d ON d.id = e.document_id JOIN companies c ON c.id = e.company_id
  WHERE c.firm_id = app_firm_id() AND e.scheme = 'zatca' AND e.kind = 'simplified'
    AND (e.status = 'pending' OR (e.status = 'rejected' AND NOT EXISTS (SELECT 1 FROM einvoices x WHERE x.document_id = e.document_id AND x.status <> 'rejected')))
  ORDER BY e.created_at;
END $$;

-- ---------------------------------------------------------------------------
-- Background jobs: when each last ran
-- ---------------------------------------------------------------------------
CREATE TABLE job_runs (
  job              text PRIMARY KEY,
  last_started_at  timestamptz,
  last_finished_at timestamptz,
  last_ok          boolean,
  last_error       text,
  runs             bigint NOT NULL DEFAULT 0
);
ALTER TABLE job_runs ENABLE ROW LEVEL SECURITY;   -- no policies: only the functions below
CREATE FUNCTION job_started(p_job text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO job_runs (job, last_started_at, runs) SELECT p_job, now(), 1 WHERE app_user_id() IS NULL
  ON CONFLICT (job) DO UPDATE SET last_started_at = now(), runs = job_runs.runs + 1
$$;
CREATE FUNCTION job_finished(p_job text, p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE job_runs SET last_finished_at = now(), last_ok = p_error IS NULL, last_error = left(p_error, 500) WHERE job = p_job AND app_user_id() IS NULL
$$;
/** For monitoring: when each job last ran (no customer data). */
CREATE FUNCTION job_status() RETURNS TABLE (job text, last_started_at timestamptz, last_finished_at timestamptz, last_ok boolean, last_error text, runs bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT job, last_started_at, last_finished_at, last_ok, last_error, runs FROM job_runs ORDER BY job
$$;

REVOKE ALL ON FUNCTION einvoices_to_send(timestamptz, boolean), einvoice_lease(uuid, uuid, int), einvoice_release(uuid, uuid), einvoice_warnings_due(timestamptz),
  einvoice_warned(uuid[], text[]), einvoice_warning_recipients(uuid), admin_einvoices_unsent(), job_started(text), job_finished(text, text), job_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION einvoices_to_send(timestamptz, boolean), einvoice_lease(uuid, uuid, int), einvoice_release(uuid, uuid), einvoice_warnings_due(timestamptz),
  einvoice_warned(uuid[], text[]), einvoice_warning_recipients(uuid), admin_einvoices_unsent(), job_started(text), job_finished(text, text), job_status() TO nusuh_app;
