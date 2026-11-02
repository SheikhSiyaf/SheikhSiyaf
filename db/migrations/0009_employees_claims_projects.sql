-- 0009: Employees, employee expense claims with approval, and projects.
--   * Employees are contacts marked is_employee (never also a customer or supplier), so the same
--     payment and ledger machinery reimburses them. HR details (employee no., job title) sit on the contact.
--   * A claim is a document: draft -> submitted -> approved (posted) or rejected (-> draft to correct).
--     Approval posts Dr expense lines, Dr input VAT, Cr 2200 Employee claims payable.
--     Whoever submitted a claim cannot approve or reject it (separation of duties).
--   * Reimbursing an employee is a payment made: Dr 2200, Cr bank/cash, settling approved claims.
--   * Projects are cost centres of kind 'project' with optional customer, dates, budget and status.

-- ---------------------------------------------------------------------------
-- Employees
-- ---------------------------------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN is_employee boolean NOT NULL DEFAULT false,
  ADD COLUMN employee_no text,
  ADD COLUMN job_title text,
  ADD COLUMN default_cost_centre_id uuid REFERENCES cost_centres(id);
ALTER TABLE contacts DROP CONSTRAINT contacts_check;
ALTER TABLE contacts ADD CONSTRAINT contact_has_a_role CHECK (is_customer OR is_supplier OR is_employee);
ALTER TABLE contacts ADD CONSTRAINT employee_is_only_employee CHECK (NOT is_employee OR NOT (is_customer OR is_supplier));
CREATE UNIQUE INDEX contacts_employee_no ON contacts (company_id, employee_no) WHERE employee_no IS NOT NULL;

INSERT INTO accounts (company_id, code, name, name_ar, type)
SELECT c.id, '2200', 'Employee claims payable', 'مطالبات الموظفين المستحقة', 'liability' FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.code = '2200');

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
ALTER TABLE cost_centres
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  ADD COLUMN budget numeric(18,2) CHECK (budget IS NULL OR budget >= 0),
  ADD COLUMN contact_id uuid REFERENCES contacts(id),
  ADD COLUMN start_date date,
  ADD COLUMN end_date date,
  ADD COLUMN description text,
  ADD CONSTRAINT cost_centre_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date);

CREATE FUNCTION before_cost_centre_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'Posted records cannot be changed or deleted. Post a reversal instead.';
  END IF;
  IF NEW.contact_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM contacts WHERE id = NEW.contact_id AND company_id = NEW.company_id AND is_customer) THEN
    RAISE EXCEPTION 'Choose a customer of this company for the project.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cost_centres_before_change BEFORE INSERT OR UPDATE ON cost_centres FOR EACH ROW EXECUTE FUNCTION before_cost_centre_change();

-- ---------------------------------------------------------------------------
-- Claims on documents
-- ---------------------------------------------------------------------------
ALTER TABLE documents
  ADD COLUMN submitted_by uuid REFERENCES users(id),
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN decided_by uuid REFERENCES users(id),
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN rejection_reason text;

ALTER TABLE documents DROP CONSTRAINT doc_status_by_type;
ALTER TABLE documents ADD CONSTRAINT doc_status_by_type CHECK (
  (type = 'quotation' AND status IN ('draft', 'sent', 'accepted', 'declined', 'invoiced')) OR
  (type = 'expense' AND status IN ('draft', 'issued', 'voided')) OR
  (type = 'claim' AND status IN ('draft', 'submitted', 'issued', 'rejected')) OR
  (type NOT IN ('quotation', 'expense', 'claim') AND status IN ('draft', 'issued')));
ALTER TABLE documents DROP CONSTRAINT doc_original_by_type;
ALTER TABLE documents ADD CONSTRAINT doc_original_by_type CHECK (
  (type IN ('credit_note', 'supplier_credit') AND original_id IS NOT NULL) OR
  (type = 'invoice') OR
  (type IN ('quotation', 'bill', 'expense', 'claim') AND original_id IS NULL));
ALTER TABLE documents ADD CONSTRAINT doc_claim_fields CHECK (
  type = 'claim' OR (submitted_by IS NULL AND decided_by IS NULL AND rejection_reason IS NULL));

-- Which kind of contact each document type needs.
CREATE FUNCTION contact_fits(t doc_type, c contacts) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t = 'claim' THEN c.is_employee
              WHEN t IN ('quotation', 'invoice', 'credit_note') THEN c.is_customer
              ELSE c.is_supplier END
$$;

CREATE OR REPLACE FUNCTION before_document_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c contacts%ROWTYPE;
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'New documents start as drafts.';
  END IF;
  IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  NEW.created_at := now();
  NEW.number := NULL; NEW.journal_entry_id := NULL; NEW.issued_by := NULL; NEW.issued_at := NULL;
  NEW.void_entry_id := NULL; NEW.voided_at := NULL;
  NEW.submitted_by := NULL; NEW.submitted_at := NULL; NEW.decided_by := NULL; NEW.decided_at := NULL; NEW.rejection_reason := NULL;
  IF NEW.contact_id IS NOT NULL OR NEW.type <> 'expense' THEN
    SELECT * INTO c FROM contacts WHERE id = NEW.contact_id;
    IF c.company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'This customer or supplier belongs to a different company.';
    END IF;
    IF NOT contact_fits(NEW.type, c) THEN
      RAISE EXCEPTION '%', CASE WHEN NEW.type = 'claim' THEN 'Choose an employee for this claim.'
                                WHEN doc_side(NEW.type) = 'sales' THEN 'Choose a customer for this document.'
                                ELSE 'Choose a supplier for this document.' END;
    END IF;
  END IF;
  IF NEW.paid_from_account_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM accounts WHERE id = NEW.paid_from_account_id AND company_id = NEW.company_id AND is_bank) THEN
    RAISE EXCEPTION 'Choose one of this company''s bank or cash accounts.';
  END IF;
  IF NEW.recurring_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM recurring_expenses WHERE id = NEW.recurring_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'This recurring expense belongs to a different company.';
  END IF;
  IF NEW.original_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM documents o WHERE o.id = NEW.original_id AND o.company_id = NEW.company_id
         AND ((NEW.type = 'credit_note' AND o.type = 'invoice' AND o.status = 'issued' AND o.contact_id = NEW.contact_id)
           OR (NEW.type = 'supplier_credit' AND o.type = 'bill' AND o.status = 'issued' AND o.contact_id = NEW.contact_id)
           OR (NEW.type = 'invoice' AND o.type = 'quotation'))) THEN
    RAISE EXCEPTION 'A credit note must point to an issued invoice (or bill) of the same customer (or supplier).';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION before_document_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE credited numeric; orig documents%ROWTYPE; e journal_entries%ROWTYPE; who uuid := app_user_id();
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.type <> OLD.type OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'Posted records cannot be changed or deleted. Post a reversal instead.';
  END IF;

  -- Editing a draft
  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    IF NEW.number IS DISTINCT FROM OLD.number OR NEW.journal_entry_id IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'A draft has no journal entry yet.';
    END IF;
    IF NEW.type <> 'claim' AND NEW.number IS NOT NULL THEN
      RAISE EXCEPTION 'A draft has no number or journal entry yet.';
    END IF;
    IF NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NOT (NEW.type = 'expense' AND NEW.contact_id IS NULL) AND NOT EXISTS (
         SELECT 1 FROM contacts c WHERE c.id = NEW.contact_id AND c.company_id = NEW.company_id AND contact_fits(NEW.type, c)) THEN
      RAISE EXCEPTION 'Choose a customer or supplier of this company.';
    END IF;
    IF NEW.paid_from_account_id IS DISTINCT FROM OLD.paid_from_account_id AND NEW.paid_from_account_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM accounts WHERE id = NEW.paid_from_account_id AND company_id = NEW.company_id AND is_bank) THEN
      RAISE EXCEPTION 'Choose one of this company''s bank or cash accounts.';
    END IF;
    NEW.submitted_by := OLD.submitted_by; NEW.submitted_at := OLD.submitted_at;
    NEW.decided_by := OLD.decided_by; NEW.decided_at := OLD.decided_at; NEW.rejection_reason := OLD.rejection_reason;
    RETURN NEW;
  END IF;

  -- Claims: draft -> submitted -> approved (issued, posted) or rejected; submitted -> draft (withdrawn); rejected -> draft.
  IF NEW.type = 'claim' THEN
    IF (to_jsonb(NEW) - ARRAY['status','number','journal_entry_id','issued_by','issued_at','submitted_by','submitted_at',
                              'decided_by','decided_at','rejection_reason'])
       <> (to_jsonb(OLD) - ARRAY['status','number','journal_entry_id','issued_by','issued_at','submitted_by','submitted_at',
                                 'decided_by','decided_at','rejection_reason']) THEN
      RAISE EXCEPTION 'A submitted claim cannot be changed. Withdraw it to a draft first.';
    END IF;
    IF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
      PERFORM check_document_complete(NEW);
      NEW.submitted_by := coalesce(who, NEW.created_by); NEW.submitted_at := now();
      NEW.decided_by := NULL; NEW.decided_at := NULL; NEW.rejection_reason := NULL;
      RETURN NEW;
    ELSIF OLD.status IN ('submitted', 'rejected') AND NEW.status = 'draft' THEN
      NEW.submitted_by := NULL; NEW.submitted_at := NULL; NEW.decided_by := NULL; NEW.decided_at := NULL;
      NEW.journal_entry_id := NULL;
      RETURN NEW;
    ELSIF OLD.status = 'submitted' AND NEW.status IN ('issued', 'rejected') THEN
      IF who IS NOT NULL AND who = OLD.submitted_by THEN
        RAISE EXCEPTION 'You submitted this claim, so someone else must approve or reject it.';
      END IF;
      NEW.decided_by := coalesce(who, OLD.created_by); NEW.decided_at := now();
      IF NEW.status = 'rejected' THEN
        IF btrim(coalesce(NEW.rejection_reason, '')) = '' THEN
          RAISE EXCEPTION 'Give a reason for rejecting the claim.';
        END IF;
        RETURN NEW;
      END IF;
      SELECT * INTO e FROM journal_entries WHERE id = NEW.journal_entry_id;
      IF e.id IS NULL OR e.source_id IS DISTINCT FROM NEW.id OR e.company_id <> NEW.company_id OR e.entry_date <> NEW.issue_date THEN
        RAISE EXCEPTION 'An approved claim needs its own posted journal entry.';
      END IF;
      NEW.issued_at := now(); NEW.issued_by := NEW.decided_by;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'This claim cannot move from % to %.', OLD.status, NEW.status;
  END IF;

  -- Issuing (recording) an invoice, credit note, bill, supplier credit or expense
  IF NEW.type <> 'quotation' AND OLD.status = 'draft' AND NEW.status = 'issued' THEN
    PERFORM check_document_complete(NEW);
    IF NEW.type = 'expense' AND NEW.paid_from_account_id IS NULL THEN
      RAISE EXCEPTION 'Choose the bank or cash account the expense was paid from.';
    END IF;
    IF NEW.type = 'expense' AND NEW.contact_id IS NULL AND btrim(coalesce(NEW.payee, '')) = '' THEN
      RAISE EXCEPTION 'Enter who was paid (a supplier or a payee name).';
    END IF;
    SELECT * INTO e FROM journal_entries WHERE id = NEW.journal_entry_id;
    IF e.id IS NULL OR e.source_id IS DISTINCT FROM NEW.id OR e.company_id <> NEW.company_id OR e.entry_date <> NEW.issue_date THEN
      RAISE EXCEPTION 'An issued document needs its own posted journal entry.';
    END IF;
    IF NEW.type IN ('credit_note', 'supplier_credit') THEN
      SELECT * INTO orig FROM documents WHERE id = NEW.original_id;
      SELECT coalesce(sum(gross_total), 0) INTO credited FROM documents
      WHERE original_id = NEW.original_id AND type = NEW.type AND status = 'issued' AND id <> NEW.id;
      IF credited + NEW.gross_total > orig.gross_total THEN
        RAISE EXCEPTION 'A credit note cannot be more than what is left on the original (%).', orig.gross_total - credited;
      END IF;
    END IF;
    NEW.issued_at := now();
    NEW.issued_by := coalesce(who, NEW.created_by);
    RETURN NEW;
  END IF;

  -- Voiding a recorded expense: only the void fields change, and the void entry reverses the original.
  IF NEW.type = 'expense' AND OLD.status = 'issued' AND NEW.status = 'voided' THEN
    IF (to_jsonb(NEW) - 'status' - 'voided_at' - 'void_entry_id') <> (to_jsonb(OLD) - 'status' - 'voided_at' - 'void_entry_id')
       OR NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.void_entry_id AND reverses_entry_id = OLD.journal_entry_id) THEN
      RAISE EXCEPTION 'A recorded expense is voided with a reversing entry and nothing else changes.';
    END IF;
    RETURN NEW;
  END IF;

  -- Quotations: draft -> sent / accepted / declined -> invoiced. Nothing else changes once sent.
  IF NEW.type = 'quotation' THEN
    IF OLD.status = 'draft' THEN
      PERFORM check_document_complete(NEW);
    ELSIF (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status') THEN
      RAISE EXCEPTION 'A sent quotation cannot be changed. Create a new one instead.';
    END IF;
    IF (OLD.status, NEW.status) IN (('draft','sent'), ('draft','accepted'), ('draft','declined'), ('sent','accepted'),
                                    ('sent','declined'), ('accepted','invoiced'), ('sent','invoiced'), ('declined','accepted')) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'This quotation cannot move from % to %.', OLD.status, NEW.status;
  END IF;

  RAISE EXCEPTION 'Issued documents are never changed. Use a credit note to correct one.';
END $$;

-- Lines of a submitted claim are frozen too (only drafts change).
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
  IF doc_side(d.type) = 'sales' AND a.type <> 'income' THEN
    RAISE EXCEPTION 'Sales lines use an income account.';
  ELSIF doc_side(d.type) = 'purchases' AND a.type NOT IN ('expense', 'asset') THEN
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
-- What is due now includes approved claims; payments made can reimburse employees.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION document_amount_due(p_doc uuid) RETURNS numeric
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN d.type IN ('invoice', 'bill', 'claim') AND d.status = 'issued' THEN
    d.gross_total
    - coalesce((SELECT sum(a.amount) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                WHERE a.document_id = d.id AND p.voided_at IS NULL), 0)
    - coalesce((SELECT sum(c.gross_total) FROM documents c
                WHERE c.original_id = d.id AND c.type IN ('credit_note', 'supplier_credit') AND c.status = 'issued'), 0)
  ELSE 0 END
  FROM documents d WHERE d.id = p_doc
$$;

CREATE OR REPLACE FUNCTION before_payment_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c contacts%ROWTYPE; e journal_entries%ROWTYPE;
BEGIN
  IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  NEW.created_at := now(); NEW.created_xact := pg_current_xact_id();
  NEW.voided_at := NULL; NEW.void_entry_id := NULL;
  SELECT * INTO c FROM contacts WHERE id = NEW.contact_id;
  IF c.company_id IS DISTINCT FROM NEW.company_id
     OR (NEW.direction = 'received' AND NOT c.is_customer)
     OR (NEW.direction = 'made' AND NOT (c.is_supplier OR c.is_employee)) THEN
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

CREATE OR REPLACE FUNCTION before_allocation_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p payments%ROWTYPE; d documents%ROWTYPE; used numeric;
BEGIN
  SELECT * INTO p FROM payments WHERE id = NEW.payment_id;
  IF p.created_xact <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'Payments are never changed. Void the payment instead.';
  END IF;
  SELECT * INTO d FROM documents WHERE id = NEW.document_id;
  IF d.company_id IS DISTINCT FROM p.company_id OR d.contact_id <> p.contact_id OR d.status <> 'issued'
     OR (p.direction = 'received' AND d.type <> 'invoice') OR (p.direction = 'made' AND d.type NOT IN ('bill', 'claim')) THEN
    RAISE EXCEPTION 'A payment can only settle issued invoices (or bills) of the same customer (or supplier).';
  END IF;
  IF NEW.amount > document_amount_due(d.id) THEN
    RAISE EXCEPTION 'This is more than is due on % (%).', d.number, document_amount_due(d.id);
  END IF;
  SELECT coalesce(sum(amount), 0) INTO used FROM payment_allocations WHERE payment_id = p.id;
  IF used + NEW.amount > p.amount THEN
    RAISE EXCEPTION 'The amounts settled are more than the payment.';
  END IF;
  RETURN NEW;
END $$;
