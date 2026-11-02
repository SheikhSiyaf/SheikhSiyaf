-- 0005: Sales and purchases.
--   Customers and suppliers (contacts), quotations, tax invoices, credit notes, bills, supplier credits,
--   payments received and made, and how payments settle documents.
-- Rules enforced here (the app also checks them first, to prevent errors on screen):
--   * Each line's net = quantity x unit price and VAT = net x rate, both rounded to 2 decimals.
--   * Document totals equal the sum of their lines when issued.
--   * Issued invoices, credit notes, bills and supplier credits never change and are never deleted;
--     only drafts can be edited or deleted. Corrections use credit notes.
--   * An issued document always has a number (sequential per type) and a posted journal entry.
--   * A credit note never exceeds the invoice it corrects.
--   * Payments are never edited or deleted; a mistake is voided with a reversal entry.
--   * A payment only settles issued documents of the same company and contact, never beyond what is due.

-- ---------------------------------------------------------------------------
-- Bank and cash accounts (payments go in and out of these)
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN is_bank boolean NOT NULL DEFAULT false;
UPDATE accounts SET is_bank = true WHERE code = '1000';
INSERT INTO accounts (company_id, code, name, name_ar, type, is_bank)
SELECT c.id, '1010', 'Cash on hand', 'النقد في الصندوق', 'asset', true FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.code = '1010');
INSERT INTO accounts (company_id, code, name, name_ar, type)
SELECT c.id, '5400', 'Office and general expenses', 'مصروفات مكتبية وعامة', 'expense' FROM companies c
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.code = '5400');

CREATE OR REPLACE FUNCTION setup_company_books(p_company uuid, p_accounts jsonb, p_year int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m int;
BEGIN
  IF NOT app_is_admin() OR NOT EXISTS (SELECT 1 FROM companies WHERE id = p_company AND firm_id = app_firm_id()) THEN
    RAISE EXCEPTION 'Only the Administrator can set up a client''s books.';
  END IF;
  IF EXISTS (SELECT 1 FROM accounts WHERE company_id = p_company) THEN
    RAISE EXCEPTION 'This client''s books are already set up.';
  END IF;
  INSERT INTO accounts (company_id, code, name, name_ar, type, cost_centre_required, is_bank)
  SELECT p_company, a->>'code', a->>'name', a->>'nameAr', (a->>'type')::account_type,
         coalesce((a->>'costCentreRequired')::boolean, false), coalesce((a->>'bank')::boolean, false)
  FROM jsonb_array_elements(p_accounts) a;
  INSERT INTO cost_centres (company_id, kind, name, name_ar) VALUES (p_company, 'branch', 'Head office', 'المكتب الرئيسي');
  FOR m IN 1..12 LOOP
    INSERT INTO periods (company_id, start_date, end_date)
    VALUES (p_company, make_date(p_year, m, 1), (make_date(p_year, m, 1) + interval '1 month - 1 day')::date);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Customers and suppliers
-- ---------------------------------------------------------------------------
CREATE TABLE contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id),
  is_customer        boolean NOT NULL DEFAULT false,
  is_supplier        boolean NOT NULL DEFAULT false,
  name               text NOT NULL CHECK (btrim(name) <> ''),
  name_ar            text,
  vat_number         text,
  cr_number          text,
  email              text,
  phone              text,
  address            text,
  city               text,
  country            char(2),
  payment_terms_days integer CHECK (payment_terms_days BETWEEN 0 AND 365),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (is_customer OR is_supplier),
  CONSTRAINT contact_sa_vat CHECK (country IS DISTINCT FROM 'SA' OR vat_number IS NULL OR vat_number ~ '^3[0-9]{13}3$'),
  CONSTRAINT contact_ae_trn CHECK (country IS DISTINCT FROM 'AE' OR vat_number IS NULL OR vat_number ~ '^[0-9]{15}$')
);
CREATE INDEX contacts_company ON contacts (company_id, name);

-- ---------------------------------------------------------------------------
-- Documents: one layout for every country (e-invoicing adapters read from it later)
-- ---------------------------------------------------------------------------
CREATE TYPE doc_type AS ENUM ('quotation', 'invoice', 'credit_note', 'bill', 'supplier_credit');

CREATE TABLE documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  type             doc_type NOT NULL,
  status           text NOT NULL DEFAULT 'draft',
  number           text,
  contact_id       uuid NOT NULL REFERENCES contacts(id),
  issue_date       date NOT NULL,
  due_date         date,
  reference        text,           -- the customer's PO, or the supplier's own bill number
  notes            text,
  original_id      uuid REFERENCES documents(id),   -- credit note -> invoice, supplier credit -> bill, invoice <- quotation
  journal_entry_id uuid REFERENCES journal_entries(id),
  net_total        numeric(18,2) NOT NULL DEFAULT 0,
  vat_total        numeric(18,2) NOT NULL DEFAULT 0,
  gross_total      numeric(18,2) NOT NULL DEFAULT 0,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  issued_by        uuid REFERENCES users(id),
  issued_at        timestamptz,
  UNIQUE (company_id, type, number),
  CHECK (due_date IS NULL OR due_date >= issue_date),
  CONSTRAINT doc_status_by_type CHECK (
    (type = 'quotation' AND status IN ('draft', 'sent', 'accepted', 'declined', 'invoiced')) OR
    (type <> 'quotation' AND status IN ('draft', 'issued'))),
  CONSTRAINT doc_original_by_type CHECK (
    (type IN ('credit_note', 'supplier_credit') AND original_id IS NOT NULL) OR
    (type = 'invoice') OR
    (type IN ('quotation', 'bill') AND original_id IS NULL)),
  CONSTRAINT doc_totals_add_up CHECK (gross_total = net_total + vat_total AND net_total >= 0 AND vat_total >= 0)
);
CREATE INDEX documents_company_type ON documents (company_id, type, issue_date DESC);
CREATE INDEX documents_contact ON documents (contact_id);
CREATE INDEX documents_original ON documents (original_id);

CREATE TABLE document_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  line_no        integer NOT NULL,
  description    text NOT NULL CHECK (btrim(description) <> ''),
  quantity       numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price     numeric(18,2) NOT NULL CHECK (unit_price >= 0),
  account_id     uuid NOT NULL REFERENCES accounts(id),
  cost_centre_id uuid REFERENCES cost_centres(id),
  vat_code       text NOT NULL CHECK (vat_code IN ('standard', 'zero', 'exempt', 'out_of_scope')),
  vat_rate       numeric(5,2) NOT NULL CHECK (vat_rate >= 0 AND vat_rate <= 100),
  net_amount     numeric(18,2) NOT NULL,
  vat_amount     numeric(18,2) NOT NULL,
  UNIQUE (document_id, line_no),
  CONSTRAINT line_vat_code_rate CHECK (vat_code = 'standard' OR vat_rate = 0),
  -- round() on numeric rounds half away from zero, the same rule as src/vat/vat.ts
  CONSTRAINT line_net_is_qty_times_price CHECK (net_amount = round(quantity * unit_price, 2)),
  CONSTRAINT line_vat_is_net_times_rate CHECK (vat_amount = round(net_amount * vat_rate / 100, 2))
);

CREATE TABLE document_sequences (
  company_id uuid NOT NULL REFERENCES companies(id),
  type       text NOT NULL,          -- document type, or 'receipt' / 'payment'
  next_no    integer NOT NULL CHECK (next_no > 0),
  PRIMARY KEY (company_id, type)
);

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id               uuid PRIMARY KEY,           -- set by the app so the journal entry can point to it
  company_id       uuid NOT NULL REFERENCES companies(id),
  direction        text NOT NULL CHECK (direction IN ('received', 'made')),
  number           text NOT NULL,
  contact_id       uuid NOT NULL REFERENCES contacts(id),
  payment_date     date NOT NULL,
  amount           numeric(18,2) NOT NULL CHECK (amount > 0),
  account_id       uuid NOT NULL REFERENCES accounts(id),
  method           text NOT NULL CHECK (method IN ('bank_transfer', 'cash', 'card', 'cheque', 'other')),
  reference        text,
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id),
  voided_at        timestamptz,
  void_entry_id    uuid REFERENCES journal_entries(id),
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_xact     xid8 NOT NULL DEFAULT pg_current_xact_id(),
  UNIQUE (company_id, direction, number),
  CHECK ((voided_at IS NULL) = (void_entry_id IS NULL))
);
CREATE INDEX payments_company ON payments (company_id, direction, payment_date DESC);
CREATE INDEX payments_contact ON payments (contact_id);

CREATE TABLE payment_allocations (
  payment_id  uuid NOT NULL REFERENCES payments(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  amount      numeric(18,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (payment_id, document_id)
);
CREATE INDEX payment_allocations_document ON payment_allocations (document_id);

-- ---------------------------------------------------------------------------
-- What is still due on an invoice or bill: total - payments (not voided) - issued credits.
-- Negative means the customer or supplier is in credit.
-- ---------------------------------------------------------------------------
-- Runs with the caller's rights, so it only answers for documents the caller can see.
CREATE FUNCTION document_amount_due(p_doc uuid) RETURNS numeric
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN d.type IN ('invoice', 'bill') AND d.status = 'issued' THEN
    d.gross_total
    - coalesce((SELECT sum(a.amount) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                WHERE a.document_id = d.id AND p.voided_at IS NULL), 0)
    - coalesce((SELECT sum(c.gross_total) FROM documents c
                WHERE c.original_id = d.id AND c.type IN ('credit_note', 'supplier_credit') AND c.status = 'issued'), 0)
  ELSE 0 END
  FROM documents d WHERE d.id = p_doc
$$;

-- ---------------------------------------------------------------------------
-- Document rules
-- ---------------------------------------------------------------------------
CREATE FUNCTION doc_side(t doc_type) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t IN ('quotation', 'invoice', 'credit_note') THEN 'sales' ELSE 'purchases' END
$$;

CREATE FUNCTION before_document_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c contacts%ROWTYPE;
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'New documents start as drafts.';
  END IF;
  IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  NEW.created_at := now();
  NEW.number := NULL; NEW.journal_entry_id := NULL; NEW.issued_by := NULL; NEW.issued_at := NULL;
  SELECT * INTO c FROM contacts WHERE id = NEW.contact_id;
  IF c.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'This customer or supplier belongs to a different company.';
  END IF;
  IF doc_side(NEW.type) = 'sales' AND NOT c.is_customer THEN
    RAISE EXCEPTION 'Choose a customer for this document.';
  ELSIF doc_side(NEW.type) = 'purchases' AND NOT c.is_supplier THEN
    RAISE EXCEPTION 'Choose a supplier for this document.';
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
CREATE TRIGGER documents_before_insert BEFORE INSERT ON documents FOR EACH ROW EXECUTE FUNCTION before_document_insert();

-- Checks a document's lines and totals; used when it leaves draft.
CREATE FUNCTION check_document_complete(d documents) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int; s_net numeric; s_vat numeric;
BEGIN
  SELECT count(*), coalesce(sum(net_amount), 0), coalesce(sum(vat_amount), 0) INTO n, s_net, s_vat
  FROM document_lines WHERE document_id = d.id;
  IF n = 0 THEN RAISE EXCEPTION 'Add at least one line.'; END IF;
  IF d.net_total <> s_net OR d.vat_total <> s_vat THEN
    RAISE EXCEPTION 'The document totals do not match its lines.';
  END IF;
  IF d.number IS NULL THEN RAISE EXCEPTION 'The document needs a number.'; END IF;
  IF EXISTS (SELECT 1 FROM document_lines l JOIN accounts a ON a.id = l.account_id
             WHERE l.document_id = d.id AND a.cost_centre_required AND l.cost_centre_id IS NULL) THEN
    RAISE EXCEPTION 'A cost centre is required for one of the accounts used.';
  END IF;
END $$;

CREATE FUNCTION before_document_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE credited numeric; orig documents%ROWTYPE; e journal_entries%ROWTYPE;
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.type <> OLD.type OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'Posted records cannot be changed or deleted. Post a reversal instead.';
  END IF;

  -- Editing a draft
  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    IF NEW.number IS NOT NULL OR NEW.journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'A draft has no number or journal entry yet.';
    END IF;
    IF NEW.contact_id <> OLD.contact_id AND NOT EXISTS (
         SELECT 1 FROM contacts c WHERE c.id = NEW.contact_id AND c.company_id = NEW.company_id
           AND ((doc_side(NEW.type) = 'sales' AND c.is_customer) OR (doc_side(NEW.type) = 'purchases' AND c.is_supplier))) THEN
      RAISE EXCEPTION 'Choose a customer or supplier of this company.';
    END IF;
    RETURN NEW;
  END IF;

  -- Issuing an invoice, credit note, bill or supplier credit
  IF NEW.type <> 'quotation' AND OLD.status = 'draft' AND NEW.status = 'issued' THEN
    PERFORM check_document_complete(NEW);
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
CREATE TRIGGER documents_before_update BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION before_document_update();

CREATE FUNCTION before_document_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Issued documents are never changed. Use a credit note to correct one.';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER documents_before_delete BEFORE DELETE ON documents FOR EACH ROW EXECUTE FUNCTION before_document_delete();

CREATE FUNCTION before_document_line_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d documents%ROWTYPE; a accounts%ROWTYPE; rate numeric;
BEGIN
  SELECT * INTO d FROM documents WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
  IF d.id IS NULL THEN   -- the draft itself is being deleted
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
CREATE TRIGGER document_lines_before_change BEFORE INSERT OR UPDATE OR DELETE ON document_lines
  FOR EACH ROW EXECUTE FUNCTION before_document_line_change();

-- ---------------------------------------------------------------------------
-- Payment rules
-- ---------------------------------------------------------------------------
CREATE FUNCTION before_payment_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c contacts%ROWTYPE; e journal_entries%ROWTYPE;
BEGIN
  IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  NEW.created_at := now(); NEW.created_xact := pg_current_xact_id();
  NEW.voided_at := NULL; NEW.void_entry_id := NULL;
  SELECT * INTO c FROM contacts WHERE id = NEW.contact_id;
  IF c.company_id IS DISTINCT FROM NEW.company_id
     OR (NEW.direction = 'received' AND NOT c.is_customer) OR (NEW.direction = 'made' AND NOT c.is_supplier) THEN
    RAISE EXCEPTION 'Choose a customer (money received) or a supplier (money paid) of this company.';
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
CREATE TRIGGER payments_before_insert BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION before_payment_insert();

CREATE FUNCTION before_payment_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL
     AND (to_jsonb(NEW) - 'voided_at' - 'void_entry_id') = (to_jsonb(OLD) - 'voided_at' - 'void_entry_id')
     AND EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.void_entry_id AND reverses_entry_id = OLD.journal_entry_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Payments are never changed. Void the payment instead.';
END $$;
CREATE TRIGGER payments_before_update BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION before_payment_update();
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION before_allocation_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p payments%ROWTYPE; d documents%ROWTYPE; used numeric;
BEGIN
  SELECT * INTO p FROM payments WHERE id = NEW.payment_id;
  IF p.created_xact <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'Payments are never changed. Void the payment instead.';
  END IF;
  SELECT * INTO d FROM documents WHERE id = NEW.document_id;
  IF d.company_id IS DISTINCT FROM p.company_id OR d.contact_id <> p.contact_id OR d.status <> 'issued'
     OR (p.direction = 'received' AND d.type <> 'invoice') OR (p.direction = 'made' AND d.type <> 'bill') THEN
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
CREATE TRIGGER payment_allocations_before_insert BEFORE INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION before_allocation_insert();
CREATE TRIGGER payment_allocations_immutable BEFORE UPDATE OR DELETE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Audit: log every change to the new tables
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb; o jsonb; act text; cid uuid; rid text;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  o := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
  IF TG_TABLE_NAME = 'users' THEN   -- never copy secrets into the log
    r := r - 'password_hash' - 'totp_secret_enc' - 'invite_token_hash';
    o := o - 'password_hash' - 'totp_secret_enc' - 'invite_token_hash';
  END IF;

  act := lower(TG_OP);
  IF TG_TABLE_NAME = 'journal_entries' AND (r->>'reverses_entry_id') IS NOT NULL THEN
    act := 'reverse';
  ELSIF TG_TABLE_NAME = 'periods' AND TG_OP = 'UPDATE' THEN
    act := CASE WHEN (r->>'locked_at') IS NOT NULL AND (o->>'locked_at') IS NULL THEN 'lock'
                WHEN (r->>'locked_at') IS NULL AND (o->>'locked_at') IS NOT NULL THEN 'unlock'
                ELSE 'update' END;
  ELSIF TG_TABLE_NAME = 'documents' AND TG_OP = 'UPDATE' AND (o->>'status') <> (r->>'status') THEN
    act := CASE WHEN r->>'status' = 'issued' THEN 'issue' ELSE 'status' END;
  ELSIF TG_TABLE_NAME = 'payments' AND TG_OP = 'UPDATE' THEN
    act := 'void';
  END IF;

  cid := CASE TG_TABLE_NAME
           WHEN 'companies' THEN (r->>'id')::uuid
           WHEN 'users' THEN NULL
           WHEN 'firms' THEN NULL
           WHEN 'journal_lines' THEN (SELECT company_id FROM journal_entries WHERE id = (r->>'entry_id')::uuid)
           WHEN 'document_lines' THEN (SELECT company_id FROM documents WHERE id = (r->>'document_id')::uuid)
           WHEN 'payment_allocations' THEN (SELECT company_id FROM payments WHERE id = (r->>'payment_id')::uuid)
           ELSE (r->>'company_id')::uuid END;
  rid := coalesce(r->>'id',
                  CASE TG_TABLE_NAME
                    WHEN 'periods' THEN (r->>'company_id') || ':' || (r->>'start_date')
                    WHEN 'memberships' THEN (r->>'user_id') || ':' || (r->>'company_id')
                    WHEN 'payment_allocations' THEN (r->>'payment_id') || ':' || (r->>'document_id')
                    WHEN 'document_sequences' THEN (r->>'company_id') || ':' || (r->>'type') END);

  INSERT INTO audit_log (user_id, company_id, table_name, row_id, action, detail)
  VALUES (app_user_id(), cid, TG_TABLE_NAME, rid, act,
          CASE WHEN o IS NULL THEN jsonb_build_object('row', r)
               ELSE jsonb_build_object('before', o, 'after', r) END);
  RETURN NULL;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['contacts', 'documents', 'document_lines', 'document_sequences', 'payments', 'payment_allocations'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Row-level security: company members read; posting roles write
-- ---------------------------------------------------------------------------
ALTER TABLE contacts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_lines      ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_sequences  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY contacts_read   ON contacts FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY contacts_insert ON contacts FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY contacts_update ON contacts FOR UPDATE
  USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));

CREATE POLICY documents_read   ON documents FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY documents_insert ON documents FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY documents_update ON documents FOR UPDATE
  USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY documents_delete ON documents FOR DELETE USING (app_has_role(company_id, posting_roles()));

CREATE POLICY document_lines_read ON document_lines FOR SELECT
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id));
CREATE POLICY document_lines_write ON document_lines FOR ALL
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_has_role(d.company_id, posting_roles())))
  WITH CHECK (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND app_has_role(d.company_id, posting_roles())));

CREATE POLICY document_sequences_read ON document_sequences FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY document_sequences_write ON document_sequences FOR ALL
  USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));

CREATE POLICY payments_read   ON payments FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY payments_insert ON payments FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY payments_update ON payments FOR UPDATE
  USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));

CREATE POLICY payment_allocations_read ON payment_allocations FOR SELECT
  USING (EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id));
CREATE POLICY payment_allocations_insert ON payment_allocations FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_id AND app_has_role(p.company_id, posting_roles())));

GRANT SELECT, INSERT, UPDATE         ON contacts            TO nusuh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON documents           TO nusuh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON document_lines      TO nusuh_app;
GRANT SELECT, INSERT, UPDATE         ON document_sequences  TO nusuh_app;
GRANT SELECT, INSERT, UPDATE         ON payments            TO nusuh_app;
GRANT SELECT, INSERT                 ON payment_allocations TO nusuh_app;
GRANT EXECUTE ON FUNCTION document_amount_due(uuid) TO nusuh_app;
