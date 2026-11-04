-- 0034 Debit notes and purchase orders.
--
-- Debit note (sales): raises the amount an issued invoice charged (price increase, extra charges), points to that
-- invoice, posts like an invoice, is paid like one, and is reported to ZATCA as type 383.
-- Purchase order (purchases): an order to a supplier, numbered when sent; received, then turned into the bill
-- (the bill points back to it); never posted.

CREATE OR REPLACE FUNCTION doc_side(t doc_type) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t IN ('quotation', 'invoice', 'credit_note', 'debit_note') THEN 'sales' ELSE 'purchases' END
$$;
CREATE OR REPLACE FUNCTION contact_fits(t doc_type, c contacts) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t = 'claim' THEN c.is_employee
              WHEN t IN ('quotation', 'invoice', 'credit_note', 'debit_note') THEN c.is_customer
              ELSE c.is_supplier END
$$;

ALTER TABLE documents DROP CONSTRAINT doc_status_by_type;
ALTER TABLE documents ADD CONSTRAINT doc_status_by_type CHECK (
  (type = 'quotation' AND status IN ('draft', 'sent', 'accepted', 'declined', 'invoiced')) OR
  (type = 'purchase_order' AND status IN ('draft', 'sent', 'received', 'billed', 'cancelled')) OR
  (type = 'expense' AND status IN ('draft', 'issued', 'voided')) OR
  (type = 'claim' AND status IN ('draft', 'submitted', 'issued', 'rejected')) OR
  (type NOT IN ('quotation', 'purchase_order', 'expense', 'claim') AND status IN ('draft', 'issued')));
ALTER TABLE documents DROP CONSTRAINT doc_original_by_type;
ALTER TABLE documents ADD CONSTRAINT doc_original_by_type CHECK (
  (type IN ('credit_note', 'supplier_credit', 'debit_note') AND original_id IS NOT NULL) OR
  (type IN ('invoice', 'bill')) OR
  (type IN ('quotation', 'purchase_order', 'expense', 'claim') AND original_id IS NULL));

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
           OR (NEW.type = 'invoice' AND o.type = 'quotation')
           OR (NEW.type = 'debit_note' AND o.type = 'invoice' AND o.status = 'issued' AND o.contact_id = NEW.contact_id)
           OR (NEW.type = 'bill' AND o.type = 'purchase_order' AND o.contact_id = NEW.contact_id))) THEN
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

  -- Purchase orders: draft -> sent -> received -> billed (or cancelled). Nothing else changes once sent; no posting.
  IF NEW.type = 'purchase_order' THEN
    IF OLD.status = 'draft' THEN
      IF NEW.status <> 'cancelled' THEN PERFORM check_document_complete(NEW); END IF;
    ELSIF (to_jsonb(NEW) - 'status' - 'number') <> (to_jsonb(OLD) - 'status' - 'number') OR NEW.number IS DISTINCT FROM OLD.number THEN
      RAISE EXCEPTION 'A sent purchase order cannot be changed. Cancel it and make a new one.';
    END IF;
    IF NEW.journal_entry_id IS NOT NULL THEN RAISE EXCEPTION 'A purchase order is not posted.'; END IF;
    IF (OLD.status, NEW.status) IN (('draft','sent'), ('sent','received'), ('draft','received'), ('sent','billed'), ('received','billed'), ('draft','billed'),
                                    ('draft','cancelled'), ('sent','cancelled'), ('received','cancelled')) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'This purchase order cannot move from % to %.', OLD.status, NEW.status;
  END IF;

  -- Issuing (recording) an invoice, debit note, credit note, bill, supplier credit or expense
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
     OR (p.direction = 'received' AND d.type NOT IN ('invoice', 'debit_note')) OR (p.direction = 'made' AND d.type NOT IN ('bill', 'claim')) THEN
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

CREATE OR REPLACE FUNCTION document_amount_due(p_doc uuid) RETURNS numeric
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN d.type IN ('invoice', 'debit_note', 'bill', 'claim') AND d.status = 'issued' THEN
    d.gross_total
    - coalesce((SELECT sum(a.amount) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                WHERE a.document_id = d.id AND p.voided_at IS NULL), 0)
    - coalesce((SELECT sum(c.gross_total) FROM documents c
                WHERE c.original_id = d.id AND c.type IN ('credit_note', 'supplier_credit') AND c.status = 'issued'), 0)
  ELSE 0 END
  FROM documents d WHERE d.id = p_doc
$$;

CREATE OR REPLACE FUNCTION before_einvoice_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE dev einvoice_devices%ROWTYPE; doc documents%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO doc FROM documents WHERE id = NEW.document_id;
    IF doc.id IS NULL OR doc.company_id <> NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
    IF doc.status <> 'issued' OR doc.type NOT IN ('invoice', 'credit_note', 'debit_note') THEN RAISE EXCEPTION 'Only issued invoices, credit notes and debit notes are e-invoiced.'; END IF;
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now(); NEW.attempts := 0; NEW.submitted_at := NULL; NEW.cleared_xml := NULL; NEW.http_status := NULL;
    IF NEW.scheme = 'zatca' THEN
      -- The chain: each invoice takes the device's next counter and the hash of the one before.
      SELECT * INTO dev FROM einvoice_devices WHERE id = NEW.device_id FOR UPDATE;
      IF dev.id IS NULL OR dev.company_id <> NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
      IF dev.status <> 'active' THEN RAISE EXCEPTION 'This e-invoicing device is not active.'; END IF;
      IF NEW.icv <> dev.icv + 1 OR NEW.pih <> dev.last_hash THEN RAISE EXCEPTION 'The e-invoice chain moved on; prepare the invoice again.'; END IF;
      NEW.status := 'pending';
      UPDATE einvoice_devices SET icv = NEW.icv, last_hash = NEW.invoice_hash WHERE id = dev.id;
    ELSE
      NEW.status := 'ready';
    END IF;
    RETURN NEW;
  END IF;
  -- Only the authority's answer changes; a cleared or reported invoice is final.
  IF (to_jsonb(NEW) - 'status' - 'cleared_xml' - 'warnings' - 'errors' - 'http_status' - 'attempts' - 'submitted_at')
     <> (to_jsonb(OLD) - 'status' - 'cleared_xml' - 'warnings' - 'errors' - 'http_status' - 'attempts' - 'submitted_at') THEN
    RAISE EXCEPTION 'An e-invoice is never changed. Only the authority''s answer is recorded.';
  END IF;
  IF OLD.status IN ('cleared', 'reported', 'rejected') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'The authority has answered for this e-invoice; it is final.';
  END IF;
  RETURN NEW;
END $$;

DROP POLICY document_links_insert ON document_links;
CREATE POLICY document_links_insert ON document_links FOR INSERT WITH CHECK (company_id = ANY (app_company_ids())
  AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.company_id = company_id AND d.status <> 'draft' AND d.type IN ('invoice', 'credit_note', 'debit_note', 'quotation', 'purchase_order')));
