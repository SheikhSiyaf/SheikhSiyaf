-- 0063 One login for the owner of a company that runs its own books.
-- A customer of kind 'company' (a business, not an accounting firm) has no accounting firm and no separate Administrator:
-- its Owner is one person who sees the books and also manages the company's users and job titles. That is the new job
-- title right can_manage_users. It is honoured only for customers of kind 'company': in an accounting firm the
-- Administrator stays a separate person who never sees books (check_membership still refuses an Administrator as a books
-- user). The right gives the same powers an Administrator has inside the owner's own customer and nowhere else; adding a
-- company stays with Nusuh Books.

ALTER TABLE client_roles ADD COLUMN can_manage_users boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM users u JOIN firms f ON f.id = u.firm_id
                 WHERE u.id = app_user_id() AND u.kind = 'admin' AND u.status = 'active' AND f.status = 'active')
      OR app_acting_firm() IS NOT NULL
      OR EXISTS (SELECT 1 FROM users u
                 JOIN firms f ON f.id = u.firm_id AND f.kind = 'company' AND f.status = 'active'
                 JOIN memberships m ON m.user_id = u.id
                 JOIN client_roles r ON r.id = m.client_role_id AND r.firm_id = u.firm_id AND r.status = 'active' AND r.can_manage_users
                 WHERE u.id = app_user_id() AND u.kind = 'client' AND u.status = 'active')
$$;

-- The Owner title starts with the right; every other title without it.
UPDATE client_roles SET can_manage_users = true WHERE name = 'Owner' AND default_for IS NULL;

CREATE OR REPLACE FUNCTION add_default_client_roles(p_firm uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO client_roles (firm_id, name, name_ar, description, permissions, can_approve, default_for, can_manage_users)
  SELECT p_firm, v.name, v.name_ar, v.description,
         (SELECT jsonb_object_agg(k, coalesce(v.perm ->> k, v.base))
          FROM unnest(ARRAY['Sales', 'Purchases', 'Expenses', 'Bank', 'Inventory', 'Restaurant', 'Assets', 'Rentals', 'Rooms', 'Projects',
                            'HRM', 'CRM', 'Journal', 'Ledger', 'Ownership', 'OwnerReports', 'Reports']) k),
         v.can_approve, v.default_for::user_role, v.manages
  FROM (VALUES
    ('Client accountant', 'محاسب العميل', 'Daily entry in every module the client has, except the owner reports and ownership', 'edit', '{"Ownership":"none","OwnerReports":"none"}'::jsonb, true, 'client_accountant', false, 1),
    ('Client management', 'إدارة العميل', 'Sees everything, changes nothing', 'view', '{}'::jsonb, false, 'client_viewer', false, 2),
    ('Owner', 'المالك', 'Sees everything including the owner reports, records ownership money, approves; in a company that runs its own books also manages users and job titles', 'view', '{"Ownership":"edit"}'::jsonb, true, NULL, true, 3),
    ('Finance', 'المالية', 'The money side of every department and the finance reports; looks at payroll, stock and projects; approves', 'none',
      '{"Sales":"edit","Purchases":"edit","Expenses":"edit","Bank":"edit","Journal":"edit","Ledger":"edit","Assets":"edit","Reports":"edit","HRM":"view","Inventory":"view","Projects":"view","Restaurant":"view","Rentals":"view","Rooms":"view"}'::jsonb, true, NULL, false, 4),
    ('Sales', 'المبيعات', 'Customers, quotations, invoices, CRM and the selling side of rooms, restaurant and rentals', 'none',
      '{"Sales":"edit","CRM":"edit","Rooms":"edit","Restaurant":"edit","Rentals":"edit","Inventory":"view","Projects":"view"}'::jsonb, false, NULL, false, 5),
    ('Commercial', 'التجاري', 'Purchasing and stock: suppliers, purchase orders, bills, inventory, rentals and projects; looks at sales', 'none',
      '{"Purchases":"edit","Inventory":"edit","Rentals":"edit","Projects":"edit","Sales":"view"}'::jsonb, false, NULL, false, 6)
  ) v(name, name_ar, description, base, perm, can_approve, default_for, manages, ord)
  WHERE NOT EXISTS (SELECT 1 FROM client_roles r WHERE r.firm_id = p_firm AND lower(r.name) = lower(v.name))
  ORDER BY v.ord
  ON CONFLICT DO NOTHING
$$;
