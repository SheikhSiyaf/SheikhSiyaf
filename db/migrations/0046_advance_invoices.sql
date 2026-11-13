-- 0046 Advance payments (Rooms, stage 3): the advance-payment invoice (ZATCA type 386) and its deduction on the final
-- invoice (ZATCA XML Implementation Standard v1.2, section 9.5; rules BR-KSA-73 to 80).
--
-- Advance invoice: an ordinary invoice marked is_advance, every line on 2160 Customer advances, with VAT:
--   Dr Receivables (gross) / Cr 2160 Customer advances (net) / Cr Output VAT.  The guest's payment settles it as usual.
-- Final invoice: the whole supply with its full VAT, as ZATCA's example shows, less the advance ("prepaid amount" =
-- the advance's net + VAT). advance_deductions records each advance taken off; on issue the invoice's journal entry
-- also carries Dr 2160 (net) / Dr Output VAT (the advance's VAT) / Cr Receivables (prepaid), so the advance's VAT is
-- counted once in the books, and the amount due is the gross less the prepaid amount.
-- The VAT treatment of advances on the Saudi VAT return is to be confirmed by a qualified accountant before real use.

INSERT INTO accounts (company_id, code, name, name_ar, type)
SELECT c.id, '2160', 'Customer advances', 'دفعات مقدمة من العملاء', 'liability' FROM companies c
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id)
ON CONFLICT (company_id, code) DO NOTHING;

ALTER TABLE documents ADD COLUMN is_advance boolean NOT NULL DEFAULT false;
ALTER TABLE documents ADD CONSTRAINT documents_advance_is_invoice CHECK (NOT is_advance OR type = 'invoice');

CREATE TABLE advance_deductions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,   -- the final invoice
  advance_id   uuid NOT NULL REFERENCES documents(id),                     -- the advance invoice (386)
  net_amount   numeric(18,2) NOT NULL CHECK (net_amount > 0),
  vat_amount   numeric(18,2) NOT NULL CHECK (vat_amount >= 0),
  vat_code     text NOT NULL CHECK (vat_code IN ('standard', 'zero', 'exempt', 'out_of_scope')),
  vat_rate     numeric(5,2) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, advance_id),
  CONSTRAINT deduction_vat_is_net_times_rate CHECK (vat_amount = round(net_amount * vat_rate / 100, 2))   -- BR-KSA-79
);
CREATE INDEX advance_deductions_advance ON advance_deductions (advance_id);

/** What is left of an advance to deduct (net and VAT), over every final invoice that takes it, drafts included. */
CREATE FUNCTION advance_left(p_advance uuid) RETURNS TABLE (net numeric, vat numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.net_total - coalesce(sum(x.net_amount), 0), a.vat_total - coalesce(sum(x.vat_amount), 0)
  FROM documents a LEFT JOIN advance_deductions x ON x.advance_id = a.id
  WHERE a.id = p_advance AND a.is_advance AND (app_user_id() IS NULL OR a.company_id = ANY (app_company_ids()))
  GROUP BY a.id
$$;

CREATE FUNCTION before_advance_deduction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f documents; a documents; l record; left_net numeric; left_vat numeric;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'An advance deduction is never changed. Remove it from the draft and add it again.'; END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO f FROM documents WHERE id = OLD.document_id;
    IF f.id IS NOT NULL AND f.status <> 'draft' THEN RAISE EXCEPTION 'The advance deducted on an issued invoice no longer changes.'; END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO f FROM documents WHERE id = NEW.document_id;
  SELECT * INTO a FROM documents WHERE id = NEW.advance_id FOR UPDATE;
  IF f.company_id IS DISTINCT FROM NEW.company_id OR a.company_id IS DISTINCT FROM NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF f.type <> 'invoice' OR f.is_advance OR f.status <> 'draft' THEN RAISE EXCEPTION 'An advance is deducted only on a draft final invoice.'; END IF;
  IF NOT a.is_advance OR a.status <> 'issued' THEN RAISE EXCEPTION 'Only an issued advance invoice is deducted.'; END IF;
  IF a.contact_id IS DISTINCT FROM f.contact_id THEN RAISE EXCEPTION 'An advance is deducted only on an invoice to the same customer.'; END IF;
  IF document_amount_due(a.id) <> 0 THEN RAISE EXCEPTION 'The advance invoice is not fully paid yet: record the payment first.'; END IF;
  IF EXISTS (SELECT 1 FROM documents c WHERE c.original_id = a.id AND c.type = 'credit_note' AND c.status = 'issued') THEN
    RAISE EXCEPTION 'This advance has a credit note and is no longer deducted.';
  END IF;
  SELECT vat_code, vat_rate INTO l FROM document_lines WHERE document_id = a.id GROUP BY vat_code, vat_rate;
  IF NEW.vat_code <> l.vat_code OR NEW.vat_rate <> l.vat_rate THEN RAISE EXCEPTION 'The deduction carries the VAT category and rate of the advance.'; END IF;
  SELECT net, vat INTO left_net, left_vat FROM advance_left(a.id);
  IF NEW.net_amount > left_net OR NEW.vat_amount > left_vat THEN RAISE EXCEPTION 'Only % (+ VAT %) of this advance is left to deduct.', left_net, left_vat; END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER advance_deductions_before_change BEFORE INSERT OR UPDATE OR DELETE ON advance_deductions FOR EACH ROW EXECUTE FUNCTION before_advance_deduction();
CREATE TRIGGER advance_deductions_audit AFTER INSERT OR UPDATE OR DELETE ON advance_deductions FOR EACH ROW EXECUTE FUNCTION audit_row();

/** Rules for advances when documents are issued or marked. */
CREATE FUNCTION before_document_advance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE prepaid numeric; ded_net numeric; posted numeric; adv documents;
BEGIN
  IF OLD.status <> 'draft' AND NEW.is_advance IS DISTINCT FROM OLD.is_advance THEN RAISE EXCEPTION 'An issued invoice stays an advance invoice or not.'; END IF;
  IF OLD.status = 'draft' AND NEW.status = 'issued' THEN
    IF NEW.is_advance THEN
      IF EXISTS (SELECT 1 FROM document_lines l JOIN accounts x ON x.id = l.account_id WHERE l.document_id = NEW.id AND x.code <> '2160') THEN
        RAISE EXCEPTION 'An advance invoice is posted to 2160 Customer advances only.';
      END IF;
      IF (SELECT count(DISTINCT (vat_code, vat_rate)) FROM document_lines WHERE document_id = NEW.id) > 1 THEN
        RAISE EXCEPTION 'An advance invoice has one VAT category and rate.';
      END IF;
    END IF;
    IF NOT NEW.is_advance AND EXISTS (SELECT 1 FROM document_lines l JOIN accounts x ON x.id = l.account_id WHERE l.document_id = NEW.id AND x.code = '2160') THEN
      RAISE EXCEPTION 'Only an advance invoice is posted to 2160 Customer advances.';
    END IF;
    SELECT coalesce(sum(net_amount + vat_amount), 0), coalesce(sum(net_amount), 0) INTO prepaid, ded_net FROM advance_deductions WHERE document_id = NEW.id;
    IF prepaid > 0 THEN
      IF prepaid > NEW.gross_total THEN RAISE EXCEPTION 'The advances deducted (%) are more than the invoice (%).', prepaid, NEW.gross_total; END IF;
      SELECT coalesce(sum(jl.debit), 0) INTO posted FROM journal_lines jl JOIN accounts x ON x.id = jl.account_id
      WHERE jl.entry_id = NEW.journal_entry_id AND x.code = '2160';
      IF posted <> ded_net THEN RAISE EXCEPTION 'The invoice entry must clear the advances deducted from 2160 Customer advances.'; END IF;
    END IF;
    IF NEW.type = 'credit_note' AND NEW.original_id IS NOT NULL THEN
      SELECT * INTO adv FROM documents WHERE id = NEW.original_id;
      IF adv.is_advance AND EXISTS (SELECT 1 FROM advance_deductions WHERE advance_id = adv.id) THEN
        RAISE EXCEPTION 'This advance has been deducted on an invoice: credit that invoice instead.';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_advance_rules BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION before_document_advance();

-- The amount due on an invoice is its gross less payments, credit notes and the advances deducted on it.
CREATE OR REPLACE FUNCTION document_amount_due(p_doc uuid) RETURNS numeric
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN d.type IN ('invoice', 'debit_note', 'bill', 'claim') AND d.status = 'issued' THEN
    d.gross_total
    - coalesce((SELECT sum(a.amount) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                WHERE a.document_id = d.id AND p.voided_at IS NULL), 0)
    - coalesce((SELECT sum(c.gross_total) FROM documents c
                WHERE c.original_id = d.id AND c.type IN ('credit_note', 'supplier_credit') AND c.status = 'issued'), 0)
    - coalesce((SELECT sum(x.net_amount + x.vat_amount) FROM advance_deductions x WHERE x.document_id = d.id), 0)
  ELSE 0 END
  FROM documents d WHERE d.id = p_doc
$$;

-- Invoice lines on 2160 Customer advances (advance invoices only; checked when issued below).
CREATE OR REPLACE FUNCTION before_document_line_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d documents%ROWTYPE; a accounts%ROWTYPE; rate numeric;
BEGIN
  SELECT * INTO d FROM documents WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
  IF d.id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF d.status <> 'draft' THEN
    RAISE EXCEPTION 'Issued documents are never changed. Use a credit note to correct one.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  SELECT * INTO a FROM accounts WHERE id = NEW.account_id;
  IF a.company_id IS DISTINCT FROM d.company_id THEN
    RAISE EXCEPTION 'This account belongs to a different company.';
  END IF;
  -- An invoice line may also go to 2160 Customer advances: only an advance invoice is issued with it (0046).
  IF doc_side(d.type) = 'sales' AND a.type <> 'income' AND NOT (d.type = 'invoice' AND a.code = '2160') THEN
    RAISE EXCEPTION 'Sales lines use an income account.';
  ELSIF doc_side(d.type) = 'purchases' AND a.type NOT IN ('expense', 'asset') AND a.code <> '2050' THEN
    RAISE EXCEPTION 'Purchase lines use an expense or asset account.';
  END IF;
  IF NEW.cost_centre_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM cost_centres WHERE id = NEW.cost_centre_id AND company_id = d.company_id) THEN
    RAISE EXCEPTION 'This cost centre belongs to a different company.';
  END IF;
  SELECT vat_rate INTO rate FROM companies WHERE id = d.company_id;
  IF NEW.vat_code = 'standard' AND NEW.vat_rate <> rate THEN
    RAISE EXCEPTION 'Standard-rated lines use the company VAT rate (%).', rate;
  END IF;
  RETURN NEW;
END $$;


-- Rooms: advances taken for a booking.
CREATE TABLE booking_advances (
  booking_id   uuid NOT NULL REFERENCES bookings(id),
  document_id  uuid NOT NULL UNIQUE REFERENCES documents(id),
  company_id   uuid NOT NULL REFERENCES companies(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, document_id)
);
CREATE FUNCTION before_booking_advance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'An advance stays on its booking.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM bookings b JOIN documents d ON d.id = NEW.document_id
                 WHERE b.id = NEW.booking_id AND b.company_id = NEW.company_id AND d.company_id = NEW.company_id AND d.is_advance AND d.contact_id = b.contact_id) THEN
    RAISE EXCEPTION 'An advance belongs to a booking of the same guest.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_advances_before_change BEFORE INSERT OR UPDATE OR DELETE ON booking_advances FOR EACH ROW EXECUTE FUNCTION before_booking_advance();
CREATE TRIGGER booking_advances_audit AFTER INSERT OR UPDATE OR DELETE ON booking_advances FOR EACH ROW EXECUTE FUNCTION audit_row();

ALTER TABLE advance_deductions ENABLE ROW LEVEL SECURITY;
CREATE POLICY advance_deductions_read ON advance_deductions FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY advance_deductions_insert ON advance_deductions FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY advance_deductions_delete ON advance_deductions FOR DELETE USING (app_has_role(company_id, posting_roles()));
GRANT SELECT, INSERT, DELETE ON advance_deductions TO nusuh_app;
ALTER TABLE booking_advances ENABLE ROW LEVEL SECURITY;
CREATE POLICY booking_advances_read ON booking_advances FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY booking_advances_insert ON booking_advances FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
GRANT SELECT, INSERT ON booking_advances TO nusuh_app;
REVOKE ALL ON FUNCTION advance_left(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION advance_left(uuid) TO nusuh_app;
