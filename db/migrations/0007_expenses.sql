-- 0007: Expenses and recurring expenses.
--   * An expense is paid at once from a bank or cash account: Dr expense lines, Dr input VAT, Cr bank/cash.
--     It uses the same document layout and line checks as bills (0005). The supplier is optional;
--     a free-text payee can be used instead (e.g. a taxi or a shop with no supplier record).
--   * A recorded expense never changes. A mistake is voided: a reversing entry is posted and the
--     expense is marked voided (the original stays in the books and the audit log).
--   * Recurring expenses are templates. They create draft expenses on their dates, for a person to
--     check and record; nothing is posted automatically.

ALTER TABLE documents
  ADD COLUMN paid_from_account_id uuid REFERENCES accounts(id),
  ADD COLUMN payee text,
  ADD COLUMN recurring_id uuid,
  ADD COLUMN void_entry_id uuid REFERENCES journal_entries(id),
  ADD COLUMN voided_at timestamptz,
  ALTER COLUMN contact_id DROP NOT NULL;

ALTER TABLE documents DROP CONSTRAINT doc_status_by_type;
ALTER TABLE documents ADD CONSTRAINT doc_status_by_type CHECK (
  (type = 'quotation' AND status IN ('draft', 'sent', 'accepted', 'declined', 'invoiced')) OR
  (type = 'expense' AND status IN ('draft', 'issued', 'voided')) OR
  (type NOT IN ('quotation', 'expense') AND status IN ('draft', 'issued')));
ALTER TABLE documents DROP CONSTRAINT doc_original_by_type;
ALTER TABLE documents ADD CONSTRAINT doc_original_by_type CHECK (
  (type IN ('credit_note', 'supplier_credit') AND original_id IS NOT NULL) OR
  (type = 'invoice') OR
  (type IN ('quotation', 'bill', 'expense') AND original_id IS NULL));
ALTER TABLE documents ADD CONSTRAINT doc_contact_required CHECK (type = 'expense' OR contact_id IS NOT NULL);
ALTER TABLE documents ADD CONSTRAINT doc_expense_fields CHECK (
  type = 'expense' OR (paid_from_account_id IS NULL AND payee IS NULL AND recurring_id IS NULL));
ALTER TABLE documents ADD CONSTRAINT doc_void_fields CHECK ((voided_at IS NULL) = (void_entry_id IS NULL) AND (voided_at IS NULL OR status = 'voided'));

-- ---------------------------------------------------------------------------
-- Document rules, extended for expenses
-- ---------------------------------------------------------------------------
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
  IF NEW.contact_id IS NOT NULL OR NEW.type <> 'expense' THEN
    SELECT * INTO c FROM contacts WHERE id = NEW.contact_id;
    IF c.company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'This customer or supplier belongs to a different company.';
    END IF;
    IF doc_side(NEW.type) = 'sales' AND NOT c.is_customer THEN
      RAISE EXCEPTION 'Choose a customer for this document.';
    ELSIF doc_side(NEW.type) = 'purchases' AND NOT c.is_supplier THEN
      RAISE EXCEPTION 'Choose a supplier for this document.';
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
DECLARE credited numeric; orig documents%ROWTYPE; e journal_entries%ROWTYPE;
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.type <> OLD.type OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'Posted records cannot be changed or deleted. Post a reversal instead.';
  END IF;

  -- Editing a draft
  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    IF NEW.number IS NOT NULL OR NEW.journal_entry_id IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'A draft has no number or journal entry yet.';
    END IF;
    IF NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NOT (NEW.type = 'expense' AND NEW.contact_id IS NULL) AND NOT EXISTS (
         SELECT 1 FROM contacts c WHERE c.id = NEW.contact_id AND c.company_id = NEW.company_id
           AND ((doc_side(NEW.type) = 'sales' AND c.is_customer) OR (doc_side(NEW.type) = 'purchases' AND c.is_supplier))) THEN
      RAISE EXCEPTION 'Choose a customer or supplier of this company.';
    END IF;
    IF NEW.paid_from_account_id IS DISTINCT FROM OLD.paid_from_account_id AND NEW.paid_from_account_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM accounts WHERE id = NEW.paid_from_account_id AND company_id = NEW.company_id AND is_bank) THEN
      RAISE EXCEPTION 'Choose one of this company''s bank or cash accounts.';
    END IF;
    RETURN NEW;
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
    NEW.issued_by := coalesce(app_user_id(), NEW.created_by);
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

-- ---------------------------------------------------------------------------
-- Recurring expenses (templates; they never post on their own)
-- ---------------------------------------------------------------------------
CREATE TABLE recurring_expenses (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  name                 text NOT NULL CHECK (btrim(name) <> ''),
  contact_id           uuid REFERENCES contacts(id),
  payee                text,
  paid_from_account_id uuid NOT NULL REFERENCES accounts(id),
  frequency            text NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  next_date            date NOT NULL,
  anchor_day           smallint NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),   -- keeps "the 31st" at month end every month
  end_date             date,
  active               boolean NOT NULL DEFAULT true,
  lines                jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) > 0),
  reference            text,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= next_date OR NOT active),
  CHECK (contact_id IS NOT NULL OR btrim(coalesce(payee, '')) <> '')
);
CREATE INDEX recurring_expenses_company ON recurring_expenses (company_id, next_date);
ALTER TABLE documents ADD CONSTRAINT documents_recurring_fk FOREIGN KEY (recurring_id) REFERENCES recurring_expenses(id);

CREATE FUNCTION before_recurring_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  IF TG_OP = 'UPDATE' AND (NEW.company_id <> OLD.company_id OR NEW.created_by <> OLD.created_by) THEN
    RAISE EXCEPTION 'Posted records cannot be changed or deleted. Post a reversal instead.';
  END IF;
  IF NEW.contact_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM contacts WHERE id = NEW.contact_id AND company_id = NEW.company_id AND is_supplier) THEN
    RAISE EXCEPTION 'Choose a supplier of this company.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.paid_from_account_id AND company_id = NEW.company_id AND is_bank) THEN
    RAISE EXCEPTION 'Choose one of this company''s bank or cash accounts.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recurring_expenses_before_change BEFORE INSERT OR UPDATE ON recurring_expenses
  FOR EACH ROW EXECUTE FUNCTION before_recurring_change();
CREATE TRIGGER recurring_expenses_audit AFTER INSERT OR UPDATE OR DELETE ON recurring_expenses
  FOR EACH ROW EXECUTE FUNCTION audit_row();

ALTER TABLE recurring_expenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY recurring_read ON recurring_expenses FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY recurring_insert ON recurring_expenses FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY recurring_update ON recurring_expenses FOR UPDATE
  USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));
GRANT SELECT, INSERT, UPDATE ON recurring_expenses TO nusuh_app;
