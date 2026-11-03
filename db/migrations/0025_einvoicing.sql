-- 0025: E-invoicing (build step 4). The invoice data stays the same for every country; each country's e-invoicing
-- is an adapter (src/einvoice): ZATCA phase 2 for Saudi Arabia, Peppol PINT AE (through an accredited service
-- provider) for the UAE.
--   * einvoice_settings: per company, turned on by the books team; the seller's national address and the reasons
--     used for zero-rated, exempt and out-of-scope lines.
--   * einvoice_devices: ZATCA "EGS units": the device key (encrypted by the application), its certificates
--     (CSIDs) and its invoice chain: the counter (ICV) and the hash of the last invoice (PIH).
--   * einvoices: what was produced for an issued invoice or credit note: the XML, its hash and QR, and what the
--     authority answered. Never deleted; the XML and its place in the chain never change.

CREATE TABLE einvoice_settings (
  company_id          uuid PRIMARY KEY REFERENCES companies(id),
  enabled             boolean NOT NULL DEFAULT false,
  street              text,
  building_number     text CHECK (building_number ~ '^[0-9]{4}$'),
  district            text,
  postal_code         text CHECK (postal_code ~ '^[0-9]{5}$'),
  zero_reason_code    text NOT NULL DEFAULT 'VATEX-SA-32',
  zero_reason         text NOT NULL DEFAULT 'Export of goods',
  exempt_reason_code  text NOT NULL DEFAULT 'VATEX-SA-29',
  exempt_reason       text NOT NULL DEFAULT 'Financial services mentioned in Article 29 of the VAT Regulations',
  oos_reason          text NOT NULL DEFAULT 'Not subject to VAT',
  updated_by          uuid REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Buyers' national address (ZATCA needs it on standard tax invoices to Saudi businesses).
ALTER TABLE contacts
  ADD COLUMN building_number text CONSTRAINT contact_building_number CHECK (building_number ~ '^[0-9]{4}$'),
  ADD COLUMN district text,
  ADD COLUMN postal_code text CONSTRAINT contact_postal_code CHECK (postal_code ~ '^[0-9]{5}$');

CREATE TABLE einvoice_devices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),
  environment           text NOT NULL CHECK (environment IN ('sandbox', 'simulation', 'production')),
  name                  text NOT NULL CHECK (btrim(name) <> ''),
  serial                text NOT NULL,
  branch                text NOT NULL,
  invoice_types         text NOT NULL DEFAULT '1100' CHECK (invoice_types IN ('1100', '1000', '0100')),
  status                text NOT NULL DEFAULT 'compliance' CHECK (status IN ('compliance', 'checks_failed', 'checks_passed', 'active', 'retired')),
  private_key_enc       text NOT NULL,
  csr                   text NOT NULL,
  compliance_request_id text,
  compliance_token      text,
  compliance_secret_enc text,
  production_token      text,
  production_secret_enc text,
  cert_valid_to         timestamptz,
  checks                jsonb NOT NULL DEFAULT '[]',
  icv                   bigint NOT NULL DEFAULT 0 CHECK (icv >= 0),
  last_hash             text NOT NULL DEFAULT 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==',
  created_by            uuid NOT NULL REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  activated_at          timestamptz,
  CHECK (status <> 'active' OR (production_token IS NOT NULL AND production_secret_enc IS NOT NULL))
);
CREATE UNIQUE INDEX einvoice_devices_one_active ON einvoice_devices (company_id) WHERE status = 'active';

CREATE TABLE einvoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  document_id   uuid NOT NULL REFERENCES documents(id),
  scheme        text NOT NULL CHECK (scheme IN ('zatca', 'pint_ae')),
  device_id     uuid REFERENCES einvoice_devices(id),
  kind          text NOT NULL CHECK (kind IN ('standard', 'simplified')),
  uuid          uuid NOT NULL UNIQUE,
  icv           bigint,
  pih           text,
  invoice_hash  text,
  xml           text NOT NULL,
  qr            text,
  status        text NOT NULL CHECK (status IN ('pending', 'cleared', 'reported', 'rejected', 'ready')),
  cleared_xml   text,
  warnings      jsonb NOT NULL DEFAULT '[]',
  errors        jsonb NOT NULL DEFAULT '[]',
  http_status   int,
  attempts      int NOT NULL DEFAULT 0,
  submitted_at  timestamptz,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((scheme = 'zatca') = (device_id IS NOT NULL AND icv IS NOT NULL AND pih IS NOT NULL AND invoice_hash IS NOT NULL)),
  CHECK (scheme = 'zatca' OR status = 'ready')
);
-- One e-invoice per issued document, unless an earlier one was rejected and the invoice was sent again.
CREATE UNIQUE INDEX einvoices_one_per_document ON einvoices (document_id) WHERE status <> 'rejected';
CREATE INDEX einvoices_company ON einvoices (company_id, status, created_at);
CREATE UNIQUE INDEX einvoices_chain ON einvoices (device_id, icv) WHERE device_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------
CREATE FUNCTION before_einvoice_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE dev einvoice_devices%ROWTYPE; doc documents%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO doc FROM documents WHERE id = NEW.document_id;
    IF doc.id IS NULL OR doc.company_id <> NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
    IF doc.status <> 'issued' OR doc.type NOT IN ('invoice', 'credit_note') THEN RAISE EXCEPTION 'Only issued invoices and credit notes are e-invoiced.'; END IF;
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now(); NEW.attempts := 0; NEW.submitted_at := NULL; NEW.cleared_xml := NULL; NEW.http_status := NULL;
    IF NEW.scheme = 'zatca' THEN
      -- The chain: each invoice takes the device's next counter and the hash of the one before.
      SELECT * INTO dev FROM einvoice_devices WHERE id = NEW.device_id FOR UPDATE;
      IF dev.id IS NULL OR dev.company_id <> NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
      IF dev.status <> 'active' THEN RAISE EXCEPTION 'This e-invoicing device is not active.'; END IF;
      IF NEW.icv <> dev.icv + 1 OR NEW.pih <> dev.last_hash THEN RAISE EXCEPTION 'The e-invoice chain moved on; prepare the invoice again.'; END IF;
      NEW.status := 'pending';
      UPDATE einvoice_devices SET icv = NEW.icv, last_hash = NEW.invoice_hash WHERE id = dev.id;
    ELSE
      NEW.status := 'ready';
    END IF;
    RETURN NEW;
  END IF;
  -- Only the authority's answer changes; a cleared or reported invoice is final.
  IF (to_jsonb(NEW) - 'status' - 'cleared_xml' - 'warnings' - 'errors' - 'http_status' - 'attempts' - 'submitted_at')
     <> (to_jsonb(OLD) - 'status' - 'cleared_xml' - 'warnings' - 'errors' - 'http_status' - 'attempts' - 'submitted_at') THEN
    RAISE EXCEPTION 'An e-invoice is never changed. Only the authority''s answer is recorded.';
  END IF;
  IF OLD.status IN ('cleared', 'reported', 'rejected') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'The authority has answered for this e-invoice; it is final.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER einvoices_before_change BEFORE INSERT OR UPDATE ON einvoices FOR EACH ROW EXECUTE FUNCTION before_einvoice_change();
CREATE TRIGGER einvoices_no_delete BEFORE DELETE ON einvoices FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION before_einvoice_device_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now(); NEW.icv := 0; NEW.status := 'compliance'; NEW.activated_at := NULL;
    NEW.last_hash := 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';
    RETURN NEW;
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.private_key_enc <> OLD.private_key_enc OR NEW.environment <> OLD.environment OR NEW.csr <> OLD.csr THEN
    RAISE EXCEPTION 'A device keeps its key and environment. Connect a new device instead.';
  END IF;
  -- The chain moves only when an e-invoice is made (inside the e-invoice rule above).
  IF (NEW.icv, NEW.last_hash) IS DISTINCT FROM (OLD.icv, OLD.last_hash) AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'The invoice counter moves only when an e-invoice is made.';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN RAISE EXCEPTION 'A retired device stays retired. Connect a new device instead.'; END IF;
  IF NEW.status = 'active' AND OLD.status <> 'active' THEN NEW.activated_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER einvoice_devices_before_change BEFORE INSERT OR UPDATE ON einvoice_devices FOR EACH ROW EXECUTE FUNCTION before_einvoice_device_change();
CREATE TRIGGER einvoice_devices_no_delete BEFORE DELETE ON einvoice_devices FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION before_einvoice_settings_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.company_id <> OLD.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  NEW.updated_by := coalesce(app_user_id(), NEW.updated_by); NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER einvoice_settings_before_change BEFORE INSERT OR UPDATE ON einvoice_settings FOR EACH ROW EXECUTE FUNCTION before_einvoice_settings_change();

-- ---------------------------------------------------------------------------
-- Audit and row-level security: everyone on the company reads; those who post invoices make and send them.
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['einvoice_settings', 'einvoice_devices', 'einvoices'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_update', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nusuh_app', t);
  END LOOP;
END $$;
