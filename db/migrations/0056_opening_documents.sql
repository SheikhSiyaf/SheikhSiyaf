-- 0056: opening balances as individual open invoices and bills.
--
-- A client moving from Excel or another system is owed money on PARTICULAR invoices and owes money on PARTICULAR
-- bills. The bulk import could only bring the whole receivable in as one total, which left the aged debtors report,
-- customer statements and payment matching wrong from the client's first day.
--
-- An opening document is the real document from the old system, kept with its own number, issue date and due date.
-- It is not a new sale: the revenue and the VAT belong to the previous system and were declared there. So the whole
-- amount is posted against 3000 Opening balances, with no income, no expense and NO VAT, and it is never sent to
-- ZATCA or any other e-invoicing scheme. Everything after that treats it as an ordinary issued document: it ages,
-- it appears on statements, and payments settle it.

ALTER TABLE documents ADD COLUMN is_opening boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN documents.is_opening IS
  'Brought in from the client''s previous system as an already-open invoice or bill: posted to 3000 Opening balances, no VAT, never e-invoiced.';

-- ---------------------------------------------------------------------------
-- A line of an opening document goes to the opening balances account, whichever side it is on.
-- ---------------------------------------------------------------------------
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
  -- An opening document carries no revenue and no cost: the whole amount sits against 3000 Opening balances (0056).
  IF d.is_opening THEN
    IF a.code <> '3000' THEN
      RAISE EXCEPTION 'An opening invoice or bill is posted to 3000 Opening balances only.';
    END IF;
    IF NEW.vat_code <> 'out_of_scope' OR NEW.vat_rate <> 0 OR NEW.vat_amount <> 0 THEN
      RAISE EXCEPTION 'An opening invoice or bill carries no VAT: it was declared in the previous system.';
    END IF;
    RETURN NEW;
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

-- ---------------------------------------------------------------------------
-- What an opening document must be, and that it never stops being one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_document_opening() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.is_opening IS DISTINCT FROM OLD.is_opening THEN
    RAISE EXCEPTION 'An opening invoice or bill stays one; an ordinary document never becomes one.';
  END IF;
  IF NEW.is_opening THEN
    IF NEW.type NOT IN ('invoice', 'bill') THEN
      RAISE EXCEPTION 'Only an invoice or a bill is brought in as an opening balance.';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'issued' THEN
      IF (SELECT count(*) FROM document_lines WHERE document_id = NEW.id) <> 1 THEN
        RAISE EXCEPTION 'An opening invoice or bill has exactly one line: what is still owed.';
      END IF;
      IF NEW.vat_total <> 0 THEN
        RAISE EXCEPTION 'An opening invoice or bill carries no VAT: it was declared in the previous system.';
      END IF;
      IF btrim(coalesce(NEW.number, '')) = '' THEN
        RAISE EXCEPTION 'An opening invoice or bill keeps its number from the previous system.';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_opening_guard BEFORE INSERT OR UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION before_document_opening();

-- ---------------------------------------------------------------------------
-- An opening document is never e-invoiced: it was invoiced and reported in the previous system.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_einvoice_opening() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND is_opening) THEN
    RAISE EXCEPTION 'An opening invoice or bill is never sent to e-invoicing: it belongs to the previous system.';
  END IF;
  RETURN NEW;
END $$;
-- Named to sort before einvoices_before_change so this is the first thing checked and the reason given is the real
-- one ("never sent to e-invoicing"), not a later check's message.
CREATE TRIGGER einvoices_assert_not_opening BEFORE INSERT ON einvoices
  FOR EACH ROW EXECUTE FUNCTION before_einvoice_opening();
