-- 0065 The Owner is not the Administrator, in a company that runs its own books.
-- A customer of kind 'company' has its own separate Administrator (a login of kind 'admin' who manages the company's users,
-- job titles and access, raises issues with Nusuh Books, and never sees the books) and its people (Owner, Finance, Sales,
-- Commercial...) who use the books. The Owner title no longer manages users by default; the right (can_manage_users, from
-- 0063) stays as an optional setting a job title can be given, so nothing already built stops working. Nothing else changes.

UPDATE client_roles SET can_manage_users = false, description = 'Sees everything including the owner reports, records ownership money, approves. Does not manage users: the company''s separate Administrator does that'
WHERE name = 'Owner' AND default_for IS NULL AND can_manage_users
  AND description = 'Sees everything including the owner reports, records ownership money, approves; in a company that runs its own books also manages users and job titles';

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
    ('Owner', 'المالك', 'Sees everything including the owner reports, records ownership money, approves. Does not manage users: the company''s separate Administrator does that', 'view', '{"Ownership":"edit"}'::jsonb, true, NULL, false, 3),
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
