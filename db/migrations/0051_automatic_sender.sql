-- 0051 The automatic sender, and standard invoices ZATCA could not clear at once.
--
-- A. The ZATCA sender and the online-payment confirmation no longer work as the person who connected the device or
--    switched online payments on (they stopped when that person was suspended or left). They work as one built-in
--    account, "Nusuh Books automatic sender":
--      * it cannot sign in (it never has a password or two-factor secret) and is never a member of a company;
--      * it acts for one company and one job per transaction (app.system_company, app.system_job), and only while
--        the job is allowed there: 'einvoice' while the company is active and has a connected (or retired) device,
--        'online_payment' while the company is active and has online payments on;
--      * in the 'einvoice' job it writes nothing but ZATCA's answers on e-invoices; in the 'online_payment' job it
--        posts nothing but customer receipts; it never creates or changes documents, contacts, accounts or periods;
--      * every write is in the audit log under it; the device keeps who connected it and payments who switched them on.
-- B. Standard (business) invoices ZATCA could not clear at once (ZATCA, Detailed Guidelines for E-Invoicing,
--    version 2, May 2023, pages 45-47): the sender retries them like simplified ones; Administrators are warned at 1,
--    4 and 24 hours; the customer's invoice page says when an invoice is not cleared by ZATCA yet, and prints ZATCA's
--    QR code from the cleared invoice once there is one.

-- ---------------------------------------------------------------------------------------------- the account
CREATE OR REPLACE FUNCTION before_user_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE k text;
BEGIN
  SELECT kind INTO k FROM firms WHERE id = NEW.firm_id;
  IF (NEW.kind IN ('owner', 'system')) <> (k = 'platform') THEN RAISE EXCEPTION 'The platform owner and the platform go together.'; END IF;
  IF NEW.kind = 'firm_staff' AND k = 'company' THEN
    RAISE EXCEPTION 'A company runs its own books: add its people as company users with a role.';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.firm_id <> OLD.firm_id OR NEW.kind <> OLD.kind) THEN RAISE EXCEPTION 'A person keeps their organisation and kind.'; END IF;
  IF NEW.kind = 'system' AND (NEW.password_hash IS NOT NULL OR NEW.totp_secret_enc IS NOT NULL) THEN
    RAISE EXCEPTION 'The automatic sender never signs in.';
  END IF;
  RETURN NEW;
END $$;

CREATE UNIQUE INDEX users_one_system ON users (kind) WHERE kind = 'system';
INSERT INTO users (firm_id, kind, full_name, email)
SELECT id, 'system', 'Nusuh Books automatic sender', 'automatic-sender@nusuhbooks.invalid' FROM firms WHERE kind = 'platform' ORDER BY id LIMIT 1;

CREATE FUNCTION system_user_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM users WHERE kind = 'system'
$$;

CREATE FUNCTION before_membership_system() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.user_id = system_user_id() THEN RAISE EXCEPTION 'The automatic sender is never a member of a company.'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_no_system BEFORE INSERT OR UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION before_membership_system();

/** The company the automatic sender works for in this transaction, when the job is allowed there now. */
CREATE FUNCTION app_system_company() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v text := nullif(current_setting('app.system_company', true), ''); job text := current_setting('app.system_job', true); cid uuid;
BEGIN
  IF v IS NULL OR v !~ '^[0-9a-fA-F-]{36}$' OR app_user_id() IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = app_user_id() AND kind = 'system' AND status = 'active') THEN RETURN NULL; END IF;
  SELECT c.id INTO cid FROM companies c WHERE c.id = v::uuid AND c.status = 'active' AND (
       (job = 'einvoice' AND EXISTS (SELECT 1 FROM einvoice_devices d WHERE d.company_id = c.id AND d.status IN ('active', 'retired')))
    OR (job = 'online_payment' AND EXISTS (SELECT 1 FROM payment_settings s WHERE s.company_id = c.id AND s.enabled)));
  RETURN cid;
END $$;

CREATE OR REPLACE FUNCTION app_company_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(x), '{}') FROM (
    SELECT m.company_id AS x
    FROM memberships m
    JOIN users u ON u.id = m.user_id AND u.status = 'active' AND u.kind <> 'system'
    JOIN companies c ON c.id = m.company_id AND c.status = 'active'
    WHERE m.user_id = app_user_id()
    UNION
    SELECT app_system_company() WHERE app_system_company() IS NOT NULL) q
$$;

-- The automatic sender counts as a staff accountant of its company for the job, nothing more (the guards below).
CREATE OR REPLACE FUNCTION app_has_role(p_company uuid, p_roles user_role[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships m
    JOIN users u ON u.id = m.user_id AND u.status = 'active' AND u.kind <> 'system'
    JOIN companies c ON c.id = m.company_id AND c.status = 'active'
    WHERE m.user_id = app_user_id() AND m.company_id = p_company AND m.role = ANY (p_roles))
  OR coalesce(p_company = app_system_company() AND 'staff_accountant' = ANY (p_roles), false)   -- never NULL: callers test it with IF / NOT
$$;

-- What the automatic sender may write, per job.
CREATE FUNCTION before_system_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE job text := current_setting('app.system_job', true);
BEGIN
  IF app_user_id() IS NULL OR app_user_id() IS DISTINCT FROM system_user_id() THEN RETURN coalesce(NEW, OLD); END IF;
  IF TG_TABLE_NAME = 'einvoices' AND TG_OP = 'UPDATE' AND job = 'einvoice' THEN RETURN NEW; END IF;
  IF job = 'online_payment' AND TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME IN ('payments', 'payment_allocations') THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME = 'journal_entries' THEN
      IF NEW.source_type = 'payment_received' THEN RETURN NEW; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'The automatic sender only records ZATCA''s answers and online payments.';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['journal_entries', 'documents', 'document_lines', 'contacts', 'accounts', 'periods', 'payments', 'payment_allocations',
                           'einvoices', 'einvoice_devices', 'einvoice_settings', 'payment_settings', 'memberships', 'users', 'review_signoffs', 'fiscal_years'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION before_system_write()', t || '_system_guard', t);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION system_user_id(), app_system_company() TO nusuh_app;

-- ---------------------------------------------------------------------------------------------- the sender
-- Every waiting e-invoice of a connected device, standard ones too; it no longer matters who connected the device.
CREATE OR REPLACE FUNCTION einvoices_to_send(p_now timestamptz, p_all boolean) RETURNS TABLE (device_id uuid, company_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT d.id, d.company_id, system_user_id() FROM einvoices e JOIN einvoice_devices d ON d.id = e.device_id
    JOIN companies c ON c.id = d.company_id
  WHERE e.status = 'pending' AND e.scheme = 'zatca' AND (p_all OR e.next_attempt_at <= p_now)
    AND d.status IN ('active', 'retired') AND c.status = 'active' AND app_user_id() IS NULL
$$;

-- Online payments are recorded by the automatic sender; the settings keep who switched them on.
CREATE OR REPLACE FUNCTION online_pay_get(p_id uuid, p_ref text DEFAULT NULL)
RETURNS TABLE (id uuid, company_id uuid, document_id uuid, contact_id uuid, amount text, currency text, provider text, provider_ref text, status text,
               secret_enc text, deposit_account_id uuid, run_as uuid, number text, seller text, link_token_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id, o.company_id, o.document_id, d.contact_id, o.amount::text, o.currency::text, o.provider, o.provider_ref, o.status,
         s.secret_enc, s.deposit_account_id, CASE WHEN s.enabled THEN system_user_id() END, d.number, c.name, k.token_hash
  FROM online_payments o JOIN documents d ON d.id = o.document_id JOIN companies c ON c.id = o.company_id
  LEFT JOIN payment_settings s ON s.company_id = o.company_id LEFT JOIN document_links k ON k.token_hash = o.link_hash
  WHERE app_user_id() IS NULL AND (o.id = p_id OR (p_ref IS NOT NULL AND o.provider_ref = p_ref))
$$;

-- Warnings: standard invoices not cleared after 1, 4 and 24 hours (c1, c4, c24); simplified as before.
ALTER TABLE einvoice_warnings DROP CONSTRAINT einvoice_warnings_stage_check;
ALTER TABLE einvoice_warnings ADD CONSTRAINT einvoice_warnings_stage_check CHECK (stage IN ('h12', 'h20', 'h24', 'c1', 'c4', 'c24', 'rejected', 'login'));
DROP FUNCTION einvoice_warnings_due(timestamptz);
CREATE FUNCTION einvoice_warnings_due(p_now timestamptz) RETURNS TABLE (einvoice_id uuid, company_id uuid, company text, number text, created_at timestamptz,
  status text, http_status int, warned text[], kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.company_id, c.name, d.number, e.created_at, e.status, e.http_status,
         coalesce((SELECT array_agg(w.stage) FROM einvoice_warnings w WHERE w.einvoice_id = e.id), '{}'), e.kind
  FROM einvoices e JOIN documents d ON d.id = e.document_id JOIN companies c ON c.id = e.company_id
  WHERE e.scheme = 'zatca' AND c.status = 'active' AND app_user_id() IS NULL
    AND ((e.status = 'pending' AND (e.created_at <= p_now - CASE e.kind WHEN 'standard' THEN interval '1 hour' ELSE interval '12 hours' END OR e.http_status IN (401, 403)))
      OR (e.status = 'rejected' AND NOT EXISTS (SELECT 1 FROM einvoices x WHERE x.document_id = e.document_id AND x.status <> 'rejected')))
$$;
REVOKE ALL ON FUNCTION einvoice_warnings_due(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION einvoice_warnings_due(timestamptz) TO nusuh_app;

-- ---------------------------------------------------------------------------------------------- the customer's page
CREATE OR REPLACE FUNCTION document_public(p_token_hash text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', d.id, 'type', d.type, 'status', d.status, 'issuedAt', d.issued_at, 'number', d.number, 'issueDate', d.issue_date, 'dueDate', d.due_date, 'reference', d.reference, 'notes', d.notes,
    'netTotal', d.net_total::text, 'vatTotal', d.vat_total::text, 'grossTotal', d.gross_total::text, 'amountDue', document_amount_due(d.id)::numeric(18,2)::text,
    'seller', jsonb_build_object('name', co.name, 'nameAr', co.name_ar, 'vatNumber', co.vat_number, 'crNumber', co.cr_number, 'address', co.address, 'city', co.city,
       'country', co.country, 'currency', co.currency),
    'buyer', jsonb_build_object('name', c.name, 'nameAr', c.name_ar, 'vatNumber', c.vat_number, 'address', c.address, 'city', c.city),
    -- ZATCA's QR from the cleared invoice (standard), else our own stamp's (simplified).
    'qr', (SELECT coalesce(substring(e.cleared_xml from '<cbc:ID>QR</cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject[^>]*>([^<]+)<'), e.qr)
           FROM einvoices e WHERE e.document_id = d.id ORDER BY e.created_at DESC LIMIT 1),
    'notCleared', coalesce((SELECT e.kind = 'standard' AND e.status = 'pending' FROM einvoices e WHERE e.document_id = d.id AND e.scheme = 'zatca'
                            ORDER BY e.created_at DESC LIMIT 1), false),
    'payOnline', d.type IN ('invoice', 'debit_note') AND d.status = 'issued' AND document_amount_due(d.id) > 0
       AND EXISTS (SELECT 1 FROM payment_settings s WHERE s.company_id = d.company_id AND s.enabled),
    'lines', (SELECT jsonb_agg(jsonb_build_object('description', l.description, 'quantity', l.quantity::text, 'unitPrice', l.unit_price::text, 'vatRate', l.vat_rate::text,
       'netAmount', l.net_amount::text, 'vatAmount', l.vat_amount::text) ORDER BY l.line_no) FROM document_lines l WHERE l.document_id = d.id))
  FROM document_links k JOIN documents d ON d.id = k.document_id JOIN companies co ON co.id = d.company_id JOIN contacts c ON c.id = d.contact_id
  WHERE k.token_hash = p_token_hash AND k.revoked_at IS NULL AND k.expires_at > now()
$$;
