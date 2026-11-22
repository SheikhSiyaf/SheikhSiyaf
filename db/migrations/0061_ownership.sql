-- 0061 Ownership: owners, partners and shareholders, their shares and percentages by date, and the money between them
-- and the company. Everything posts through the ordinary ledger; these tables only say who and how much.
--   Capital contribution:  Dr bank              Cr owner's capital account (equity, 32xx)
--   Drawing:               Dr owner's current account (33xx)   Cr bank
--   Profit split:          Dr 3100 Retained earnings           Cr each partner's current account (by percent)
--   Dividend declared:     Dr 3100 Retained earnings           Cr 2170 Dividends payable
--   Dividend paid:         Dr 2170 Dividends payable           Cr bank
-- The accounts are created by the service when an owner is added (the same way 3100 is created at year end), so no
-- chart rows are inserted here.

CREATE TABLE owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL CHECK (btrim(name) <> ''),
  name_ar text,
  id_number text,
  email text,
  phone text,
  capital_account_id uuid NOT NULL REFERENCES accounts(id),
  current_account_id uuid NOT NULL REFERENCES accounts(id),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX owners_company ON owners (company_id, created_at);

-- One row per owner per effective date. A change of ownership is a new set of rows from its date; the earlier rows
-- stay, so every past date still has the percentages that applied then.
CREATE TABLE ownership_holdings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  owner_id uuid NOT NULL REFERENCES owners(id),
  effective_from date NOT NULL,
  shares numeric(18,4) CHECK (shares IS NULL OR shares >= 0),
  percent numeric(7,4) NOT NULL CHECK (percent >= 0 AND percent <= 100),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, effective_from)
);
CREATE INDEX ownership_holdings_company ON ownership_holdings (company_id, effective_from);

-- Money between an owner and the company. Never changed or deleted: a correction is a reversal row that points back.
CREATE TABLE owner_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  owner_id uuid NOT NULL REFERENCES owners(id),
  kind text NOT NULL CHECK (kind IN ('contribution', 'drawing', 'profit_allocation', 'dividend_declared', 'dividend_paid')),
  entry_date date NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  account_id uuid REFERENCES accounts(id),
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id),
  reverses_id uuid REFERENCES owner_transactions(id),
  memo text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX owner_transactions_owner ON owner_transactions (owner_id, entry_date);
CREATE INDEX owner_transactions_entry ON owner_transactions (journal_entry_id);
CREATE UNIQUE INDEX owner_transactions_one_reversal ON owner_transactions (reverses_id) WHERE reverses_id IS NOT NULL;

CREATE FUNCTION before_owner_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An owner is never deleted. Mark the owner as no longer active.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.capital_account_id AND company_id = NEW.company_id AND type = 'equity')
     OR NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.current_account_id AND company_id = NEW.company_id AND type = 'equity') THEN
    RAISE EXCEPTION 'An owner''s accounts must be equity accounts of this company.';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.company_id <> OLD.company_id OR NEW.capital_account_id <> OLD.capital_account_id OR NEW.current_account_id <> OLD.current_account_id) THEN
    RAISE EXCEPTION 'An owner stays with the same company and the same accounts.';
  END IF;
  IF TG_OP = 'INSERT' AND app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER owners_before_change BEFORE INSERT OR UPDATE OR DELETE ON owners FOR EACH ROW EXECUTE FUNCTION before_owner_change();

CREATE FUNCTION before_holding_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM owners WHERE id = NEW.owner_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'That owner belongs to a different company.';
  END IF;
  IF TG_OP = 'INSERT' AND app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ownership_holdings_before_change BEFORE INSERT OR UPDATE OR DELETE ON ownership_holdings FOR EACH ROW EXECUTE FUNCTION before_holding_change();

CREATE FUNCTION before_owner_transaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r owner_transactions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'An owner movement is never changed. Reverse it instead.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM owners WHERE id = NEW.owner_id AND company_id = NEW.company_id) THEN RAISE EXCEPTION 'That owner belongs to a different company.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.journal_entry_id AND company_id = NEW.company_id) THEN RAISE EXCEPTION 'That entry belongs to a different company.'; END IF;
  IF NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND company_id = NEW.company_id AND is_bank) THEN
    RAISE EXCEPTION 'Choose a bank or cash account of this company.';
  END IF;
  IF NEW.reverses_id IS NOT NULL THEN
    SELECT * INTO r FROM owner_transactions WHERE id = NEW.reverses_id;
    IF NOT FOUND OR r.company_id <> NEW.company_id OR r.owner_id <> NEW.owner_id OR r.kind <> NEW.kind OR r.amount <> NEW.amount OR r.reverses_id IS NOT NULL THEN
      RAISE EXCEPTION 'A reversal must match the movement it reverses.';
    END IF;
  END IF;
  IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER owner_transactions_before_change BEFORE INSERT OR UPDATE OR DELETE ON owner_transactions FOR EACH ROW EXECUTE FUNCTION before_owner_transaction();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['owners', 'ownership_holdings', 'owner_transactions'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_insert', t);
  END LOOP;
END $$;
CREATE POLICY owners_update ON owners FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY ownership_holdings_update ON ownership_holdings FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY ownership_holdings_delete ON ownership_holdings FOR DELETE USING (app_has_role(company_id, posting_roles()));
GRANT SELECT, INSERT, UPDATE ON owners TO nusuh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ownership_holdings TO nusuh_app;
GRANT SELECT, INSERT ON owner_transactions TO nusuh_app;

-- Job titles may give access to Ownership (shares, capital, drawings and dividends are sensitive).
CREATE OR REPLACE FUNCTION before_client_role_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE k text; v text;
BEGIN
  FOR k, v IN SELECT * FROM jsonb_each_text(NEW.permissions) LOOP
    IF k NOT IN ('Sales', 'Purchases', 'Expenses', 'Bank', 'Inventory', 'Restaurant', 'Assets', 'Rentals', 'Rooms', 'Projects', 'HRM', 'CRM', 'Journal', 'Ledger', 'Ownership', 'Reports')
       OR v NOT IN ('none', 'view', 'edit') THEN
      RAISE EXCEPTION 'Unknown module or access level in a role: % = %.', k, v;
    END IF;
  END LOOP;
  IF TG_OP = 'UPDATE' AND NEW.firm_id <> OLD.firm_id THEN RAISE EXCEPTION 'A role stays with its firm.'; END IF;
  RETURN NEW;
END $$;

-- Each existing job title gets Ownership at the level it has for Ledger; new customers' default roles include it.
UPDATE client_roles SET permissions = permissions || jsonb_build_object('Ownership', permissions->'Ledger')
WHERE permissions ? 'Ledger' AND NOT permissions ? 'Ownership';
CREATE OR REPLACE FUNCTION add_default_client_roles(p_firm uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO client_roles (firm_id, name, name_ar, description, permissions, can_approve, default_for)
  SELECT p_firm, v.name, v.name_ar, v.description,
         (SELECT jsonb_object_agg(m, v.level) FROM unnest(ARRAY['Sales', 'Purchases', 'Expenses', 'Bank', 'Inventory', 'Restaurant', 'Assets', 'Rentals', 'Rooms', 'Projects',
                                                         'HRM', 'CRM', 'Journal', 'Ledger', 'Ownership', 'Reports']) m),
         v.can_approve, v.default_for::user_role
  FROM (VALUES ('Client accountant', 'محاسب العميل', 'Daily entry in every module the client has', 'edit', true, 'client_accountant', 1),
               ('Client management', 'إدارة العميل', 'Sees everything, changes nothing', 'view', false, 'client_viewer', 2)) v(name, name_ar, description, level, can_approve, default_for, ord)
  ORDER BY v.ord
  ON CONFLICT DO NOTHING
$$;
