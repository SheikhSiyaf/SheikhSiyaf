-- 0057: getting out of an expired ZATCA certificate.
--
-- 0054 added renewal, and refused it while e-invoices signed with the old key were still waiting: those invoices
-- must reach ZATCA before the key they were signed with is replaced. That is right while the certificate works.
--
-- It is a trap once the certificate has run out. ZATCA then refuses the login, so a waiting invoice can NEVER be
-- sent with that key; and because invoices are waiting, the certificate can never be renewed. The company could
-- neither send nor renew, and nothing could be invoiced again: there was no way out from inside the app.
--
-- So: when the certificate has expired, or ZATCA is refusing the login (401 or 403) on everything that waits,
-- renewal is allowed with invoices still waiting. The application then RE-SIGNS each waiting invoice with the new
-- certificate. Re-signing is safe for the chain because the invoice hash is taken over the invoice WITHOUT its
-- signature and QR, so the hash, the counter and the previous-invoice hash all stay exactly as they were: only the
-- signature, the certificate carried in it and the QR change, which is precisely what has to change.

ALTER TABLE einvoices ADD COLUMN resigned_at timestamptz;

COMMENT ON COLUMN einvoices.resigned_at IS
  'Signed again with a renewed certificate after the old one expired. The invoice itself is unchanged: same hash, same counter, same previous-invoice hash.';

/** True when a device's waiting invoices cannot be sent with its current key: the certificate has run out, or
 *  ZATCA refuses the login on every one of them. */
CREATE FUNCTION einvoice_device_locked_out(p_device uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM einvoice_devices d WHERE d.id = p_device AND d.cert_valid_to IS NOT NULL AND d.cert_valid_to <= now())
     OR (EXISTS (SELECT 1 FROM einvoices e WHERE e.device_id = p_device AND e.status = 'pending')
         AND NOT EXISTS (SELECT 1 FROM einvoices e WHERE e.device_id = p_device AND e.status = 'pending'
                           AND (e.http_status IS NULL OR e.http_status NOT IN (401, 403))))
$$;

-- ---------------------------------------------------------------------------
-- The device: renewal may go ahead with invoices waiting, but only when they are locked out.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_einvoice_device_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now(); NEW.icv := 0; NEW.status := 'compliance'; NEW.activated_at := NULL;
    NEW.renewed_at := NULL; NEW.cert_warned_for := NULL;
    NEW.last_hash := 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';
    RETURN NEW;
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.environment <> OLD.environment OR NEW.serial <> OLD.serial THEN
    RAISE EXCEPTION 'A device keeps its key and environment. Connect a new device instead.';
  END IF;
  NEW.renewed_at := OLD.renewed_at;
  IF app_user_id() IS NOT NULL THEN NEW.cert_warned_for := OLD.cert_warned_for; END IF;
  IF NEW.private_key_enc <> OLD.private_key_enc OR NEW.csr <> OLD.csr THEN
    -- Only a renewal changes the key: new key, new CSR and new certificate together, active before and after.
    IF NOT (OLD.status = 'active' AND NEW.status = 'active' AND NEW.private_key_enc <> OLD.private_key_enc AND NEW.csr <> OLD.csr
            AND NEW.production_token IS DISTINCT FROM OLD.production_token AND NEW.production_token IS NOT NULL) THEN
      RAISE EXCEPTION 'A device keeps its key and environment. Connect a new device instead.';
    END IF;
    -- Waiting invoices must be sent first, UNLESS they cannot be sent at all with this key (0057).
    IF EXISTS (SELECT 1 FROM einvoices e WHERE e.device_id = OLD.id AND e.status = 'pending')
       AND NOT einvoice_device_locked_out(OLD.id) THEN
      RAISE EXCEPTION 'Send the e-invoices that are waiting before renewing the certificate.';
    END IF;
    NEW.renewed_at := now(); NEW.cert_warned_for := NULL;   -- the new certificate gets its own warning
  END IF;
  -- The chain moves only when an e-invoice is made (inside the e-invoice rule above).
  IF (NEW.icv, NEW.last_hash) IS DISTINCT FROM (OLD.icv, OLD.last_hash) AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'The invoice counter moves only when an e-invoice is made.';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN RAISE EXCEPTION 'A retired device stays retired. Connect a new device instead.'; END IF;
  IF NEW.status = 'active' AND OLD.status <> 'active' THEN NEW.activated_at := now(); END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- The e-invoice: the signature and the QR may be redone while it still waits; the invoice itself never changes.
-- ---------------------------------------------------------------------------
-- Based on the version in 0043_einvoice_sender.sql (the one in force), with only the re-sign branch added.
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
    NEW.resigned_at := NULL;
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
  -- Signing again after the certificate was renewed (0057): the signature, the certificate carried inside it and
  -- the QR are redone, and nothing else may move. The invoice hash stays, and that hash is what holds the chain
  -- together, so the invoice itself provably cannot be changed under cover of a re-sign.
  IF NEW.resigned_at IS DISTINCT FROM OLD.resigned_at THEN
    IF OLD.status <> 'pending' THEN
      RAISE EXCEPTION 'The authority has answered for this e-invoice; it is final.';
    END IF;
    IF (to_jsonb(NEW) - 'xml' - 'qr' - 'resigned_at') <> (to_jsonb(OLD) - 'xml' - 'qr' - 'resigned_at') THEN
      RAISE EXCEPTION 'An e-invoice is never changed. Only the authority''s answer is recorded.';
    END IF;
    NEW.resigned_at := now();
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

GRANT EXECUTE ON FUNCTION einvoice_device_locked_out(uuid) TO nusuh_app;
REVOKE ALL ON FUNCTION einvoice_device_locked_out(uuid) FROM PUBLIC;
