-- 0045 Refundable security deposits on bookings (Rooms, stage 2).
--
-- A security deposit is money held for the guest (against damage or unpaid extras), not payment for the stay, so it
-- carries no VAT and makes no invoice. It sits in 2150 Guest deposits held until it is returned or used.
--   taken:    Dr bank or cash / Cr 2150 Guest deposits held
--   returned: Dr 2150 / Cr bank or cash
--   applied:  the deposit pays the guest's invoice: Dr 2150 / Cr bank or cash, recorded together with an ordinary
--             receipt from the guest into the same account, allocated to the invoice (Dr bank / Cr Receivables). The
--             two bank lines cancel; the invoice shows as paid. Keeping part for damage = an extra on the guest bill
--             (income, with VAT), then applying the deposit to that bill.
-- Rows are never changed or deleted; a booking never returns or applies more than it holds.

INSERT INTO accounts (company_id, code, name, name_ar, type)
SELECT c.id, '2150', 'Guest deposits held', 'تأمينات النزلاء المحتفظ بها', 'liability' FROM companies c
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id)
ON CONFLICT (company_id, code) DO NOTHING;

CREATE TABLE booking_deposits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id),
  booking_id        uuid NOT NULL REFERENCES bookings(id),
  kind              text NOT NULL CHECK (kind IN ('taken', 'returned', 'applied')),
  amount            numeric(18,2) NOT NULL CHECK (amount > 0),
  entry_date        date NOT NULL,
  account_id        uuid NOT NULL REFERENCES accounts(id),           -- the bank or cash account
  method            text NOT NULL DEFAULT 'cash' CHECK (method IN ('bank_transfer', 'cash', 'card', 'cheque', 'other')),
  reference         text,
  document_id       uuid REFERENCES documents(id),                   -- applied: the invoice it paid
  payment_id        uuid REFERENCES payments(id),                    -- applied: the receipt recorded with it
  journal_entry_id  uuid NOT NULL REFERENCES journal_entries(id),
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'applied') = (document_id IS NOT NULL AND payment_id IS NOT NULL))
);
CREATE INDEX booking_deposits_booking ON booking_deposits (booking_id, created_at);

/** What a booking still holds as deposit. */
CREATE FUNCTION booking_deposit_held(p_booking uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(CASE WHEN kind = 'taken' THEN amount ELSE -amount END), 0)::numeric(18,2) FROM booking_deposits
  WHERE booking_id = p_booking AND (app_user_id() IS NULL OR company_id = ANY (app_company_ids()))
$$;

CREATE FUNCTION before_booking_deposit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b bookings; held numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'A deposit movement is never changed. Record a return instead.'; END IF;
  SELECT * INTO b FROM bookings WHERE id = NEW.booking_id FOR UPDATE;
  IF b.company_id IS DISTINCT FROM NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND company_id = NEW.company_id AND is_bank) THEN
    RAISE EXCEPTION 'Choose a bank or cash account of this company.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.journal_entry_id AND company_id = NEW.company_id) THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF NEW.kind = 'taken' AND b.status NOT IN ('reserved', 'in_house') THEN RAISE EXCEPTION 'A deposit is taken before or during the stay.'; END IF;
  IF NEW.kind <> 'taken' THEN
    held := booking_deposit_held(NEW.booking_id);
    IF NEW.amount > held THEN RAISE EXCEPTION 'The booking holds only % as deposit.', held; END IF;
  END IF;
  IF NEW.kind = 'applied' AND NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND company_id = NEW.company_id AND contact_id = b.contact_id) THEN
    RAISE EXCEPTION 'A deposit pays only an invoice of the same guest.';
  END IF;
  IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER booking_deposits_before_change BEFORE INSERT OR UPDATE OR DELETE ON booking_deposits FOR EACH ROW EXECUTE FUNCTION before_booking_deposit();
CREATE TRIGGER booking_deposits_audit AFTER INSERT OR UPDATE OR DELETE ON booking_deposits FOR EACH ROW EXECUTE FUNCTION audit_row();

ALTER TABLE booking_deposits ENABLE ROW LEVEL SECURITY;
CREATE POLICY booking_deposits_read ON booking_deposits FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY booking_deposits_insert ON booking_deposits FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
GRANT SELECT, INSERT ON booking_deposits TO nusuh_app;
REVOKE ALL ON FUNCTION booking_deposit_held(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION booking_deposit_held(uuid) TO nusuh_app;
