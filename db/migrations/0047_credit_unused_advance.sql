-- 0047 An unused advance can be credited.
-- A booking with a paid advance could be cancelled, but the advance could not be refunded: a credit note copies the
-- advance invoice's lines on 2160 Customer advances, and the sales line rule allowed 2160 on invoices only. A credit
-- note of an advance invoice may now use 2160 too, so its entry reverses 2160 and the advance's VAT. 0046 already
-- refuses a credit note for an advance that has been deducted on a final invoice.

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
  -- So may a credit note of an advance invoice: an unused advance is refunded by crediting it (0047).
  IF doc_side(d.type) = 'sales' AND a.type <> 'income' AND NOT (a.code = '2160' AND (d.type = 'invoice'
       OR (d.type = 'credit_note' AND EXISTS (SELECT 1 FROM documents o WHERE o.id = d.original_id AND o.is_advance)))) THEN
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

CREATE OR REPLACE FUNCTION before_document_advance() RETURNS trigger
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
    -- A credit note of an advance invoice reverses 2160 (0047); anything else on 2160 is refused.
    IF NOT NEW.is_advance AND NOT (NEW.type = 'credit_note' AND EXISTS (SELECT 1 FROM documents o WHERE o.id = NEW.original_id AND o.is_advance))
       AND EXISTS (SELECT 1 FROM document_lines l JOIN accounts x ON x.id = l.account_id WHERE l.document_id = NEW.id AND x.code = '2160') THEN
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
