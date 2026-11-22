-- 0062 Department job titles and owner-only reports.
--   * A new role module key, OwnerReports: the owner summary, profit and loss, balance sheet and cash flow. Together with
--     Ownership it is what only the owner (and a title the Administrator gives it to) may see.
--   * Every customer starts with four more job titles next to Client accountant and Client management:
--       Owner       sees everything including the owner reports, records ownership money, approves
--       Finance     the money side of every department (sales and purchase invoices and payments, bank, expenses, the
--                   books, assets, the finance reports), can look at payroll, stock, projects and rentals; approves
--       Sales       customers, quotations, invoices, CRM and the sales-side industry modules (rooms, restaurant, rentals)
--       Commercial  purchasing and stock: suppliers, purchase orders, bills, inventory, rentals, projects; looks at sales
--     Titles are ordinary job titles: the Administrator can change or retire them.

CREATE OR REPLACE FUNCTION before_client_role_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE k text; v text;
BEGIN
  FOR k, v IN SELECT * FROM jsonb_each_text(NEW.permissions) LOOP
    IF k NOT IN ('Sales', 'Purchases', 'Expenses', 'Bank', 'Inventory', 'Restaurant', 'Assets', 'Rentals', 'Rooms', 'Projects', 'HRM', 'CRM', 'Journal', 'Ledger', 'Ownership', 'OwnerReports', 'Reports')
       OR v NOT IN ('none', 'view', 'edit') THEN
      RAISE EXCEPTION 'Unknown module or access level in a role: % = %.', k, v;
    END IF;
  END LOOP;
  IF TG_OP = 'UPDATE' AND NEW.firm_id <> OLD.firm_id THEN RAISE EXCEPTION 'A role stays with its firm.'; END IF;
  RETURN NEW;
END $$;

-- Existing job titles keep what they could see: OwnerReports starts at the level they have for Reports.
UPDATE client_roles SET permissions = permissions || jsonb_build_object('OwnerReports', permissions->'Reports')
WHERE permissions ? 'Reports' AND NOT permissions ? 'OwnerReports';

CREATE OR REPLACE FUNCTION add_default_client_roles(p_firm uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO client_roles (firm_id, name, name_ar, description, permissions, can_approve, default_for)
  SELECT p_firm, v.name, v.name_ar, v.description,
         (SELECT jsonb_object_agg(k, coalesce(v.perm ->> k, v.base))
          FROM unnest(ARRAY['Sales', 'Purchases', 'Expenses', 'Bank', 'Inventory', 'Restaurant', 'Assets', 'Rentals', 'Rooms', 'Projects',
                            'HRM', 'CRM', 'Journal', 'Ledger', 'Ownership', 'OwnerReports', 'Reports']) k),
         v.can_approve, v.default_for::user_role
  FROM (VALUES
    ('Client accountant', 'محاسب العميل', 'Daily entry in every module the client has, except the owner reports and ownership', 'edit', '{"Ownership":"none","OwnerReports":"none"}'::jsonb, true, 'client_accountant', 1),
    ('Client management', 'إدارة العميل', 'Sees everything, changes nothing', 'view', '{}'::jsonb, false, 'client_viewer', 2),
    ('Owner', 'المالك', 'Sees everything including the owner reports, records ownership money, approves', 'view', '{"Ownership":"edit"}'::jsonb, true, NULL, 3),
    ('Finance', 'المالية', 'The money side of every department and the finance reports; looks at payroll, stock and projects; approves', 'none',
      '{"Sales":"edit","Purchases":"edit","Expenses":"edit","Bank":"edit","Journal":"edit","Ledger":"edit","Assets":"edit","Reports":"edit","HRM":"view","Inventory":"view","Projects":"view","Restaurant":"view","Rentals":"view","Rooms":"view"}'::jsonb, true, NULL, 4),
    ('Sales', 'المبيعات', 'Customers, quotations, invoices, CRM and the selling side of rooms, restaurant and rentals', 'none',
      '{"Sales":"edit","CRM":"edit","Rooms":"edit","Restaurant":"edit","Rentals":"edit","Inventory":"view","Projects":"view"}'::jsonb, false, NULL, 5),
    ('Commercial', 'التجاري', 'Purchasing and stock: suppliers, purchase orders, bills, inventory, rentals and projects; looks at sales', 'none',
      '{"Purchases":"edit","Inventory":"edit","Rentals":"edit","Projects":"edit","Sales":"view"}'::jsonb, false, NULL, 6)
  ) v(name, name_ar, description, base, perm, can_approve, default_for, ord)
  WHERE NOT EXISTS (SELECT 1 FROM client_roles r WHERE r.firm_id = p_firm AND lower(r.name) = lower(v.name))
  ORDER BY v.ord
  ON CONFLICT DO NOTHING
$$;

-- Customers that already exist get the four new titles too (never one whose name is already taken).
SELECT add_default_client_roles(id) FROM firms;
