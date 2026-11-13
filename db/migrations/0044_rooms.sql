-- 0044 Rooms (hospitality): room types, rooms, seasonal rates, bookings with check-in and check-out, extras, and the
-- guest bill into an ordinary invoice on 4200 Room revenue. Optional module "Rooms"; new industry "hospitality".
--
-- room_types: a kind of room with its nightly rate WITH VAT (hotels quote prices with VAT), capacity and income account.
-- rooms: the rooms themselves (number, type, floor); in service, out of service, or retired. Never deleted.
-- room_rates: seasons: a different nightly rate (with VAT) for a room type between two dates (both included).
-- bookings (BKG-0001): a guest (a customer), a room, arrival and departure (nights = departure - arrival), guests, an
--   optional agreed rate, and the status: reserved, in_house, departed, cancelled, no_show.
--   A room is never booked twice on the same night (checked in the database); cancelled and no-show bookings free it.
-- booking_extras: anything else on the guest bill (laundry, minibar, airport transfer), with a price WITH VAT.
-- booking_bills: each bill made from a booking: the nights it covers and the invoice. Nights are billed once; extras
--   carry the bill they went on. Deleting the draft invoice frees them again; issued invoices are never deleted.
-- No journal entry is made by a booking: the invoice posts (Dr Receivables, Cr 4200 Room revenue and others, Cr VAT).

INSERT INTO accounts (company_id, code, name, name_ar, type)
SELECT c.id, '4200', 'Room revenue', 'إيرادات الغرف', 'income' FROM companies c
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id)
ON CONFLICT (company_id, code) DO NOTHING;

ALTER TABLE companies DROP CONSTRAINT companies_modules_check;
ALTER TABLE companies ADD CONSTRAINT companies_modules_check
  CHECK (modules <@ ARRAY['Inventory', 'Restaurant', 'Assets', 'Projects', 'HRM', 'CRM', 'Rentals', 'Rooms']);
ALTER TABLE companies DROP CONSTRAINT companies_industry_check;
ALTER TABLE companies ADD CONSTRAINT companies_industry_check
  CHECK (industry IN ('trading', 'retail', 'restaurant', 'hospitality', 'services', 'construction', 'manufacturing', 'other'));

CREATE TABLE room_types (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id),
  code               text NOT NULL CHECK (btrim(code) <> ''),
  name               text NOT NULL CHECK (btrim(name) <> ''),
  name_ar            text,
  capacity           int NOT NULL DEFAULT 2 CHECK (capacity BETWEEN 1 AND 50),
  rate               numeric(18,2) NOT NULL CHECK (rate > 0),          -- a night, with VAT
  income_account_id  uuid NOT NULL REFERENCES accounts(id),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE rooms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  number        text NOT NULL CHECK (btrim(number) <> ''),
  room_type_id  uuid NOT NULL REFERENCES room_types(id),
  floor         text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'out_of_service', 'retired')),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number)
);

CREATE TABLE room_rates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  room_type_id  uuid NOT NULL REFERENCES room_types(id),
  name          text,                                             -- e.g. Winter season, Eid
  from_date     date NOT NULL,
  to_date       date NOT NULL CHECK (to_date >= from_date),
  rate          numeric(18,2) NOT NULL CHECK (rate > 0),          -- a night, with VAT
  EXCLUDE USING gist (room_type_id WITH =, daterange(from_date, to_date, '[]') WITH &&)
);

CREATE TABLE bookings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  number          text NOT NULL,
  contact_id      uuid NOT NULL REFERENCES contacts(id),
  room_id         uuid NOT NULL REFERENCES rooms(id),
  arrival         date NOT NULL,
  departure       date NOT NULL CHECK (departure > arrival),
  adults          int NOT NULL DEFAULT 1 CHECK (adults BETWEEN 1 AND 50),
  children        int NOT NULL DEFAULT 0 CHECK (children BETWEEN 0 AND 50),
  agreed_rate     numeric(18,2) CHECK (agreed_rate > 0),            -- a night, with VAT; replaces the room type and seasons
  status          text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'in_house', 'departed', 'cancelled', 'no_show')),
  source          text,                                             -- walk-in, phone, email, website, agent ...
  reference       text,                                             -- the guest's or agent's reference
  notes           text,
  checked_in_at   timestamptz,
  checked_out_at  timestamptz,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number),
  -- A room is never booked twice on the same night.
  EXCLUDE USING gist (room_id WITH =, daterange(arrival, departure, '[)') WITH &&) WHERE (status IN ('reserved', 'in_house', 'departed'))
);
CREATE INDEX bookings_company_dates ON bookings (company_id, arrival, departure);

CREATE TABLE booking_bills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  booking_id   uuid NOT NULL REFERENCES bookings(id),
  document_id  uuid NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  nights_from  date NOT NULL,
  nights_to    date NOT NULL CHECK (nights_to >= nights_from),     -- the nights from nights_from up to, not including, nights_to
  created_at   timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (booking_id WITH =, daterange(nights_from, nights_to, '[)') WITH &&)
);

CREATE TABLE booking_extras (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  booking_id  uuid NOT NULL REFERENCES bookings(id),
  extra_date  date NOT NULL,
  description text NOT NULL CHECK (btrim(description) <> ''),
  quantity    numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_price  numeric(18,2) NOT NULL CHECK (unit_price > 0),       -- with VAT
  account_id  uuid NOT NULL REFERENCES accounts(id),
  bill_id     uuid REFERENCES booking_bills(id) ON DELETE SET NULL,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_extras_booking ON booking_extras (booking_id);

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------
CREATE FUNCTION before_room_type() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.company_id <> OLD.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.income_account_id AND company_id = NEW.company_id AND type = 'income') THEN
    RAISE EXCEPTION 'Room revenue goes to an income account of this company.';
  END IF;
  IF TG_OP = 'INSERT' THEN NEW.created_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_types_before_change BEFORE INSERT OR UPDATE ON room_types FOR EACH ROW EXECUTE FUNCTION before_room_type();
CREATE TRIGGER room_types_no_delete BEFORE DELETE ON room_types FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION before_room() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.company_id <> OLD.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM room_types WHERE id = NEW.room_type_id AND company_id = NEW.company_id) THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'retired' AND OLD.status <> 'retired'
     AND EXISTS (SELECT 1 FROM bookings WHERE room_id = NEW.id AND status IN ('reserved', 'in_house')) THEN
    RAISE EXCEPTION 'This room has bookings to come: move them to another room before retiring it.';
  END IF;
  IF TG_OP = 'INSERT' THEN NEW.created_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rooms_before_change BEFORE INSERT OR UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION before_room();
CREATE TRIGGER rooms_no_delete BEFORE DELETE ON rooms FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION before_room_rate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM room_types WHERE id = NEW.room_type_id AND company_id = NEW.company_id) THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_rates_before_change BEFORE INSERT OR UPDATE ON room_rates FOR EACH ROW EXECUTE FUNCTION before_room_rate();

CREATE FUNCTION before_booking() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r rooms; t room_types; billed date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now(); NEW.status := 'reserved'; NEW.checked_in_at := NULL; NEW.checked_out_at := NULL;
  ELSE
    IF NEW.company_id <> OLD.company_id OR NEW.number <> OLD.number OR NEW.created_by <> OLD.created_by THEN
      RAISE EXCEPTION 'A booking keeps its company and number.';
    END IF;
    IF OLD.status IN ('departed', 'cancelled', 'no_show') THEN RAISE EXCEPTION 'This booking is finished and no longer changes.'; END IF;
    IF NEW.status <> OLD.status AND NOT ((OLD.status = 'reserved' AND NEW.status IN ('in_house', 'cancelled', 'no_show'))
                                       OR (OLD.status = 'in_house' AND NEW.status = 'departed')) THEN
      RAISE EXCEPTION 'A booking goes from reserved to in house (or cancelled, or no-show), then to departed.';
    END IF;
    IF NEW.status = 'in_house' AND OLD.status = 'reserved' THEN NEW.checked_in_at := now(); END IF;
    IF NEW.status = 'departed' THEN NEW.checked_out_at := now(); END IF;
    SELECT max(nights_to) INTO billed FROM booking_bills WHERE booking_id = NEW.id;
    IF billed IS NOT NULL THEN
      IF NEW.arrival <> OLD.arrival OR NEW.contact_id <> OLD.contact_id OR NEW.agreed_rate IS DISTINCT FROM OLD.agreed_rate THEN
        RAISE EXCEPTION 'This booking has been billed: its guest, arrival and agreed rate no longer change.';
      END IF;
      IF NEW.departure < billed THEN RAISE EXCEPTION 'The departure cannot be before the nights already billed (up to %).', billed; END IF;
      IF NEW.status IN ('cancelled', 'no_show') THEN RAISE EXCEPTION 'This booking has been billed and is not cancelled.'; END IF;
    END IF;
    IF NEW.status = 'departed' THEN
      IF coalesce(billed, NEW.arrival) < NEW.departure THEN RAISE EXCEPTION 'Bill every night before checking out.'; END IF;
      IF EXISTS (SELECT 1 FROM booking_extras WHERE booking_id = NEW.id AND bill_id IS NULL) THEN RAISE EXCEPTION 'Bill every extra before checking out.'; END IF;
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND company_id = NEW.company_id AND is_customer) THEN
    RAISE EXCEPTION 'Choose a guest who is a customer of this company.';
  END IF;
  SELECT * INTO r FROM rooms WHERE id = NEW.room_id;
  IF r.company_id IS DISTINCT FROM NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF (TG_OP = 'INSERT' OR NEW.room_id <> OLD.room_id) AND r.status <> 'active' THEN RAISE EXCEPTION 'This room is not in service.'; END IF;
  SELECT * INTO t FROM room_types WHERE id = r.room_type_id;
  IF NEW.adults + NEW.children > t.capacity THEN RAISE EXCEPTION 'This room takes at most % guests.', t.capacity; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_before_change BEFORE INSERT OR UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION before_booking();
CREATE TRIGGER bookings_no_delete BEFORE DELETE ON bookings FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION before_booking_bill() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b bookings;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'A bill is never changed; delete the draft invoice to bill again.'; END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM documents WHERE id = OLD.document_id) THEN RAISE EXCEPTION 'A bill is freed only by deleting its draft invoice.'; END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO b FROM bookings WHERE id = NEW.booking_id;
  IF b.company_id IS DISTINCT FROM NEW.company_id OR NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  IF b.status NOT IN ('reserved', 'in_house') THEN RAISE EXCEPTION 'This booking is finished and no longer changes.'; END IF;
  IF NEW.nights_from < b.arrival OR NEW.nights_to > b.departure THEN RAISE EXCEPTION 'A booking is billed only for the nights of the stay.'; END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER booking_bills_before_change BEFORE INSERT OR UPDATE OR DELETE ON booking_bills FOR EACH ROW EXECUTE FUNCTION before_booking_bill();

CREATE FUNCTION before_booking_extra() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b bookings;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.bill_id IS NOT NULL THEN
    -- The only change to a billed extra: its draft invoice was deleted, which frees it (bill_id set to null).
    IF TG_OP = 'UPDATE' AND NEW.bill_id IS NULL AND NOT EXISTS (SELECT 1 FROM booking_bills WHERE id = OLD.bill_id)
       AND (to_jsonb(NEW) - 'bill_id') = (to_jsonb(OLD) - 'bill_id') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'This extra has been billed and no longer changes.';
  END IF;
  SELECT * INTO b FROM bookings WHERE id = coalesce(NEW.booking_id, OLD.booking_id);
  IF b.status NOT IN ('reserved', 'in_house') THEN RAISE EXCEPTION 'This booking is finished and no longer changes.'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF b.company_id IS DISTINCT FROM NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.booking_id <> OLD.booking_id OR NEW.company_id <> OLD.company_id) THEN RAISE EXCEPTION 'An extra stays on its booking.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND company_id = NEW.company_id AND type = 'income') THEN
    RAISE EXCEPTION 'An extra goes to an income account of this company.';
  END IF;
  IF NEW.bill_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.bill_id IS NULL)
     AND NOT EXISTS (SELECT 1 FROM booking_bills WHERE id = NEW.bill_id AND booking_id = NEW.booking_id) THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_extras_before_change BEFORE INSERT OR UPDATE OR DELETE ON booking_extras FOR EACH ROW EXECUTE FUNCTION before_booking_extra();

-- ---------------------------------------------------------------------------
-- Access and audit
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['room_types', 'rooms', 'room_rates', 'bookings', 'booking_bills', 'booking_extras'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_update', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nusuh_app', t);
  END LOOP;
END $$;
CREATE POLICY room_rates_delete ON room_rates FOR DELETE USING (app_has_role(company_id, posting_roles()));
CREATE POLICY booking_extras_delete ON booking_extras FOR DELETE USING (app_has_role(company_id, posting_roles()));
GRANT DELETE ON room_rates, booking_extras TO nusuh_app;

-- Job titles may give access to Rooms.
CREATE OR REPLACE FUNCTION before_client_role_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE k text; v text;
BEGIN
  FOR k, v IN SELECT * FROM jsonb_each_text(NEW.permissions) LOOP
    IF k NOT IN ('Sales', 'Purchases', 'Expenses', 'Bank', 'Inventory', 'Restaurant', 'Assets', 'Rentals', 'Rooms', 'Projects', 'HRM', 'CRM', 'Journal', 'Ledger', 'Reports')
       OR v NOT IN ('none', 'view', 'edit') THEN
      RAISE EXCEPTION 'Unknown module or access level in a role: % = %.', k, v;
    END IF;
  END LOOP;
  IF TG_OP = 'UPDATE' AND NEW.firm_id <> OLD.firm_id THEN RAISE EXCEPTION 'A role stays with its firm.'; END IF;
  RETURN NEW;
END $$;

-- Each existing job title gets Rooms at the level it has for Sales (room revenue is sales-side); new customers' default
-- roles include it.
UPDATE client_roles SET permissions = permissions || jsonb_build_object('Rooms', permissions->'Sales')
WHERE permissions ? 'Sales' AND NOT permissions ? 'Rooms';
CREATE OR REPLACE FUNCTION add_default_client_roles(p_firm uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO client_roles (firm_id, name, name_ar, description, permissions, can_approve, default_for)
  SELECT p_firm, v.name, v.name_ar, v.description,
         (SELECT jsonb_object_agg(m, v.level) FROM unnest(ARRAY['Sales', 'Purchases', 'Expenses', 'Bank', 'Inventory', 'Restaurant', 'Assets', 'Rentals', 'Rooms', 'Projects',
                                                         'HRM', 'CRM', 'Journal', 'Ledger', 'Reports']) m),
         v.can_approve, v.default_for::user_role
  FROM (VALUES ('Client accountant', 'محاسب العميل', 'Daily entry in every module the client has', 'edit', true, 'client_accountant', 1),
               ('Client management', 'إدارة العميل', 'Sees everything, changes nothing', 'view', false, 'client_viewer', 2)) v(name, name_ar, description, level, can_approve, default_for, ord)
  ORDER BY v.ord
  ON CONFLICT DO NOTHING
$$;
