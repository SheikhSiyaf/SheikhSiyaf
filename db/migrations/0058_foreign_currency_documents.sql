-- 0058: invoices, bills and payments written in another currency.
--
-- 0029 put the ledger side of multi-currency in place: accounts kept in another currency, a daily rate feed, and the
-- IAS 21 month-end revaluation. It closed with "invoices, payments and bank statements in other currencies come
-- later". This is that.
--
-- THE RULE THAT KEEPS THE BOOKS PROVABLE: the ledger stays in ONE currency, the company's. A foreign-currency
-- document carries two sets of figures side by side:
--   * fx_net_total / fx_vat_total / fx_gross_total and the fx_ amounts on each line: the document AS WRITTEN, in its
--     own currency. This is what the customer reads, what the PDF shows and what goes on the e-invoice.
--   * net_total / vat_total / gross_total and the ordinary line amounts: the SAME document converted at its own
--     rate, in the company's currency. This is what posts to the journal, and it is what every report, the aged
--     list, the statement, the credit-note limit, the approval threshold and document_amount_due() already read.
-- Nothing that existed before this migration changes meaning. A document with no currency IS a company-currency
-- document, exactly as it always was: currency, fx_rate and every fx_ column are simply empty, and not one existing
-- figure in any company's books is touched. foreignCurrency.test.ts holds that as a regression test, and the
-- end-of-phase check compares the whole trial balance before and after.
--
-- Converting: the rate is applied to the UNIT PRICE, and the line amounts then follow the same arithmetic as any
-- company-currency line (net = quantity x unit price, VAT = net x rate). So the converted document satisfies the
-- very same constraints as every other document in the table, and gross = net + VAT holds by construction. That is
-- why the trial balance cannot drift.
--
-- A payment in another currency records what was actually written on it (fx_amount at fx_rate) and what actually
-- reached the bank (amount, in the company's currency). Settling relieves the receivable or payable at the rate the
-- DOCUMENT was booked at, never the payment's, so the control account empties exactly. The difference between the
-- two is a realised exchange gain or loss (account 4951), which is the whole of realisation under IAS 21.
--
-- Deliberately out of scope, and refused rather than half-done: foreign-currency opening balances, expenses and
-- employee claims; advance invoices in another currency; a credit note at a different rate from its original; and a
-- bank account held in another currency (0029 already refuses that).

-- ---------------------------------------------------------------------------
-- Documents: the currency, the rate, and the amounts as written
-- ---------------------------------------------------------------------------
ALTER TABLE documents
  ADD COLUMN currency       char(3),
  ADD COLUMN fx_rate        numeric(18,8),
  ADD COLUMN fx_net_total   numeric(18,2),
  ADD COLUMN fx_vat_total   numeric(18,2),
  ADD COLUMN fx_gross_total numeric(18,2);

COMMENT ON COLUMN documents.currency IS
  'The currency this document is written in; empty means the company''s own currency. The ledger always holds the converted amounts.';
COMMENT ON COLUMN documents.fx_rate IS
  'How many of the company''s currency one unit of documents.currency was worth when the document was issued. 1 currency = rate base.';
COMMENT ON COLUMN documents.fx_gross_total IS
  'The total as written on the document, in its own currency. gross_total is the same total in the company''s currency.';

ALTER TABLE documents
  ADD CONSTRAINT doc_currency_shape CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  -- the currency, the rate and the written figures arrive together or not at all
  ADD CONSTRAINT doc_fx_all_or_nothing CHECK (
    (currency IS NULL) = (fx_rate IS NULL)
    AND (currency IS NULL) = (fx_net_total IS NULL)
    AND (currency IS NULL) = (fx_vat_total IS NULL)
    AND (currency IS NULL) = (fx_gross_total IS NULL)),
  ADD CONSTRAINT doc_fx_rate_positive CHECK (fx_rate IS NULL OR fx_rate > 0),
  ADD CONSTRAINT doc_fx_totals_add_up CHECK (
    fx_gross_total IS NULL
    OR (fx_gross_total = fx_net_total + fx_vat_total AND fx_net_total >= 0 AND fx_vat_total >= 0)),
  -- only the documents a customer or supplier actually reads are written in another currency
  ADD CONSTRAINT doc_fx_type CHECK (
    currency IS NULL
    OR type IN ('quotation', 'invoice', 'credit_note', 'debit_note', 'bill', 'supplier_credit', 'purchase_order')),
  -- an opening balance belongs to the previous system, and an advance invoice is settled against later invoices in
  -- the company's own currency: neither is written in another currency (0056, 0046)
  ADD CONSTRAINT doc_fx_not_opening CHECK (currency IS NULL OR NOT is_opening),
  ADD CONSTRAINT doc_fx_not_advance CHECK (currency IS NULL OR NOT is_advance);

-- ---------------------------------------------------------------------------
-- Document lines: the unit price and amounts as written
-- ---------------------------------------------------------------------------
ALTER TABLE document_lines
  ADD COLUMN fx_unit_price numeric(18,2),
  ADD COLUMN fx_net_amount numeric(18,2),
  ADD COLUMN fx_vat_amount numeric(18,2);

COMMENT ON COLUMN document_lines.fx_unit_price IS
  'The unit price as written on the document, in the document''s currency. unit_price is the same price converted.';

ALTER TABLE document_lines
  ADD CONSTRAINT line_fx_all_or_nothing CHECK (
    (fx_unit_price IS NULL) = (fx_net_amount IS NULL) AND (fx_unit_price IS NULL) = (fx_vat_amount IS NULL)),
  ADD CONSTRAINT line_fx_price_positive CHECK (fx_unit_price IS NULL OR fx_unit_price >= 0),
  -- the written figures must add up in their own currency, by the same arithmetic as the converted ones
  ADD CONSTRAINT line_fx_net_is_qty_times_price CHECK (
    fx_net_amount IS NULL OR fx_net_amount = round(quantity * fx_unit_price, 2)),
  ADD CONSTRAINT line_fx_vat_is_net_times_rate CHECK (
    fx_vat_amount IS NULL OR fx_vat_amount = round(fx_net_amount * vat_rate / 100, 2));

-- ---------------------------------------------------------------------------
-- Payments: what was written on the payment, and what reached the bank
-- ---------------------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN currency  char(3),
  ADD COLUMN fx_rate   numeric(18,8),
  ADD COLUMN fx_amount numeric(18,2);

COMMENT ON COLUMN payments.currency IS
  'The currency the payment was made in; empty means the company''s own currency. amount is always what reached the bank, in the company''s currency.';

ALTER TABLE payments
  ADD CONSTRAINT pay_currency_shape CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT pay_fx_all_or_nothing CHECK (
    (currency IS NULL) = (fx_rate IS NULL) AND (currency IS NULL) = (fx_amount IS NULL)),
  ADD CONSTRAINT pay_fx_positive CHECK ((fx_rate IS NULL OR fx_rate > 0) AND (fx_amount IS NULL OR fx_amount > 0));

ALTER TABLE payment_allocations ADD COLUMN fx_amount numeric(18,2);
COMMENT ON COLUMN payment_allocations.fx_amount IS
  'How much of the document this settles, in the document''s own currency. amount is the same settlement in the company''s currency, at the DOCUMENT''s rate.';
ALTER TABLE payment_allocations
  ADD CONSTRAINT alloc_fx_positive CHECK (fx_amount IS NULL OR fx_amount > 0);

-- ---------------------------------------------------------------------------
-- What is still owed, in the document's own currency.
-- The mirror of document_amount_due (0055), figure for figure, so the two close together. A document with no
-- currency answers in the company's currency, which is the same number document_amount_due gives.
-- ---------------------------------------------------------------------------
CREATE FUNCTION document_fx_due(p_doc uuid) RETURNS numeric
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN d.type IN ('invoice', 'debit_note', 'bill', 'claim') AND d.status = 'issued' THEN
    coalesce(d.fx_gross_total, d.gross_total)
    - coalesce((SELECT sum(CASE WHEN p.is_refund THEN -coalesce(a.fx_amount, a.amount) ELSE coalesce(a.fx_amount, a.amount) END)
                FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                WHERE a.document_id = d.id AND p.voided_at IS NULL), 0)
    - coalesce((SELECT sum(coalesce(c.fx_gross_total, c.gross_total)) FROM documents c
                WHERE c.original_id = d.id AND c.type IN ('credit_note', 'supplier_credit') AND c.status = 'issued'), 0)
    - coalesce((SELECT sum(x.net_amount + x.vat_amount) FROM advance_deductions x WHERE x.document_id = d.id), 0)
  ELSE 0 END
  FROM documents d WHERE d.id = p_doc
$$;

COMMENT ON FUNCTION document_fx_due(uuid) IS
  'What is still owed on an invoice or bill in the currency it is written in. document_amount_due gives the same in the company''s currency.';

-- ---------------------------------------------------------------------------
-- The currency a document may carry.
-- Named to sort before documents_opening_guard so the company's own currency is folded away to NULL first and the
-- rest of the rules see a settled row.
-- ---------------------------------------------------------------------------
CREATE FUNCTION before_document_currency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE own char(3); orig documents%ROWTYPE;
BEGIN
  SELECT currency INTO own FROM companies WHERE id = NEW.company_id;
  -- The company's own currency is not a foreign currency: a document in it is an ordinary document (as 0029 does
  -- for accounts), so there is only ever one way to say the same thing.
  IF NEW.currency = own THEN
    NEW.currency := NULL; NEW.fx_rate := NULL;
    NEW.fx_net_total := NULL; NEW.fx_vat_total := NULL; NEW.fx_gross_total := NULL;
  END IF;
  IF NEW.currency IS NOT NULL THEN
    -- A credit note must undo exactly what the invoice did, so it is written in the same currency AT THE SAME RATE.
    -- Otherwise the amount it credits in the company's books would not match the invoice it is correcting, and the
    -- limit check in before_document_update would be comparing two different things.
    IF NEW.type IN ('credit_note', 'supplier_credit') AND NEW.original_id IS NOT NULL THEN
      SELECT * INTO orig FROM documents WHERE id = NEW.original_id;
      IF orig.currency IS DISTINCT FROM NEW.currency OR orig.fx_rate IS DISTINCT FROM NEW.fx_rate THEN
        RAISE EXCEPTION 'A credit note is written in the same currency and at the same rate as the invoice it corrects (% at %).',
          coalesce(orig.currency, own), coalesce(orig.fx_rate, 1);
      END IF;
    END IF;
  ELSIF NEW.type IN ('credit_note', 'supplier_credit') AND NEW.original_id IS NOT NULL
        AND (SELECT currency FROM documents WHERE id = NEW.original_id) IS NOT NULL THEN
    RAISE EXCEPTION 'The invoice this corrects is written in another currency, so this one must be too.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_currency_guard BEFORE INSERT OR UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION before_document_currency();

-- ---------------------------------------------------------------------------
-- A line carries the written figures exactly when its document has a currency.
-- Rebuilt from the 0056 version with that one rule added; everything else is unchanged.
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
  -- A document written in another currency carries the written price on every line, and one in the company's own
  -- currency carries none: there is no half-converted document (0058).
  IF (d.currency IS NULL) <> (NEW.fx_unit_price IS NULL) THEN
    IF d.currency IS NULL THEN
      RAISE EXCEPTION 'This document is in the company''s own currency, so its lines carry no other currency.';
    END IF;
    RAISE EXCEPTION 'This document is written in %, so every line needs its price in %.', d.currency, d.currency;
  END IF;
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
-- A payment in another currency: what reached the bank must be what was written, at the rate given.
-- Rebuilt from the 0055 version with that one rule added.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_payment_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c contacts%ROWTYPE; e journal_entries%ROWTYPE; wants_customer boolean; own char(3);
BEGIN
  IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  NEW.created_at := now(); NEW.created_xact := pg_current_xact_id();
  NEW.voided_at := NULL; NEW.void_entry_id := NULL;
  SELECT currency INTO own FROM companies WHERE id = NEW.company_id;
  IF NEW.currency = own THEN
    NEW.currency := NULL; NEW.fx_rate := NULL; NEW.fx_amount := NULL;
  END IF;
  IF NEW.currency IS NOT NULL AND NEW.amount <> round(NEW.fx_amount * NEW.fx_rate, 2) THEN
    RAISE EXCEPTION 'The amount reaching the bank must be the % amount times the rate (% x % = %).',
      NEW.currency, NEW.fx_amount, NEW.fx_rate, round(NEW.fx_amount * NEW.fx_rate, 2);
  END IF;
  SELECT * INTO c FROM contacts WHERE id = NEW.contact_id;
  -- Money in normally comes from a customer; a refund received comes back from a supplier, and the other way round.
  wants_customer := (NEW.direction = 'received') <> NEW.is_refund;
  IF c.company_id IS DISTINCT FROM NEW.company_id
     OR (wants_customer AND NOT c.is_customer)
     OR (NOT wants_customer AND NOT (c.is_supplier OR c.is_employee)) THEN
    IF NEW.is_refund THEN
      RAISE EXCEPTION 'Refund a customer (money paid back) or a supplier (money received back) of this company.';
    END IF;
    RAISE EXCEPTION 'Choose a customer (money received) or a supplier or employee (money paid) of this company.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND company_id = NEW.company_id AND is_bank) THEN
    RAISE EXCEPTION 'Choose one of this company''s bank or cash accounts.';
  END IF;
  SELECT * INTO e FROM journal_entries WHERE id = NEW.journal_entry_id;
  IF e.id IS NULL OR e.source_id IS DISTINCT FROM NEW.id OR e.company_id <> NEW.company_id OR e.entry_date <> NEW.payment_date THEN
    RAISE EXCEPTION 'A payment needs its own posted journal entry.';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- What a payment may settle, now counted in the currency the payment is written in.
-- Rebuilt from the 0055 version. For a payment with no currency every comparison below is the 0055 one, figure for
-- figure: coalesce(fx_amount, amount) is just amount, and document_fx_due equals document_amount_due.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_allocation_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p payments%ROWTYPE; d documents%ROWTYPE; used numeric; owed numeric; sales_side boolean;
        mine numeric; purse numeric;
BEGIN
  SELECT * INTO p FROM payments WHERE id = NEW.payment_id;
  IF p.created_xact <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'Payments are never changed. Void the payment instead.';
  END IF;
  SELECT * INTO d FROM documents WHERE id = NEW.document_id;
  -- A refund belongs to the side it reverses: money paid back to a customer settles an invoice or debit note.
  sales_side := (p.direction = 'received') <> p.is_refund;
  IF d.company_id IS DISTINCT FROM p.company_id OR d.contact_id <> p.contact_id OR d.status <> 'issued'
     OR (sales_side AND d.type NOT IN ('invoice', 'debit_note'))
     OR (NOT sales_side AND d.type NOT IN ('bill', 'claim')) THEN
    RAISE EXCEPTION 'A payment can only settle issued invoices (or bills) of the same customer (or supplier).';
  END IF;
  -- A payment settles documents written in its own currency. Mixing them would mean converting one party's money
  -- twice, and neither the document nor the payment would close cleanly (0058).
  IF d.currency IS DISTINCT FROM p.currency THEN
    RAISE EXCEPTION 'This payment is in % and % is written in %: settle it with a payment in the same currency.',
      coalesce(p.currency, (SELECT currency FROM companies WHERE id = p.company_id)), d.number,
      coalesce(d.currency, (SELECT currency FROM companies WHERE id = p.company_id));
  END IF;
  IF (p.currency IS NULL) <> (NEW.fx_amount IS NULL) THEN
    RAISE EXCEPTION 'A payment in another currency settles an amount in that currency.';
  END IF;
  -- Everything below is counted in the currency the payment is written in.
  mine := coalesce(NEW.fx_amount, NEW.amount);
  purse := coalesce(p.fx_amount, p.amount);
  IF p.is_refund THEN
    -- Only money we are holding for them can be paid back: that is a negative amount due.
    owed := -document_fx_due(d.id);
    IF mine > owed THEN
      RAISE EXCEPTION 'This is more than is owed back on % (%).', d.number, greatest(owed, 0);
    END IF;
  ELSIF mine > document_fx_due(d.id) THEN
    RAISE EXCEPTION 'This is more than is due on % (%).', d.number, document_fx_due(d.id);
  END IF;
  SELECT coalesce(sum(coalesce(fx_amount, amount)), 0) INTO used FROM payment_allocations WHERE payment_id = p.id;
  IF used + mine > purse THEN
    RAISE EXCEPTION 'The amounts settled are more than the payment.';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- An advance is deducted only between documents in the company's own currency.
-- Rebuilt from the 0046 version with that one rule added. A foreign advance invoice is already refused by
-- doc_fx_not_advance; this is the other half, so a foreign FINAL invoice cannot deduct one either.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_advance_deduction() RETURNS trigger
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
  IF f.currency IS NOT NULL OR a.currency IS NOT NULL THEN
    RAISE EXCEPTION 'An advance is deducted only between invoices in the company''s own currency.';
  END IF;
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
