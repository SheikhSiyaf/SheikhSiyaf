-- 0052 The other automatic jobs keep working when the person who set them up leaves.
--
-- Found in the batch 1 sweep: recurring invoices, payment reminders and bank feed syncs ran only while the person who
-- set them up was active (they stopped without a word when that person was suspended or left), and the month-end
-- exchange-rate revaluation ran as that person and failed. Like the ZATCA sender (0051), they now run as the
-- automatic sender, for one company and one job at a time, and only while the job is switched on there:
--   'recurring' (an active recurring invoice): makes and issues the invoice (documents, lines, the sales entry, its
--               e-invoice) and moves the schedule on;
--   'reminders' (automatic reminders on): emails reminders (no change to the books);
--   'fx'        (automatic revaluation on): posts the month-end revaluation entry, adding the exchange gains and
--               losses accounts when they are missing;
--   'bank_feed' (a connected feed): imports the bank lines and books those a bank rule matches.
-- Who set each one up is still recorded (created_by, enabled_by); what the job does is audited under the automatic
-- sender. Nothing else is allowed (before_system_write).

CREATE OR REPLACE FUNCTION app_system_company() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v text := nullif(current_setting('app.system_company', true), ''); job text := current_setting('app.system_job', true); cid uuid;
BEGIN
  IF v IS NULL OR v !~ '^[0-9a-fA-F-]{36}$' OR app_user_id() IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = app_user_id() AND kind = 'system' AND status = 'active') THEN RETURN NULL; END IF;
  SELECT c.id INTO cid FROM companies c WHERE c.id = v::uuid AND c.status = 'active' AND (
       (job = 'einvoice' AND EXISTS (SELECT 1 FROM einvoice_devices d WHERE d.company_id = c.id AND d.status IN ('active', 'retired')))
    OR (job = 'online_payment' AND EXISTS (SELECT 1 FROM payment_settings s WHERE s.company_id = c.id AND s.enabled))
    OR (job = 'recurring' AND EXISTS (SELECT 1 FROM recurring_invoices r WHERE r.company_id = c.id AND r.active))
    OR (job = 'reminders' AND EXISTS (SELECT 1 FROM reminder_settings s WHERE s.company_id = c.id AND s.auto))
    OR (job = 'fx' AND EXISTS (SELECT 1 FROM fx_settings s WHERE s.company_id = c.id AND s.auto_revalue))
    OR (job = 'bank_feed' AND EXISTS (SELECT 1 FROM bank_feeds f WHERE f.company_id = c.id AND f.status IN ('active', 'error'))));
  RETURN cid;
END $$;

CREATE OR REPLACE FUNCTION before_system_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE job text := current_setting('app.system_job', true); src text;
BEGIN
  IF app_user_id() IS NULL OR app_user_id() IS DISTINCT FROM system_user_id() THEN RETURN coalesce(NEW, OLD); END IF;
  IF TG_TABLE_NAME = 'journal_entries' AND TG_OP = 'INSERT' THEN src := NEW.source_type; END IF;
  IF job = 'einvoice' AND TG_TABLE_NAME = 'einvoices' AND TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
  IF job = 'online_payment' AND TG_OP = 'INSERT' AND (TG_TABLE_NAME IN ('payments', 'payment_allocations') OR src = 'payment_received') THEN RETURN NEW; END IF;
  IF job = 'recurring' AND (TG_TABLE_NAME IN ('documents', 'document_lines') AND TG_OP IN ('INSERT', 'UPDATE')
       OR TG_TABLE_NAME = 'einvoices' AND TG_OP = 'INSERT' OR TG_TABLE_NAME = 'einvoice_devices' AND TG_OP = 'UPDATE' OR src = 'invoice') THEN RETURN NEW; END IF;
  IF job = 'fx' AND (src = 'fx_revaluation' OR TG_TABLE_NAME = 'accounts' AND TG_OP = 'INSERT') THEN RETURN NEW; END IF;
  IF job = 'bank_feed' AND src = 'bank' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'The automatic sender only records ZATCA''s answers and online payments.';
END $$;

-- The jobs no longer depend on the person who set them up being active.
CREATE OR REPLACE FUNCTION recurring_invoices_due(p_day date) RETURNS TABLE (id uuid, company_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.company_id, system_user_id() FROM recurring_invoices r JOIN companies c ON c.id = r.company_id
  WHERE r.active AND r.next_date <= p_day AND (r.end_date IS NULL OR r.next_date <= r.end_date) AND c.status = 'active'
    AND app_user_id() IS NULL
$$;
CREATE OR REPLACE FUNCTION reminders_auto() RETURNS TABLE (company_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.company_id, system_user_id() FROM reminder_settings s JOIN companies c ON c.id = s.company_id
  WHERE s.auto AND c.status = 'active' AND app_user_id() IS NULL
$$;
CREATE OR REPLACE FUNCTION bank_feeds_due(p_hours int) RETURNS TABLE (id uuid, company_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT f.id, f.company_id, system_user_id() FROM bank_feeds f JOIN companies c ON c.id = f.company_id
  WHERE f.status IN ('active', 'error') AND (f.last_sync_at IS NULL OR f.last_sync_at < now() - make_interval(hours => p_hours))
    AND c.status = 'active' AND app_user_id() IS NULL
$$;
