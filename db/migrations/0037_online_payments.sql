-- 0037 Online payment of invoices. The customer opens the invoice link (emailed, or from the statement and reminders)
-- and pays by card, mada or Apple Pay through the company's payment provider. When the provider confirms (its
-- webhook, or the customer coming back), the payment is recorded against the invoice into the account the company
-- chose (the provider's settlement account), as the person who turned online payments on.
--
-- payment_settings: per company: on or off, provider (sandbox for trying it out, or Moyasar), keys (the secret key
--   encrypted by the server), the account the money lands in.
-- online_payments: each checkout started from a link: amount due at the time, provider reference, created, paid or
--   failed, and the payment recorded. Written only through the functions below.

CREATE TABLE payment_settings (
  company_id          uuid PRIMARY KEY REFERENCES companies(id),
  enabled             boolean NOT NULL DEFAULT false,
  provider            text NOT NULL DEFAULT 'sandbox' CHECK (provider IN ('sandbox', 'moyasar')),
  publishable_key     text,
  secret_enc          text,
  deposit_account_id  uuid REFERENCES accounts(id),
  enabled_by          uuid REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION before_payment_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.deposit_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.deposit_account_id AND company_id = NEW.company_id AND is_bank) THEN
    RAISE EXCEPTION 'Choose one of this company''s bank or cash accounts for online payments.';
  END IF;
  IF NEW.enabled AND (NEW.deposit_account_id IS NULL OR (NEW.provider <> 'sandbox' AND NEW.secret_enc IS NULL)) THEN
    RAISE EXCEPTION 'Choose the account the money lands in, and enter the provider''s secret key, before turning online payments on.';
  END IF;
  IF app_user_id() IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.enabled IS DISTINCT FROM OLD.enabled) THEN
    NEW.enabled_by := CASE WHEN NEW.enabled THEN app_user_id() END;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER payment_settings_before_change BEFORE INSERT OR UPDATE ON payment_settings FOR EACH ROW EXECUTE FUNCTION before_payment_settings();

CREATE TABLE online_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  document_id   uuid NOT NULL REFERENCES documents(id),
  link_hash     text REFERENCES document_links(token_hash),
  amount        numeric(18,2) NOT NULL CHECK (amount > 0),
  currency      char(3) NOT NULL,
  provider      text NOT NULL,
  provider_ref  text,
  checkout_url  text,
  status        text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed')),
  payment_id    uuid REFERENCES payments(id),
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  paid_at       timestamptz,
  CHECK ((status = 'paid') = (payment_id IS NOT NULL))
);
CREATE UNIQUE INDEX online_payments_ref ON online_payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX online_payments_doc ON online_payments (document_id, created_at DESC);
CREATE TRIGGER online_payments_no_delete BEFORE DELETE ON online_payments FOR EACH ROW EXECUTE FUNCTION forbid_change();

/** Public (nobody signed in): starts a checkout for what is due on the invoice behind a link. */
CREATE FUNCTION online_pay_start(p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d documents; k document_links; st payment_settings; due numeric; cur char(3); nid uuid;
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  SELECT * INTO k FROM document_links WHERE token_hash = p_token_hash AND revoked_at IS NULL AND expires_at > now();
  SELECT * INTO d FROM documents WHERE id = k.document_id;
  IF d.id IS NULL OR d.type NOT IN ('invoice', 'debit_note') OR d.status <> 'issued' THEN RAISE EXCEPTION 'This invoice cannot be paid online.'; END IF;
  SELECT * INTO st FROM payment_settings WHERE company_id = d.company_id;
  IF st.company_id IS NULL OR NOT st.enabled THEN RAISE EXCEPTION 'This invoice cannot be paid online.'; END IF;
  due := document_amount_due(d.id);
  IF due <= 0 THEN RAISE EXCEPTION 'Nothing is left to pay on this invoice.'; END IF;
  SELECT currency INTO cur FROM companies WHERE id = d.company_id;
  INSERT INTO online_payments (company_id, document_id, link_hash, amount, currency, provider) VALUES (d.company_id, d.id, k.token_hash, due, cur, st.provider) RETURNING id INTO nid;
  RETURN jsonb_build_object('id', nid, 'amount', due::numeric(18,2)::text, 'currency', cur, 'provider', st.provider, 'secretEnc', st.secret_enc,
    'number', d.number, 'seller', (SELECT name FROM companies WHERE id = d.company_id));
END $$;

/** Server only: the provider's checkout for a payment. */
CREATE FUNCTION online_pay_checkout(p_id uuid, p_ref text, p_url text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  UPDATE online_payments SET provider_ref = p_ref, checkout_url = p_url WHERE id = p_id AND status = 'created';
END $$;

/** Server only: what is needed to check a payment with the provider and record it. */
CREATE FUNCTION online_pay_get(p_id uuid, p_ref text DEFAULT NULL)
RETURNS TABLE (id uuid, company_id uuid, document_id uuid, contact_id uuid, amount text, currency text, provider text, provider_ref text, status text,
               secret_enc text, deposit_account_id uuid, run_as uuid, number text, seller text, link_token_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id, o.company_id, o.document_id, d.contact_id, o.amount::text, o.currency::text, o.provider, o.provider_ref, o.status,
         s.secret_enc, s.deposit_account_id, s.enabled_by, d.number, c.name, k.token_hash
  FROM online_payments o JOIN documents d ON d.id = o.document_id JOIN companies c ON c.id = o.company_id
  LEFT JOIN payment_settings s ON s.company_id = o.company_id LEFT JOIN document_links k ON k.token_hash = o.link_hash
  WHERE app_user_id() IS NULL AND (o.id = p_id OR (p_ref IS NOT NULL AND o.provider_ref = p_ref))
$$;

/** Recorded: inside the transaction that records the payment (as the person who turned online payments on). */
CREATE FUNCTION online_pay_done(p_id uuid, p_payment uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o online_payments;
BEGIN
  SELECT * INTO o FROM online_payments WHERE id = p_id FOR UPDATE;
  IF o.id IS NULL OR NOT (app_user_id() IS NULL OR o.company_id = ANY (app_company_ids())) THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  IF o.status <> 'created' THEN RAISE EXCEPTION 'This online payment is already settled.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM payments WHERE id = p_payment AND company_id = o.company_id AND direction = 'received') THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  UPDATE online_payments SET status = 'paid', payment_id = p_payment, paid_at = now(), last_error = NULL WHERE id = p_id;
END $$;

/** Server only: the provider said no (declined card, expired checkout). */
CREATE FUNCTION online_pay_failed(p_id uuid, p_error text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  UPDATE online_payments SET status = 'failed', last_error = p_error WHERE id = p_id AND status = 'created';
END $$;

-- The public invoice page says whether it can be paid online.
CREATE OR REPLACE FUNCTION document_public(p_token_hash text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', d.id, 'type', d.type, 'status', d.status, 'issuedAt', d.issued_at, 'number', d.number, 'issueDate', d.issue_date, 'dueDate', d.due_date, 'reference', d.reference, 'notes', d.notes,
    'netTotal', d.net_total::text, 'vatTotal', d.vat_total::text, 'grossTotal', d.gross_total::text, 'amountDue', document_amount_due(d.id)::numeric(18,2)::text,
    'seller', jsonb_build_object('name', co.name, 'nameAr', co.name_ar, 'vatNumber', co.vat_number, 'crNumber', co.cr_number, 'address', co.address, 'city', co.city,
       'country', co.country, 'currency', co.currency),
    'buyer', jsonb_build_object('name', c.name, 'nameAr', c.name_ar, 'vatNumber', c.vat_number, 'address', c.address, 'city', c.city),
    'qr', (SELECT e.qr FROM einvoices e WHERE e.document_id = d.id ORDER BY e.created_at DESC LIMIT 1),
    'payOnline', d.type IN ('invoice', 'debit_note') AND d.status = 'issued' AND document_amount_due(d.id) > 0
       AND EXISTS (SELECT 1 FROM payment_settings s WHERE s.company_id = d.company_id AND s.enabled),
    'lines', (SELECT jsonb_agg(jsonb_build_object('description', l.description, 'quantity', l.quantity::text, 'unitPrice', l.unit_price::text, 'vatRate', l.vat_rate::text,
       'netAmount', l.net_amount::text, 'vatAmount', l.vat_amount::text) ORDER BY l.line_no) FROM document_lines l WHERE l.document_id = d.id))
  FROM document_links k JOIN documents d ON d.id = k.document_id JOIN companies co ON co.id = d.company_id JOIN contacts c ON c.id = d.contact_id
  WHERE k.token_hash = p_token_hash AND k.revoked_at IS NULL AND k.expires_at > now()
$$;

-- ---------------------------------------------------------------------------
-- Access and audit
-- ---------------------------------------------------------------------------
CREATE TRIGGER payment_settings_audit AFTER INSERT OR UPDATE OR DELETE ON payment_settings FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER online_payments_audit AFTER INSERT OR UPDATE OR DELETE ON online_payments FOR EACH ROW EXECUTE FUNCTION audit_row();
ALTER TABLE payment_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_settings_read ON payment_settings FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY payment_settings_insert ON payment_settings FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY payment_settings_update ON payment_settings FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));
GRANT SELECT, INSERT, UPDATE ON payment_settings TO nusuh_app;
ALTER TABLE online_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY online_payments_read ON online_payments FOR SELECT USING (company_id = ANY (app_company_ids()));
GRANT SELECT ON online_payments TO nusuh_app;

REVOKE ALL ON FUNCTION online_pay_start(text), online_pay_checkout(uuid, text, text), online_pay_get(uuid, text), online_pay_done(uuid, uuid), online_pay_failed(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION online_pay_start(text), online_pay_checkout(uuid, text, text), online_pay_get(uuid, text), online_pay_done(uuid, uuid), online_pay_failed(uuid, text) TO nusuh_app;
