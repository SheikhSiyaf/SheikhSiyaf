-- 0081: the client home page as a dashboard of widgets.
-- dashboard_layouts holds the saved layouts: a person's own (scope 'user'), the default for a role (scope 'role') and the default for the
-- whole company (scope 'company'). The layout is a small JSON document (the shared period and the widgets in order, each with its size,
-- optional title, period and chart type); what it may contain is checked by the server (src/books/dashboardRules.ts), and anything a person
-- cannot see is left out when it is read. The figures themselves are never stored: they are worked out live from the posted entries.
CREATE TABLE dashboard_layouts (
  id             uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  company_id     uuid NOT NULL REFERENCES companies(id),
  scope          text NOT NULL CHECK (scope IN ('user', 'role', 'company')),
  user_id        uuid REFERENCES users(id),
  client_role_id uuid REFERENCES client_roles(id),
  layout         jsonb NOT NULL CHECK (jsonb_typeof(layout) = 'object' AND octet_length(layout::text) <= 30000),
  updated_by     uuid REFERENCES users(id),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'user' AND user_id IS NOT NULL AND client_role_id IS NULL)
      OR (scope = 'role' AND client_role_id IS NOT NULL AND user_id IS NULL)
      OR (scope = 'company' AND user_id IS NULL AND client_role_id IS NULL))
);
CREATE UNIQUE INDEX dashboard_layouts_user    ON dashboard_layouts (company_id, user_id) WHERE scope = 'user';
CREATE UNIQUE INDEX dashboard_layouts_role    ON dashboard_layouts (company_id, client_role_id) WHERE scope = 'role';
CREATE UNIQUE INDEX dashboard_layouts_company ON dashboard_layouts (company_id) WHERE scope = 'company';

CREATE FUNCTION before_dashboard_layout() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.company_id <> OLD.company_id OR NEW.scope <> OLD.scope
      OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.client_role_id IS DISTINCT FROM OLD.client_role_id) THEN
    RAISE EXCEPTION 'A saved layout keeps its company, kind, person and role.';
  END IF;
  -- a role's default can only be for a role of the company's own firm
  IF NEW.scope = 'role' AND NOT EXISTS (SELECT 1 FROM client_roles r JOIN companies c ON c.firm_id = r.firm_id WHERE r.id = NEW.client_role_id AND c.id = NEW.company_id) THEN
    RAISE EXCEPTION 'That role does not belong to this company.';
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := app_user_id();
  RETURN NEW;
END $$;
CREATE TRIGGER dashboard_layouts_before BEFORE INSERT OR UPDATE ON dashboard_layouts FOR EACH ROW EXECUTE FUNCTION before_dashboard_layout();

-- The role the caller holds in a company (for the default of that role), without opening the memberships table.
CREATE FUNCTION dashboard_my_role(p_company uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT client_role_id FROM memberships WHERE user_id = app_user_id() AND company_id = p_company
$$;
GRANT EXECUTE ON FUNCTION dashboard_my_role(uuid) TO nusuh_app;

-- Row-level security. A person reads and writes only their own layout. The company's and the roles' defaults are read by the members they
-- apply to and written only by the company's Administrator (who may not be a member: they never see the books), as with the checklist (0080).
ALTER TABLE dashboard_layouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY dashboard_layouts_read ON dashboard_layouts FOR SELECT USING (
  (scope = 'user' AND user_id = app_user_id() AND company_id = ANY (app_company_ids()))
  OR (scope = 'company' AND (company_id = ANY (app_company_ids()) OR checklist_admin_of(company_id)))
  OR (scope = 'role' AND ((company_id = ANY (app_company_ids()) AND client_role_id = dashboard_my_role(company_id)) OR checklist_admin_of(company_id))));
CREATE POLICY dashboard_layouts_insert ON dashboard_layouts FOR INSERT WITH CHECK (
  (scope = 'user' AND user_id = app_user_id() AND company_id = ANY (app_company_ids()))
  OR (scope IN ('role', 'company') AND checklist_admin_of(company_id)));
CREATE POLICY dashboard_layouts_update ON dashboard_layouts FOR UPDATE USING (
  (scope = 'user' AND user_id = app_user_id() AND company_id = ANY (app_company_ids()))
  OR (scope IN ('role', 'company') AND checklist_admin_of(company_id)))
  WITH CHECK ((scope = 'user' AND user_id = app_user_id() AND company_id = ANY (app_company_ids()))
  OR (scope IN ('role', 'company') AND checklist_admin_of(company_id)));
CREATE POLICY dashboard_layouts_delete ON dashboard_layouts FOR DELETE USING (
  (scope = 'user' AND user_id = app_user_id() AND company_id = ANY (app_company_ids()))
  OR (scope IN ('role', 'company') AND checklist_admin_of(company_id)));
GRANT SELECT, INSERT, UPDATE, DELETE ON dashboard_layouts TO nusuh_app;

-- Every change is audited.
CREATE TRIGGER dashboard_layouts_audit AFTER INSERT OR UPDATE OR DELETE ON dashboard_layouts FOR EACH ROW EXECUTE FUNCTION audit_row();
