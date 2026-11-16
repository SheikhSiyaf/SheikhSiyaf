-- 0054 Renewing an e-invoicing device's certificate, and a warning before it expires.
--
-- 1. Renewal: ZATCA issues a new certificate for a new key on the SAME device, so the invoice counter and the hash of
--    the last invoice carry on unbroken. Until now a device could never change its key. Now the key and CSR change only
--    together with a new certificate, on an active device that stays active, and only when no e-invoice signed with
--    the old key is still waiting to be sent. The environment, company and serial number never change.
--    renewed_at records it.
-- 2. Warning: cert_warned_for remembers which expiry date the Administrators were emailed about, so each certificate
--    is warned about once, 30 days ahead. People cannot set either column.

ALTER TABLE einvoice_devices ADD COLUMN renewed_at timestamptz, ADD COLUMN cert_warned_for timestamptz;

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
    IF EXISTS (SELECT 1 FROM einvoices e WHERE e.device_id = OLD.id AND e.status = 'pending') THEN
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

/** For the background job only: active devices whose certificate ends within 30 days (or has ended) and whose
 *  Administrators have not been told about this expiry date yet. */
CREATE FUNCTION einvoice_cert_warnings_due(p_now timestamptz)
RETURNS TABLE (device_id uuid, company_id uuid, company text, device text, environment text, cert_valid_to timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, d.company_id, c.name, d.name, d.environment, d.cert_valid_to
  FROM einvoice_devices d JOIN companies c ON c.id = d.company_id
  WHERE app_user_id() IS NULL AND d.status = 'active' AND c.status = 'active' AND d.private_key_enc <> '' AND d.production_token IS NOT NULL
    AND d.cert_valid_to IS NOT NULL AND d.cert_valid_to <= p_now + interval '30 days'
    AND d.cert_warned_for IS DISTINCT FROM d.cert_valid_to
$$;

CREATE FUNCTION einvoice_cert_warned(p_device uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  UPDATE einvoice_devices SET cert_warned_for = cert_valid_to WHERE id = p_device;
END $$;
