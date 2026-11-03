-- 0016: P&L lines per account, and client roles with their access.
--   * Each income and expense account sits on one line of the profit and loss statement:
--       Sales (revenue) - Cost of sales = Gross profit - Indirect expenses + Indirect income = Net profit.
--     New accounts get a sensible line (5000 Cost of sales, 4900 and similar other income are indirect income);
--     the client can change it in the chart of accounts.
--   * Client roles: job titles the Administrator defines (e.g. Cashier, Store keeper, Purchaser), each with an
--     access level per module: none, view or edit, and whether it may approve expense claims. A client user is
--     given one of them. Their membership's base role follows from it (any "edit" = client_accountant, otherwise
--     client_viewer), so the database still refuses every write to a view-only person; the API checks each module.

ALTER TABLE accounts ADD COLUMN pnl_group text
  CHECK (pnl_group IN ('revenue', 'other_income', 'cost_of_sales', 'indirect_expense'));

CREATE FUNCTION before_account_pnl_group() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.type = 'income' THEN
    IF NEW.pnl_group IS NULL OR NEW.pnl_group NOT IN ('revenue', 'other_income') THEN
      NEW.pnl_group := CASE WHEN NEW.code >= '4800' THEN 'other_income' ELSE 'revenue' END;
    END IF;
  ELSIF NEW.type = 'expense' THEN
    IF NEW.pnl_group IS NULL OR NEW.pnl_group NOT IN ('cost_of_sales', 'indirect_expense') THEN
      NEW.pnl_group := CASE WHEN NEW.code = '5000' THEN 'cost_of_sales' ELSE 'indirect_expense' END;
    END IF;
  ELSE
    NEW.pnl_group := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_pnl_group BEFORE INSERT OR UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION before_account_pnl_group();
UPDATE accounts SET pnl_group = NULL WHERE type IN ('income', 'expense');   -- the trigger fills in the default line

-- ---------------------------------------------------------------------------
-- Client roles
-- ---------------------------------------------------------------------------
CREATE TABLE client_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES firms(id),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  name_ar     text,
  description text,
  -- {"Sales": "edit", "Reports": "view", ...}; a module not listed is "none".
  permissions jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(permissions) = 'object'),
  can_approve boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX client_roles_firm_name_key ON client_roles (firm_id, lower(btrim(name)));   -- "Cashier" and "cashier " are the same title

CREATE FUNCTION before_client_role_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE k text; v text;
BEGIN
  FOR k, v IN SELECT * FROM jsonb_each_text(NEW.permissions) LOOP
    IF k NOT IN ('Sales', 'Purchases', 'Expenses', 'Bank', 'Inventory', 'Restaurant', 'Assets', 'Projects', 'HRM', 'CRM', 'Journal', 'Ledger', 'Reports')
       OR v NOT IN ('none', 'view', 'edit') THEN
      RAISE EXCEPTION 'Unknown module or access level in a role: % = %.', k, v;
    END IF;
  END LOOP;
  IF TG_OP = 'UPDATE' AND NEW.firm_id <> OLD.firm_id THEN RAISE EXCEPTION 'A role stays with its firm.'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_roles_before_change BEFORE INSERT OR UPDATE ON client_roles FOR EACH ROW EXECUTE FUNCTION before_client_role_change();
CREATE TRIGGER client_roles_audit AFTER INSERT OR UPDATE OR DELETE ON client_roles FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER client_roles_no_delete BEFORE DELETE ON client_roles FOR EACH ROW EXECUTE FUNCTION forbid_change();

/** The base database role a client role gives: anyone who may edit something posts; otherwise view only. */
CREATE FUNCTION client_role_base(p jsonb) RETURNS user_role LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM jsonb_each_text(p) WHERE value = 'edit') THEN 'client_accountant'::user_role ELSE 'client_viewer'::user_role END
$$;

ALTER TABLE memberships ADD COLUMN client_role_id uuid REFERENCES client_roles(id);

CREATE FUNCTION before_membership_client_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r client_roles%ROWTYPE;
BEGIN
  IF NEW.client_role_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO r FROM client_roles WHERE id = NEW.client_role_id;
  IF r.id IS NULL OR r.firm_id <> (SELECT firm_id FROM users WHERE id = NEW.user_id)
     OR (SELECT kind FROM users WHERE id = NEW.user_id) <> 'client' THEN
    RAISE EXCEPTION 'Client roles are for client users of the same firm.';
  END IF;
  NEW.role := client_role_base(r.permissions);
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_client_role BEFORE INSERT OR UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION before_membership_client_role();

-- Only the Administrator changes a client user's role (the role and client role columns only).
CREATE POLICY memberships_admin_update ON memberships FOR UPDATE
  USING (app_is_admin() AND company_id IN (SELECT id FROM companies WHERE firm_id = app_firm_id()))
  WITH CHECK (app_is_admin() AND company_id IN (SELECT id FROM companies WHERE firm_id = app_firm_id()));
GRANT UPDATE (role, client_role_id) ON memberships TO nusuh_app;

-- When a role's access changes, its users' base role follows.
CREATE FUNCTION after_client_role_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE memberships SET role = client_role_base(NEW.permissions) WHERE client_role_id = NEW.id AND role <> client_role_base(NEW.permissions);
  RETURN NULL;
END $$;
CREATE TRIGGER client_roles_after_change AFTER UPDATE OF permissions ON client_roles FOR EACH ROW EXECUTE FUNCTION after_client_role_change();

/** The signed-in person's access in a company: their client role's modules, or NULL for full access by their role. */
CREATE FUNCTION app_client_role(p_company uuid) RETURNS TABLE (permissions jsonb, can_approve boolean, name text, name_ar text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.permissions, r.can_approve, r.name, r.name_ar FROM memberships m JOIN client_roles r ON r.id = m.client_role_id
  WHERE m.user_id = app_user_id() AND m.company_id = p_company
$$;
GRANT EXECUTE ON FUNCTION app_client_role(uuid) TO nusuh_app;

ALTER TABLE client_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_roles_read ON client_roles FOR SELECT USING (firm_id = app_firm_id());
CREATE POLICY client_roles_admin_insert ON client_roles FOR INSERT WITH CHECK (app_is_admin() AND firm_id = app_firm_id());
CREATE POLICY client_roles_admin_update ON client_roles FOR UPDATE USING (app_is_admin() AND firm_id = app_firm_id()) WITH CHECK (app_is_admin() AND firm_id = app_firm_id());
GRANT SELECT, INSERT, UPDATE ON client_roles TO nusuh_app;

-- The Administrator's activity page shows role changes too (same rules as 0004, with client_roles added).
CREATE OR REPLACE FUNCTION admin_activity(p_limit int DEFAULT 200)
RETURNS TABLE (id bigint, at timestamptz, actor text, table_name text, action text, company text, detail jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid := app_firm_id();
BEGIN
  IF NOT app_is_admin() THEN
    RAISE EXCEPTION 'Only the Administrator can do this.';
  END IF;
  RETURN QUERY
  SELECT a.id, a.at, u.full_name, a.table_name, a.action, c.name, a.detail
  FROM audit_log a
  LEFT JOIN users u ON u.id = a.user_id
  LEFT JOIN companies c ON c.id = coalesce(a.company_id, (coalesce(a.detail->'after', a.detail->'row')->>'company_id')::uuid)
  WHERE a.table_name IN ('companies', 'users', 'memberships', 'firms', 'client_roles')
    AND (c.firm_id = f
         OR (coalesce(a.detail->'after', a.detail->'row')->>'firm_id')::uuid = f
         OR (a.table_name = 'firms' AND a.row_id = f::text))
  ORDER BY a.id DESC
  LIMIT least(greatest(p_limit, 1), 500);
END $$;
