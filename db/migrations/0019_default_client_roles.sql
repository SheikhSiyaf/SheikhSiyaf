-- 0019: The role a client user gets when added without one is chosen by a marker, not by name or creation time.
-- 0018 picked the oldest active role with the same base; roles created in the same transaction (a new firm with
-- its own roles) then tied and the first by name won (e.g. "Cashier" before "Client accountant"). The two roles
-- every firm starts with now carry default_for; they stay ordinary, editable roles.

ALTER TABLE client_roles ADD COLUMN default_for user_role CHECK (default_for IN ('client_accountant', 'client_viewer'));
CREATE UNIQUE INDEX client_roles_default_for ON client_roles (firm_id, default_for) WHERE default_for IS NOT NULL;

UPDATE client_roles SET default_for = 'client_accountant' WHERE name = 'Client accountant'
  AND id IN (SELECT DISTINCT ON (firm_id) id FROM client_roles WHERE name = 'Client accountant' ORDER BY firm_id, created_at);
UPDATE client_roles SET default_for = 'client_viewer' WHERE name = 'Client management'
  AND id IN (SELECT DISTINCT ON (firm_id) id FROM client_roles WHERE name = 'Client management' ORDER BY firm_id, created_at);

CREATE OR REPLACE FUNCTION add_default_client_roles(p_firm uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO client_roles (firm_id, name, name_ar, description, permissions, can_approve, default_for)
  SELECT p_firm, v.name, v.name_ar, v.description,
         (SELECT jsonb_object_agg(m, v.level) FROM unnest(ARRAY['Sales', 'Purchases', 'Expenses', 'Bank', 'Inventory', 'Restaurant', 'Assets', 'Projects', 'HRM', 'CRM',
                                                         'Journal', 'Ledger', 'Reports']) m),
         v.can_approve, v.default_for::user_role
  FROM (VALUES ('Client accountant', 'محاسب العميل', 'Daily entry in every module the client has', 'edit', true, 'client_accountant', 1),
               ('Client management', 'إدارة العميل', 'Sees everything, changes nothing', 'view', false, 'client_viewer', 2)) v(name, name_ar, description, level, can_approve, default_for, ord)
  ORDER BY v.ord
  ON CONFLICT DO NOTHING
$$;

CREATE OR REPLACE FUNCTION before_membership_client_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r client_roles%ROWTYPE; u users%ROWTYPE;
BEGIN
  SELECT * INTO u FROM users WHERE id = NEW.user_id;
  IF NEW.client_role_id IS NULL THEN
    IF u.kind <> 'client' THEN RETURN NEW; END IF;
    -- The firm's starting role for this base if it is still in use, otherwise the active role that covers the most modules.
    SELECT id INTO NEW.client_role_id FROM client_roles
    WHERE firm_id = u.firm_id AND status = 'active' AND client_role_base(permissions) = NEW.role
    ORDER BY (default_for = NEW.role) DESC NULLS LAST,
             (SELECT count(*) FROM jsonb_each_text(permissions) WHERE value <> 'none') DESC, created_at, name
    LIMIT 1;
    IF NEW.client_role_id IS NULL THEN RETURN NEW; END IF;
  END IF;
  SELECT * INTO r FROM client_roles WHERE id = NEW.client_role_id;
  IF r.id IS NULL OR r.firm_id <> u.firm_id OR u.kind <> 'client' THEN
    RAISE EXCEPTION 'Client roles are for client users of the same firm.';
  END IF;
  NEW.role := client_role_base(r.permissions);
  RETURN NEW;
END $$;
