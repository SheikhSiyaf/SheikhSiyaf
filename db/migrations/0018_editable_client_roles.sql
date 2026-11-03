-- 0018: Every client role is editable. "Client accountant" and "Client management" stop being fixed: each firm gets
-- them as ordinary roles in Roles and permissions (renamed, changed or archived like any other), and every client
-- user has a role. A client user added without one gets the firm's first active role with the same base
-- (anyone who enters = client_accountant, view only = client_viewer).

CREATE FUNCTION add_default_client_roles(p_firm uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO client_roles (firm_id, name, name_ar, description, permissions, can_approve)
  SELECT p_firm, v.name, v.name_ar, v.description,
         (SELECT jsonb_object_agg(m, v.level) FROM unnest(ARRAY['Sales', 'Purchases', 'Expenses', 'Bank', 'Inventory', 'Restaurant', 'Assets', 'Projects', 'HRM', 'CRM',
                                                         'Journal', 'Ledger', 'Reports']) m),
         v.can_approve
  FROM (VALUES ('Client accountant', 'محاسب العميل', 'Daily entry in every module the client has', 'edit', true, 1),
               ('Client management', 'إدارة العميل', 'Sees everything, changes nothing', 'view', false, 2)) v(name, name_ar, description, level, can_approve, ord)
  ORDER BY v.ord
  ON CONFLICT DO NOTHING
$$;

CREATE FUNCTION after_firm_insert_roles() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM add_default_client_roles(NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER firms_default_client_roles AFTER INSERT ON firms FOR EACH ROW EXECUTE FUNCTION after_firm_insert_roles();

SELECT add_default_client_roles(id) FROM firms;

-- A client user's membership always carries a role.
CREATE OR REPLACE FUNCTION before_membership_client_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r client_roles%ROWTYPE; u users%ROWTYPE;
BEGIN
  SELECT * INTO u FROM users WHERE id = NEW.user_id;
  IF NEW.client_role_id IS NULL THEN
    IF u.kind <> 'client' THEN RETURN NEW; END IF;
    SELECT id INTO NEW.client_role_id FROM client_roles
    WHERE firm_id = u.firm_id AND status = 'active' AND client_role_base(permissions) = NEW.role ORDER BY created_at, name LIMIT 1;
    IF NEW.client_role_id IS NULL THEN RETURN NEW; END IF;
  END IF;
  SELECT * INTO r FROM client_roles WHERE id = NEW.client_role_id;
  IF r.id IS NULL OR r.firm_id <> u.firm_id OR u.kind <> 'client' THEN
    RAISE EXCEPTION 'Client roles are for client users of the same firm.';
  END IF;
  NEW.role := client_role_base(r.permissions);
  RETURN NEW;
END $$;

UPDATE memberships m SET role = m.role FROM users u WHERE u.id = m.user_id AND u.kind = 'client' AND m.client_role_id IS NULL;   -- the trigger fills the role in
