-- 0055: refunds. Paying money back to a customer, and getting money back from a supplier.
--
-- Until now money could only move one way per side: in from customers, out to suppliers. A credit note reduced what
-- the customer still owed, so crediting an invoice they had already paid left the amount sitting as a negative
-- balance with no way to pay it out. The same for a supplier credit on a bill already paid.
--
-- A refund is an ordinary payment with is_refund set, going the opposite way to its side:
--   * customer refund  = direction 'made'     against an invoice or debit note  (money out, receivables cleared)
--   * supplier refund  = direction 'received' against a bill or claim           (money in, payables cleared)
-- The ledger side, not the direction of the cash, decides the control account: a customer refund debits
-- RECEIVABLES, never payables. That is handled in the application (postingForPayment).
--
-- What is due on a document therefore has to count allocations with a sign: an ordinary allocation reduces it, a
-- refund allocation adds it back. Every payment that exists today has is_refund = false, so every figure in every
-- existing company's books is unchanged by this migration; refunds.test.ts holds that as a regression test.

ALTER TABLE payments ADD COLUMN is_refund boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN payments.is_refund IS
  'Money going back the other way: paid out to a customer, or received back from a supplier.';

-- ---------------------------------------------------------------------------
-- What is still due, with allocations signed by whether they are refunds.
-- A negative result means we are holding money that belongs to the other party.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION document_amount_due(p_doc uuid) RETURNS numeric
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN d.type IN ('invoice', 'debit_note', 'bill', 'claim') AND d.status = 'issued' THEN
    d.gross_total
    - coalesce((SELECT sum(CASE WHEN p.is_refund THEN -a.amount ELSE a.amount END)
                FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                WHERE a.document_id = d.id AND p.voided_at IS NULL), 0)
    - coalesce((SELECT sum(c.gross_total) FROM documents c
                WHERE c.original_id = d.id AND c.type IN ('credit_note', 'supplier_credit') AND c.status = 'issued'), 0)
    - coalesce((SELECT sum(x.net_amount + x.vat_amount) FROM advance_deductions x WHERE x.document_id = d.id), 0)
  ELSE 0 END
  FROM documents d WHERE d.id = p_doc
$$;

-- ---------------------------------------------------------------------------
-- Who may be paid: a refund reverses which side of the contact is required.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_payment_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c contacts%ROWTYPE; e journal_entries%ROWTYPE; wants_customer boolean;
BEGIN
  IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  NEW.created_at := now(); NEW.created_xact := pg_current_xact_id();
  NEW.voided_at := NULL; NEW.void_entry_id := NULL;
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
-- What a payment may settle. A refund settles documents on its own side, and only up to the amount owed back.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION before_allocation_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p payments%ROWTYPE; d documents%ROWTYPE; used numeric; owed numeric; sales_side boolean;
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
  IF p.is_refund THEN
    -- Only money we are holding for them can be paid back: that is a negative amount due.
    owed := -document_amount_due(d.id);
    IF NEW.amount > owed THEN
      RAISE EXCEPTION 'This is more than is owed back on % (%).', d.number, greatest(owed, 0);
    END IF;
  ELSIF NEW.amount > document_amount_due(d.id) THEN
    RAISE EXCEPTION 'This is more than is due on % (%).', d.number, document_amount_due(d.id);
  END IF;
  SELECT coalesce(sum(amount), 0) INTO used FROM payment_allocations WHERE payment_id = p.id;
  IF used + NEW.amount > p.amount THEN
    RAISE EXCEPTION 'The amounts settled are more than the payment.';
  END IF;
  RETURN NEW;
END $$;
