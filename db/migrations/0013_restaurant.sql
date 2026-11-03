-- 0013: Industry and modules per client; the Restaurant module (menu items with recipes, food sales).
--   * Each client has an industry. It sets which optional modules are turned on (a restaurant gets Restaurant
--     instead of Inventory); the Administrator can change the modules. Core modules are always on.
--   * A recipe is a menu item: its selling price (before VAT), VAT treatment, income account, and the materials
--     (stock items) one portion uses.
--   * A food sale is three linked records made in one step: an issued tax invoice, a goods delivery note that takes
--     the recipe materials out of stock at average cost (Dr 5000 Cost of sales / Cr 1300 Inventory), and, when paid at
--     once, the payment. restaurant_sales links them and never changes.

ALTER TABLE companies
  ADD COLUMN industry text NOT NULL DEFAULT 'other'
    CHECK (industry IN ('trading', 'retail', 'restaurant', 'services', 'construction', 'manufacturing', 'other')),
  ADD COLUMN modules text[] NOT NULL DEFAULT ARRAY['Inventory', 'Assets', 'Projects', 'HRM', 'CRM']
    CHECK (modules <@ ARRAY['Inventory', 'Restaurant', 'Assets', 'Projects', 'HRM', 'CRM']);

-- ---------------------------------------------------------------------------
-- Recipes (menu items)
-- ---------------------------------------------------------------------------
CREATE TABLE recipes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id),
  name              text NOT NULL CHECK (btrim(name) <> ''),
  name_ar           text,
  category          text,
  sale_price        numeric(18,2) NOT NULL CHECK (sale_price >= 0),
  vat_code          text NOT NULL DEFAULT 'standard' CHECK (vat_code IN ('standard', 'zero', 'exempt', 'out_of_scope')),
  income_account_id uuid NOT NULL REFERENCES accounts(id),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE recipe_lines (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  recipe_id  uuid NOT NULL REFERENCES recipes(id),
  item_id    uuid NOT NULL REFERENCES items(id),
  quantity   numeric(18,3) NOT NULL CHECK (quantity > 0),
  UNIQUE (recipe_id, item_id)
);

CREATE FUNCTION before_recipe_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now();
  ELSIF NEW.company_id <> OLD.company_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'A menu item stays with its company.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.income_account_id AND company_id = NEW.company_id AND type = 'income') THEN
    RAISE EXCEPTION 'Menu items are sold to an income account of this company.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recipes_before_change BEFORE INSERT OR UPDATE ON recipes FOR EACH ROW EXECUTE FUNCTION before_recipe_change();
CREATE TRIGGER recipes_no_delete BEFORE DELETE ON recipes FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION before_recipe_line_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM recipes WHERE id = NEW.recipe_id AND company_id = NEW.company_id)
     OR NOT EXISTS (SELECT 1 FROM items WHERE id = NEW.item_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recipe_lines_before_change BEFORE INSERT OR UPDATE OR DELETE ON recipe_lines FOR EACH ROW EXECUTE FUNCTION before_recipe_line_change();

-- ---------------------------------------------------------------------------
-- Food sales: invoice + materials used + payment, linked once
-- ---------------------------------------------------------------------------
CREATE TABLE restaurant_sales (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  document_id   uuid NOT NULL UNIQUE REFERENCES documents(id),
  stock_note_id uuid UNIQUE REFERENCES stock_notes(id),
  payment_id    uuid UNIQUE REFERENCES payments(id),
  method        text NOT NULL CHECK (method IN ('cash', 'card', 'bank_transfer', 'on_account')),
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((method = 'on_account') = (payment_id IS NULL))
);

CREATE FUNCTION before_restaurant_sale_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  NEW.created_at := now();
  IF NOT EXISTS (SELECT 1 FROM companies WHERE id = NEW.company_id AND 'Restaurant' = ANY (modules)) THEN
    RAISE EXCEPTION 'The Restaurant module is not turned on for this client.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND company_id = NEW.company_id AND type = 'invoice' AND status = 'issued') THEN
    RAISE EXCEPTION 'A food sale needs its issued tax invoice.';
  END IF;
  IF NEW.stock_note_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM stock_notes WHERE id = NEW.stock_note_id AND company_id = NEW.company_id AND type = 'gdn' AND status = 'posted') THEN
    RAISE EXCEPTION 'The materials used must be a posted goods delivery note of this company.';
  END IF;
  IF NEW.payment_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM payments p JOIN payment_allocations a ON a.payment_id = p.id
       WHERE p.id = NEW.payment_id AND p.company_id = NEW.company_id AND a.document_id = NEW.document_id) THEN
    RAISE EXCEPTION 'The payment must settle this sale''s invoice.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER restaurant_sales_before_insert BEFORE INSERT ON restaurant_sales FOR EACH ROW EXECUTE FUNCTION before_restaurant_sale_insert();
CREATE TRIGGER restaurant_sales_immutable BEFORE UPDATE OR DELETE ON restaurant_sales FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Audit and row-level security
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['recipes', 'recipe_lines', 'restaurant_sales'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_update', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nusuh_app', t);
  END LOOP;
END $$;
CREATE POLICY recipe_lines_delete ON recipe_lines FOR DELETE USING (app_has_role(company_id, posting_roles()));
GRANT DELETE ON recipe_lines TO nusuh_app;
