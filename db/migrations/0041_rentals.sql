-- 0041 Rentals: renting out equipment or anything else (cranes, vehicles, scaffolding, generators, rooms) as income.
--
-- rental_items: what is rented out, how many units (1 for a crane; 500 for scaffolding frames), its rates by the hour,
--   day, week or month, the income account (4100 Rental income unless chosen), and optionally the fixed asset it is.
-- rental_contracts (RNT-0001): a customer, an optional project or branch (cost centre), open, closed or cancelled.
-- rental_lines: an item on a contract: units, rate basis and rate, the date it goes out and the date it comes back.
--   An item is never rented out beyond its units on overlapping dates (checked in the database).
-- rental_usage: hours worked per day, for items rented by the hour (a crane's timesheet).
-- rental_bills / rental_bill_lines: each billed period of each line, with the invoice it made. A period is billed once;
--   deleting the draft invoice frees it again. Issued invoices are never deleted, so billed periods stay billed.
-- Amounts are exact: by the day = days x rate; by the hour = hours x rate; by the week = rate x days / 7; by the month
-- = rate x days / 30, rounded once per line. Days count both the first and the last day.

INSERT INTO accounts (company_id, code, name, name_ar, type)
SELECT c.id, '4100', 'Rental income', 'إيرادات التأجير', 'income' FROM companies c
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id)
ON CONFLICT (company_id, code) DO NOTHING;

ALTER TABLE companies DROP CONSTRAINT companies_modules_check;
ALTER TABLE companies ADD CONSTRAINT companies_modules_check
  CHECK (modules <@ ARRAY['Inventory', 'Restaurant', 'Assets', 'Projects', 'HRM', 'CRM', 'Rentals']);

CREATE TABLE rental_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id),
  code               text NOT NULL CHECK (btrim(code) <> ''),
  name               text NOT NULL CHECK (btrim(name) <> ''),
  name_ar            text,
  category           text,                         -- e.g. Crane, Vehicle, Scaffolding, Generator
  identifier         text,                         -- plate, serial or fleet number
  units              int NOT NULL DEFAULT 1 CHECK (units BETWEEN 1 AND 1000000),
  hour_rate          numeric(18,2) CHECK (hour_rate > 0),
  day_rate           numeric(18,2) CHECK (day_rate > 0),
  week_rate          numeric(18,2) CHECK (week_rate > 0),
  month_rate         numeric(18,2) CHECK (month_rate > 0),
  income_account_id  uuid NOT NULL REFERENCES accounts(id),
  fixed_asset_id     uuid REFERENCES fixed_assets(id),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE rental_contracts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  number          text NOT NULL,
  contact_id      uuid NOT NULL REFERENCES contacts(id),
  cost_centre_id  uuid REFERENCES cost_centres(id),
  site            text,                             -- where the equipment works
  reference       text,                             -- the customer's order number
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  notes           text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);

CREATE TABLE rental_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  contract_id  uuid NOT NULL REFERENCES rental_contracts(id),
  item_id      uuid NOT NULL REFERENCES rental_items(id),
  units        int NOT NULL DEFAULT 1 CHECK (units >= 1),
  basis        text NOT NULL CHECK (basis IN ('hour', 'day', 'week', 'month')),
  rate         numeric(18,2) NOT NULL CHECK (rate > 0),
  out_date     date NOT NULL,
  return_date  date CHECK (return_date IS NULL OR return_date >= out_date),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rental_lines_item ON rental_lines (item_id, out_date);

CREATE TABLE rental_usage (
  line_id     uuid NOT NULL REFERENCES rental_lines(id),
  company_id  uuid NOT NULL REFERENCES companies(id),
  work_date   date NOT NULL,
  hours       numeric(6,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  note        text,
  PRIMARY KEY (line_id, work_date)
);

CREATE TABLE rental_bills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  contract_id  uuid NOT NULL REFERENCES rental_contracts(id),
  document_id  uuid NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  period_to    date NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rental_bill_lines (
  bill_id     uuid NOT NULL REFERENCES rental_bills(id) ON DELETE CASCADE,
  line_id     uuid NOT NULL REFERENCES rental_lines(id),
  company_id  uuid NOT NULL REFERENCES companies(id),
  from_date   date NOT NULL,
  to_date     date NOT NULL CHECK (to_date >= from_date),
  quantity    numeric(14,3) NOT NULL CHECK (quantity >= 0),   -- days, hours, or days for week and month rates
  amount      numeric(18,2) NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (bill_id, line_id),
  EXCLUDE USING gist (line_id WITH =, daterange(from_date, to_date, '[]') WITH &&)
);

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------
CREATE FUNCTION before_rental_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.company_id <> OLD.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.income_account_id AND company_id = NEW.company_id AND type = 'income') THEN
    RAISE EXCEPTION 'Rental income goes to an income account of this company.';
  END IF;
  IF NEW.fixed_asset_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fixed_assets WHERE id = NEW.fixed_asset_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  IF coalesce(NEW.hour_rate, NEW.day_rate, NEW.week_rate, NEW.month_rate) IS NULL THEN
    RAISE EXCEPTION 'Give the item at least one rate (by the hour, day, week or month).';
  END IF;
  IF TG_OP = 'INSERT' THEN NEW.created_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_items_before_change BEFORE INSERT OR UPDATE ON rental_items FOR EACH ROW EXECUTE FUNCTION before_rental_item();
CREATE TRIGGER rental_items_no_delete BEFORE DELETE ON rental_items FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION before_rental_contract() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now(); NEW.status := 'open';
  ELSIF NEW.company_id <> OLD.company_id OR NEW.number <> OLD.number OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'A rental contract keeps its company and number.';
  ELSIF OLD.status <> 'open' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'A closed or cancelled rental contract is not reopened. Start a new one.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND company_id = NEW.company_id AND is_customer) THEN
    RAISE EXCEPTION 'Choose a customer of this company.';
  END IF;
  IF NEW.cost_centre_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cost_centres WHERE id = NEW.cost_centre_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'cancelled' AND OLD.status = 'open'
     AND EXISTS (SELECT 1 FROM rental_bills WHERE contract_id = NEW.id) THEN
    RAISE EXCEPTION 'This rental has been billed: return the items and close it instead.';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'closed' AND OLD.status = 'open' THEN
    IF EXISTS (SELECT 1 FROM rental_lines WHERE contract_id = NEW.id AND return_date IS NULL) THEN
      RAISE EXCEPTION 'Record the return of every item before closing the rental.';
    END IF;
    IF EXISTS (SELECT 1 FROM rental_lines l WHERE l.contract_id = NEW.id
               AND coalesce((SELECT max(b.to_date) FROM rental_bill_lines b WHERE b.line_id = l.id), l.out_date - 1) < l.return_date) THEN
      RAISE EXCEPTION 'Bill the rental up to the return dates before closing it.';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_contracts_before_change BEFORE INSERT OR UPDATE ON rental_contracts FOR EACH ROW EXECUTE FUNCTION before_rental_contract();
CREATE TRIGGER rental_contracts_no_delete BEFORE DELETE ON rental_contracts FOR EACH ROW EXECUTE FUNCTION forbid_change();

/** An item is never rented out beyond its units on any day. */
CREATE FUNCTION before_rental_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c rental_contracts; it rental_items; booked int; billed date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM rental_bill_lines WHERE line_id = OLD.id) THEN RAISE EXCEPTION 'This line has been billed and stays on the contract.'; END IF;
    IF EXISTS (SELECT 1 FROM rental_usage WHERE line_id = OLD.id) THEN RAISE EXCEPTION 'This line has hours recorded: remove them first.'; END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO c FROM rental_contracts WHERE id = NEW.contract_id;
  SELECT * INTO it FROM rental_items WHERE id = NEW.item_id;
  IF c.company_id IS DISTINCT FROM NEW.company_id OR it.company_id IS DISTINCT FROM NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF c.status <> 'open' THEN RAISE EXCEPTION 'This rental contract is closed.'; END IF;
  SELECT max(to_date) INTO billed FROM rental_bill_lines WHERE line_id = NEW.id;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.contract_id <> OLD.contract_id OR NEW.company_id <> OLD.company_id THEN RAISE EXCEPTION 'A rental line stays on its contract.'; END IF;
    IF billed IS NOT NULL AND (NEW.item_id <> OLD.item_id OR NEW.units <> OLD.units OR NEW.basis <> OLD.basis OR NEW.rate <> OLD.rate OR NEW.out_date <> OLD.out_date) THEN
      RAISE EXCEPTION 'This line has been billed: its item, units, rate and start date no longer change.';
    END IF;
    IF billed IS NOT NULL AND NEW.return_date IS NOT NULL AND NEW.return_date < billed THEN
      RAISE EXCEPTION 'The return date cannot be before the end of what has been billed (%).', billed;
    END IF;
  ELSIF it.status <> 'active' THEN
    RAISE EXCEPTION 'This item is retired and no longer rented out.';
  END IF;
  IF NEW.units > it.units THEN RAISE EXCEPTION 'Only % of this item exist.', it.units; END IF;
  -- The most units out on any single day of this line's dates, with this line counted.
  SELECT coalesce(max(s.n), 0) INTO booked FROM (
    SELECT sum(l.units) AS n FROM generate_series(NEW.out_date, coalesce(NEW.return_date, NEW.out_date + 366), interval '1 day') AS d(day)
    JOIN rental_lines l ON l.item_id = NEW.item_id AND l.id <> NEW.id AND d.day::date >= l.out_date AND (l.return_date IS NULL OR d.day::date <= l.return_date)
    JOIN rental_contracts k ON k.id = l.contract_id AND k.status <> 'cancelled'
    GROUP BY d.day) s;
  IF booked + NEW.units > it.units THEN
    RAISE EXCEPTION 'This item is already rented out on some of these dates (% of % units free).', it.units - booked, it.units;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_lines_before_change BEFORE INSERT OR UPDATE OR DELETE ON rental_lines FOR EACH ROW EXECUTE FUNCTION before_rental_line();

/** Hours are recorded for items rented by the hour, on days the item is out and not yet billed. */
CREATE FUNCTION before_rental_usage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l rental_lines; r rental_usage := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
  SELECT * INTO l FROM rental_lines WHERE id = r.line_id;
  IF EXISTS (SELECT 1 FROM rental_bill_lines b WHERE b.line_id = r.line_id AND r.work_date BETWEEN b.from_date AND b.to_date)
     OR (TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM rental_bill_lines b WHERE b.line_id = OLD.line_id AND OLD.work_date BETWEEN b.from_date AND b.to_date)) THEN
    RAISE EXCEPTION 'These hours have been billed and no longer change.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF l.company_id IS DISTINCT FROM NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF l.basis <> 'hour' THEN RAISE EXCEPTION 'Hours are recorded only for items rented by the hour.'; END IF;
  IF NEW.work_date < l.out_date OR (l.return_date IS NOT NULL AND NEW.work_date > l.return_date) THEN
    RAISE EXCEPTION 'Record hours on days the item was out.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_usage_before_change BEFORE INSERT OR UPDATE OR DELETE ON rental_usage FOR EACH ROW EXECUTE FUNCTION before_rental_usage();

CREATE FUNCTION before_rental_bill_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l rental_lines;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'A billed period is never changed; delete the draft invoice to bill it again.'; END IF;
  SELECT * INTO l FROM rental_lines WHERE id = NEW.line_id;
  IF l.company_id IS DISTINCT FROM NEW.company_id OR NOT EXISTS (SELECT 1 FROM rental_bills WHERE id = NEW.bill_id AND contract_id = l.contract_id) THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  IF NEW.from_date < l.out_date OR (l.return_date IS NOT NULL AND NEW.to_date > l.return_date) THEN
    RAISE EXCEPTION 'A rental is billed only for days the item was out.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_bill_lines_before_change BEFORE INSERT OR UPDATE ON rental_bill_lines FOR EACH ROW EXECUTE FUNCTION before_rental_bill_line();
-- Deleting a billed period happens only through its draft invoice being deleted (ON DELETE CASCADE).
CREATE FUNCTION before_rental_bill_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM documents WHERE id = OLD.document_id) THEN
    RAISE EXCEPTION 'A billed period is freed only by deleting its draft invoice.';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER rental_bills_before_delete BEFORE DELETE ON rental_bills FOR EACH ROW EXECUTE FUNCTION before_rental_bill_delete();

-- ---------------------------------------------------------------------------
-- Access and audit
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rental_items', 'rental_contracts', 'rental_lines', 'rental_usage', 'rental_bills', 'rental_bill_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_update', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nusuh_app', t);
  END LOOP;
END $$;
CREATE POLICY rental_lines_delete ON rental_lines FOR DELETE USING (app_has_role(company_id, posting_roles()));
CREATE POLICY rental_usage_delete ON rental_usage FOR DELETE USING (app_has_role(company_id, posting_roles()));
GRANT DELETE ON rental_lines, rental_usage TO nusuh_app;

-- Job titles may give access to Rentals.
CREATE OR REPLACE FUNCTION before_client_role_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE k text; v text;
BEGIN
  FOR k, v IN SELECT * FROM jsonb_each_text(NEW.permissions) LOOP
    IF k NOT IN ('Sales', 'Purchases', 'Expenses', 'Bank', 'Inventory', 'Restaurant', 'Assets', 'Rentals', 'Projects', 'HRM', 'CRM', 'Journal', 'Ledger', 'Reports')
       OR v NOT IN ('none', 'view', 'edit') THEN
      RAISE EXCEPTION 'Unknown module or access level in a role: % = %.', k, v;
    END IF;
  END LOOP;
  IF TG_OP = 'UPDATE' AND NEW.firm_id <> OLD.firm_id THEN RAISE EXCEPTION 'A role stays with its firm.'; END IF;
  RETURN NEW;
END $$;

-- Job titles (client roles) set access per module: each existing role gets Rentals at the level it has for Sales
-- (rental income is sales-side), and new customers' default roles include it.
UPDATE client_roles SET permissions = permissions || jsonb_build_object('Rentals', permissions->'Sales')
WHERE permissions ? 'Sales' AND NOT permissions ? 'Rentals';
CREATE OR REPLACE FUNCTION add_default_client_roles(p_firm uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO client_roles (firm_id, name, name_ar, description, permissions, can_approve, default_for)
  SELECT p_firm, v.name, v.name_ar, v.description,
         (SELECT jsonb_object_agg(m, v.level) FROM unnest(ARRAY['Sales', 'Purchases', 'Expenses', 'Bank', 'Inventory', 'Restaurant', 'Assets', 'Rentals', 'Projects', 'HRM', 'CRM',
                                                         'Journal', 'Ledger', 'Reports']) m),
         v.can_approve, v.default_for::user_role
  FROM (VALUES ('Client accountant', 'محاسب العميل', 'Daily entry in every module the client has', 'edit', true, 'client_accountant', 1),
               ('Client management', 'إدارة العميل', 'Sees everything, changes nothing', 'view', false, 'client_viewer', 2)) v(name, name_ar, description, level, can_approve, default_for, ord)
  ORDER BY v.ord
  ON CONFLICT DO NOTHING
$$;
