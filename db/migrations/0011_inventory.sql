-- 0011: Inventory with goods received notes (GRN, inbound) and goods delivery notes (GDN, outbound).
--   * Stock is valued at weighted average cost (PRODUCT_SPEC: "quantity, average cost").
--   * An item's quantity and value change only when a GRN or GDN is posted, never directly.
--   * Posting a GRN:  Dr 1300 Inventory / Cr 2050 Goods received not yet billed (or another liability or
--     equity account, e.g. 3000 for opening stock). The supplier's bill then uses 2050, which clears it.
--   * Posting a GDN:  Dr 5000 Cost of sales (or another expense account, e.g. for damaged stock) / Cr 1300 Inventory,
--     at the average cost: value = round(stock value x quantity / stock quantity, 2); all the value when all the stock goes.
--   * Stock never goes below zero. Posted notes never change; a mistake is corrected with another note.

INSERT INTO accounts (company_id, code, name, name_ar, type)
SELECT c.id, v.code, v.name, v.name_ar, v.type::account_type
FROM companies c CROSS JOIN (VALUES
  ('1300', 'Inventory', 'المخزون', 'asset'),
  ('2050', 'Goods received not yet billed', 'بضائع مستلمة لم تصل فواتيرها', 'liability')) v(code, name, name_ar, type)
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id)
ON CONFLICT (company_id, code) DO NOTHING;

-- Purchase lines may also use 2050, so the supplier's bill for goods already received clears it.
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
-- Items
-- ---------------------------------------------------------------------------
CREATE TABLE items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  sku           text NOT NULL CHECK (btrim(sku) <> ''),
  name          text NOT NULL CHECK (btrim(name) <> ''),
  name_ar       text,
  unit          text NOT NULL DEFAULT 'pcs',
  sale_price    numeric(18,2) CHECK (sale_price IS NULL OR sale_price >= 0),
  reorder_level numeric(18,3) CHECK (reorder_level IS NULL OR reorder_level >= 0),
  qty_on_hand   numeric(18,3) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  value_on_hand numeric(18,2) NOT NULL DEFAULT 0 CHECK (value_on_hand >= 0),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, sku),
  CHECK (qty_on_hand > 0 OR value_on_hand = 0)
);

CREATE FUNCTION before_item_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now(); NEW.qty_on_hand := 0; NEW.value_on_hand := 0;   -- stock comes in with a GRN
    RETURN NEW;
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'An item stays with its company.';
  END IF;
  IF (NEW.qty_on_hand <> OLD.qty_on_hand OR NEW.value_on_hand <> OLD.value_on_hand) AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Stock changes only through goods received and goods delivery notes.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER items_before_change BEFORE INSERT OR UPDATE ON items FOR EACH ROW EXECUTE FUNCTION before_item_change();
CREATE TRIGGER items_no_delete BEFORE DELETE ON items FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Goods notes
-- ---------------------------------------------------------------------------
CREATE TABLE stock_notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  type             text NOT NULL CHECK (type IN ('grn', 'gdn')),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
  number           text,
  note_date        date NOT NULL,
  contact_id       uuid REFERENCES contacts(id),
  reference        text,
  notes            text,
  other_account_id uuid NOT NULL REFERENCES accounts(id),   -- GRN: the credit side; GDN: the debit side
  total_value      numeric(18,2) NOT NULL DEFAULT 0 CHECK (total_value >= 0),
  journal_entry_id uuid UNIQUE REFERENCES journal_entries(id),
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  posted_by        uuid REFERENCES users(id),
  posted_at        timestamptz,
  UNIQUE (company_id, type, number),
  CHECK ((status = 'draft') = (number IS NULL))
);

CREATE TABLE stock_note_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  note_id        uuid NOT NULL REFERENCES stock_notes(id),
  line_no        int NOT NULL CHECK (line_no > 0),
  item_id        uuid NOT NULL REFERENCES items(id),
  quantity       numeric(18,3) NOT NULL CHECK (quantity > 0),
  unit_cost      numeric(18,2) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  value          numeric(18,2) NOT NULL DEFAULT 0 CHECK (value >= 0),
  cost_centre_id uuid REFERENCES cost_centres(id),
  UNIQUE (note_id, line_no)
);
CREATE INDEX stock_note_lines_item ON stock_note_lines (item_id);

CREATE FUNCTION check_stock_note_head(n stock_notes) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a accounts%ROWTYPE;
BEGIN
  IF n.contact_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM contacts WHERE id = n.contact_id AND company_id = n.company_id
         AND ((n.type = 'grn' AND is_supplier) OR (n.type = 'gdn' AND is_customer))) THEN
    RAISE EXCEPTION 'Choose a supplier (goods received) or a customer (goods delivered) of this company.';
  END IF;
  SELECT * INTO a FROM accounts WHERE id = n.other_account_id;
  IF a.company_id IS DISTINCT FROM n.company_id OR a.code = '1300'
     OR (n.type = 'grn' AND a.type NOT IN ('liability', 'equity'))
     OR (n.type = 'gdn' AND a.type <> 'expense') THEN
    RAISE EXCEPTION 'Goods received are credited to a liability or equity account; goods delivered are charged to an expense account.';
  END IF;
END $$;

CREATE FUNCTION before_stock_note_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l stock_note_lines%ROWTYPE; it items%ROWTYPE; expected numeric; total numeric := 0; n int := 0;
        inv uuid; inv_amount numeric; e journal_entries%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'Posted goods notes are never changed. Record a new note to correct one.'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'New goods notes start as drafts.'; END IF;
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now(); NEW.number := NULL; NEW.journal_entry_id := NULL; NEW.posted_by := NULL; NEW.posted_at := NULL; NEW.total_value := 0;
    PERFORM check_stock_note_head(NEW);
    RETURN NEW;
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.type <> OLD.type OR NEW.created_by <> OLD.created_by OR OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Posted goods notes are never changed. Record a new note to correct one.';
  END IF;
  PERFORM check_stock_note_head(NEW);
  IF NEW.status = 'draft' THEN
    IF NEW.journal_entry_id IS NOT NULL THEN RAISE EXCEPTION 'A draft has no journal entry yet.'; END IF;
    RETURN NEW;
  END IF;

  -- Posting: move the stock line by line, at cost (GRN) or at the average cost (GDN).
  FOR l IN SELECT * FROM stock_note_lines WHERE note_id = NEW.id ORDER BY line_no LOOP
    n := n + 1;
    SELECT * INTO it FROM items WHERE id = l.item_id FOR UPDATE;
    IF it.company_id <> NEW.company_id THEN RAISE EXCEPTION 'This item belongs to a different company.'; END IF;
    IF NEW.type = 'grn' THEN
      UPDATE items SET qty_on_hand = qty_on_hand + l.quantity, value_on_hand = value_on_hand + l.value WHERE id = it.id;
    ELSE
      IF l.quantity > it.qty_on_hand THEN
        RAISE EXCEPTION 'Not enough stock of % (%): % in stock, % to deliver.', it.name, it.sku, it.qty_on_hand, l.quantity;
      END IF;
      expected := CASE WHEN l.quantity = it.qty_on_hand THEN it.value_on_hand ELSE round(it.value_on_hand * l.quantity / it.qty_on_hand, 2) END;
      IF l.value <> expected THEN
        RAISE EXCEPTION 'The cost of % must be % (average cost).', it.name, expected;
      END IF;
      UPDATE items SET qty_on_hand = qty_on_hand - l.quantity, value_on_hand = value_on_hand - l.value WHERE id = it.id;
    END IF;
    total := total + l.value;
  END LOOP;
  IF n = 0 THEN RAISE EXCEPTION 'Add at least one item.'; END IF;
  IF NEW.total_value <> total THEN RAISE EXCEPTION 'The note total must equal its lines (%).', total; END IF;
  IF NEW.number IS NULL THEN RAISE EXCEPTION 'A posted note needs its number.'; END IF;

  -- The journal entry moves the same value in and out of 1300 Inventory.
  IF total = 0 THEN
    IF NEW.journal_entry_id IS NOT NULL THEN RAISE EXCEPTION 'A note with no value posts no entry.'; END IF;
  ELSE
    SELECT * INTO e FROM journal_entries WHERE id = NEW.journal_entry_id;
    SELECT id INTO inv FROM accounts WHERE company_id = NEW.company_id AND code = '1300';
    SELECT coalesce(sum(CASE WHEN NEW.type = 'grn' THEN debit - credit ELSE credit - debit END), 0) INTO inv_amount
      FROM journal_lines WHERE entry_id = NEW.journal_entry_id AND account_id = inv;
    IF e.id IS NULL OR e.source_id IS DISTINCT FROM NEW.id OR e.company_id <> NEW.company_id OR e.entry_date <> NEW.note_date OR inv_amount <> total THEN
      RAISE EXCEPTION 'A posted goods note needs its own journal entry for its value on 1300 Inventory.';
    END IF;
  END IF;
  NEW.posted_by := coalesce(app_user_id(), NEW.created_by);
  NEW.posted_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER stock_notes_before_change BEFORE INSERT OR UPDATE OR DELETE ON stock_notes
  FOR EACH ROW EXECUTE FUNCTION before_stock_note_change();

CREATE FUNCTION before_stock_line_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n stock_notes%ROWTYPE;
BEGIN
  SELECT * INTO n FROM stock_notes WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.note_id ELSE NEW.note_id END;
  IF n.status <> 'draft' THEN RAISE EXCEPTION 'Posted goods notes are never changed. Record a new note to correct one.'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.company_id <> n.company_id OR NOT EXISTS (SELECT 1 FROM items WHERE id = NEW.item_id AND company_id = n.company_id)
     OR (NEW.cost_centre_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cost_centres WHERE id = NEW.cost_centre_id AND company_id = n.company_id)) THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  IF n.type = 'grn' THEN
    IF NEW.unit_cost IS NULL THEN RAISE EXCEPTION 'Enter the cost per unit of goods received.'; END IF;
    IF NEW.value <> round(NEW.quantity * NEW.unit_cost, 2) THEN RAISE EXCEPTION 'Value must be quantity x cost per unit.'; END IF;
  ELSIF NEW.unit_cost IS NOT NULL THEN
    RAISE EXCEPTION 'Goods delivered go out at the average cost; no cost is entered.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_note_lines_before_change BEFORE INSERT OR UPDATE OR DELETE ON stock_note_lines
  FOR EACH ROW EXECUTE FUNCTION before_stock_line_change();

-- ---------------------------------------------------------------------------
-- Audit and row-level security
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['items', 'stock_notes', 'stock_note_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_update', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nusuh_app', t);
  END LOOP;
END $$;
CREATE POLICY stock_notes_delete ON stock_notes FOR DELETE USING (app_has_role(company_id, posting_roles()));
CREATE POLICY stock_note_lines_delete ON stock_note_lines FOR DELETE USING (app_has_role(company_id, posting_roles()));
GRANT DELETE ON stock_notes, stock_note_lines TO nusuh_app;
