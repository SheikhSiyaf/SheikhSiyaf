-- 0095 Rooms contract options (KSA). Every booking has a contract type:
--   short_stay: hotel, serviced apartment, guest house. The guest's identity is CHECKED and the details kept (ID type, number,
--     nationality, who verified and when). No copy or photo of an ID or passport is stored: there is no file column anywhere
--     in this feature, and the attachments table refuses anything but a PDF on a long-term contract.
--   long_term: a monthly or yearly rental with landlord and tenant identity, rent, payment schedule, deposit, the Ejar contract
--     number and registration status, renewal tracking, non-renewal notice, rent-increase fields, and addenda for changes.
-- room_settings: per company (one row): maximum stay in days (off by default), the language that governs the contract terms
--   (Arabic unless the administrator changes it), the cities where rent increases are blocked (starts with Riyadh), the standard
--   contract terms and cancellation and refund terms in English and Arabic. Only the company administrator changes it.
-- room_charge_lines: optional extra charge lines for short stays (for example a municipal or tourism charge): name, rate in
--   percent, on or off, the account it posts to. No rate is built in; they start off.
-- booking_guest_checks / booking_tenancies hold identity details, so only people who can post (not viewers or reviewers) read
--   them, and their audit rows carry only the last four characters of an ID number.
-- booking_addenda: a signed rental contract is never edited; a change of rent or end date is an addendum, appended, never changed.
-- booking_instalments: the payment schedule of a rental; each one is billed once as an ordinary invoice.
-- Nothing here connects to Shomoos, the national tourism platform or Ejar: the data and exports are ready, integration is later.

-- ---------------------------------------------------------------------------
-- Who is the company administrator
-- ---------------------------------------------------------------------------
-- The firm partner, or the person whose job title may manage users in a company that runs its own books (the Owner title).
CREATE FUNCTION app_is_company_admin(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_has_role(p_company, ARRAY['partner']::user_role[])
      OR EXISTS (SELECT 1 FROM memberships m JOIN client_roles r ON r.id = m.client_role_id AND r.status = 'active' AND r.can_manage_users
                 WHERE m.user_id = app_user_id() AND m.company_id = p_company)
$$;
GRANT EXECUTE ON FUNCTION app_is_company_admin(uuid) TO nusuh_app;

-- ---------------------------------------------------------------------------
-- Settings and extra charge lines
-- ---------------------------------------------------------------------------
CREATE TABLE room_settings (
  company_id         uuid PRIMARY KEY REFERENCES companies(id),
  max_stay_days      int CHECK (max_stay_days IS NULL OR max_stay_days BETWEEN 1 AND 3650),   -- null = off
  governing_language text NOT NULL DEFAULT 'ar' CHECK (governing_language IN ('ar', 'en')),
  frozen_cities      text[] NOT NULL DEFAULT ARRAY['Riyadh'],
  terms_en           text CHECK (length(terms_en) <= 20000),
  terms_ar           text CHECK (length(terms_ar) <= 20000),
  cancellation_en    text CHECK (length(cancellation_en) <= 5000),
  cancellation_ar    text CHECK (length(cancellation_ar) <= 5000),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE room_charge_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  name_ar     text,
  rate        numeric(6,3) NOT NULL CHECK (rate >= 0 AND rate <= 100),      -- percent of the price before VAT
  active      boolean NOT NULL DEFAULT false,
  account_id  uuid REFERENCES accounts(id),
  vat_code    text NOT NULL DEFAULT 'out_of_scope' CHECK (vat_code IN ('standard', 'zero', 'exempt', 'out_of_scope')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name),
  CHECK (NOT active OR account_id IS NOT NULL)
);

CREATE FUNCTION before_room_charge_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.company_id <> OLD.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF NEW.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND company_id = NEW.company_id AND type = 'income') THEN
    RAISE EXCEPTION 'A charge line goes to an income account of this company (a sales invoice posts to income).';
  END IF;
  IF TG_OP = 'INSERT' THEN NEW.created_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_charge_lines_before_change BEFORE INSERT OR UPDATE ON room_charge_lines FOR EACH ROW EXECUTE FUNCTION before_room_charge_line();
CREATE TRIGGER room_charge_lines_no_delete BEFORE DELETE ON room_charge_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- The contract type on the booking
-- ---------------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN contract_type text NOT NULL DEFAULT 'short_stay' CHECK (contract_type IN ('short_stay', 'long_term'));
-- what the guest or tenant agreed to, as it read when the booking was made (changing the settings later never rewrites it)
ALTER TABLE bookings ADD COLUMN terms_en text, ADD COLUMN terms_ar text, ADD COLUMN cancellation_en text, ADD COLUMN cancellation_ar text,
  ADD COLUMN governing_language text CHECK (governing_language IN ('ar', 'en'));

CREATE FUNCTION before_booking_contract() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE maxd int;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.contract_type <> OLD.contract_type THEN
    IF NOT app_is_company_admin(NEW.company_id) THEN RAISE EXCEPTION 'Only an administrator changes the contract type.'; END IF;
    IF OLD.status <> 'reserved' OR EXISTS (SELECT 1 FROM booking_guest_checks WHERE booking_id = NEW.id)
       OR EXISTS (SELECT 1 FROM booking_tenancies WHERE booking_id = NEW.id) THEN
      RAISE EXCEPTION 'The contract type cannot change once the contract details are saved.';
    END IF;
  END IF;
  IF NEW.contract_type = 'short_stay' AND NEW.status IN ('reserved', 'in_house') AND (TG_OP = 'INSERT' OR NEW.departure <> OLD.departure OR NEW.arrival <> OLD.arrival) THEN
    SELECT max_stay_days INTO maxd FROM room_settings WHERE company_id = NEW.company_id;
    IF maxd IS NOT NULL AND (NEW.departure - NEW.arrival) > maxd THEN
      RAISE EXCEPTION 'A stay is at most % days at this property.', maxd;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_contract_rules BEFORE INSERT OR UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION before_booking_contract();

-- The same booking rules as 0044, except that checking a rental out does not need every night billed (a rental is billed by instalment).
CREATE OR REPLACE FUNCTION before_booking() RETURNS trigger
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
    IF NEW.status = 'departed' AND NEW.contract_type = 'short_stay' THEN   -- a rental is billed by instalment, not by the night
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

-- Nights are billed for a short stay only: a rental is billed by instalment.
CREATE FUNCTION before_booking_bill_contract() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bookings WHERE id = NEW.booking_id AND contract_type = 'long_term') THEN
    RAISE EXCEPTION 'A long-term rental is billed by instalment, not by the night.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_bills_contract BEFORE INSERT ON booking_bills FOR EACH ROW EXECUTE FUNCTION before_booking_bill_contract();

-- ---------------------------------------------------------------------------
-- Type A: the guest identity check (details only, never a copy of the ID)
-- ---------------------------------------------------------------------------
CREATE TABLE booking_guest_checks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  booking_id   uuid NOT NULL UNIQUE REFERENCES bookings(id),
  id_type      text NOT NULL CHECK (id_type IN ('national_id', 'iqama', 'passport', 'moi_digital')),
  id_number    text NOT NULL CHECK (btrim(id_number) <> '' AND length(id_number) <= 40),
  nationality  text NOT NULL CHECK (btrim(nationality) <> '' AND length(nationality) <= 60),
  verified_by  text NOT NULL CHECK (btrim(verified_by) <> '' AND length(verified_by) <= 120),
  verified_at  timestamptz NOT NULL,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION before_guest_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b bookings;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = NEW.booking_id;
  IF b.company_id IS DISTINCT FROM NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF b.contract_type <> 'short_stay' THEN RAISE EXCEPTION 'A guest identity check belongs to a short stay.'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.booking_id <> OLD.booking_id OR NEW.company_id <> OLD.company_id) THEN RAISE EXCEPTION 'A check stays on its booking.'; END IF;
  IF b.status NOT IN ('reserved', 'in_house') THEN RAISE EXCEPTION 'This booking is finished and no longer changes.'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guest_checks_before_change BEFORE INSERT OR UPDATE ON booking_guest_checks FOR EACH ROW EXECUTE FUNCTION before_guest_check();
CREATE TRIGGER guest_checks_no_delete BEFORE DELETE ON booking_guest_checks FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Type B: the rental contract
-- ---------------------------------------------------------------------------
CREATE TABLE booking_tenancies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id),
  booking_id            uuid NOT NULL UNIQUE REFERENCES bookings(id),
  landlord_name         text NOT NULL CHECK (btrim(landlord_name) <> ''),
  landlord_id_type      text NOT NULL CHECK (landlord_id_type IN ('national_id', 'iqama', 'passport', 'moi_digital')),
  landlord_id_number    text NOT NULL CHECK (btrim(landlord_id_number) <> ''),
  tenant_id_type        text NOT NULL CHECK (tenant_id_type IN ('national_id', 'iqama', 'passport', 'moi_digital')),
  tenant_id_number      text NOT NULL CHECK (btrim(tenant_id_number) <> ''),
  property              text NOT NULL CHECK (btrim(property) <> ''),
  city                  text NOT NULL CHECK (btrim(city) <> ''),
  rent                  numeric(18,2) NOT NULL CHECK (rent > 0),               -- per rent period
  rent_period           text NOT NULL CHECK (rent_period IN ('monthly', 'yearly')),
  deposit               numeric(18,2) NOT NULL DEFAULT 0 CHECK (deposit >= 0),
  vat_code              text NOT NULL CHECK (vat_code IN ('standard', 'zero', 'exempt', 'out_of_scope')),
  income_account_id     uuid NOT NULL REFERENCES accounts(id),
  ejar_status           text NOT NULL DEFAULT 'not_registered' CHECK (ejar_status IN ('not_registered', 'pending', 'registered')),
  ejar_number           text,
  last_registered_rent  numeric(18,2),                                         -- the rent when the contract (or its last addendum) was registered
  nonrenewal_date       date,                                                   -- when a non-renewal notice was given ...
  nonrenewal_by         text,                                                   -- ... and by whom
  signed_at             timestamptz,
  created_by            uuid NOT NULL REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (ejar_status <> 'registered' OR btrim(coalesce(ejar_number, '')) <> ''),
  CHECK ((nonrenewal_date IS NULL) = (nonrenewal_by IS NULL))
);

CREATE FUNCTION before_tenancy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b bookings;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = NEW.booking_id;
  IF b.company_id IS DISTINCT FROM NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF b.contract_type <> 'long_term' THEN RAISE EXCEPTION 'A rental contract belongs to a long-term booking.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.income_account_id AND company_id = NEW.company_id AND type = 'income') THEN
    RAISE EXCEPTION 'Rent goes to an income account of this company.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now(); NEW.signed_at := NULL;
  ELSE
    IF NEW.company_id <> OLD.company_id OR NEW.booking_id <> OLD.booking_id THEN RAISE EXCEPTION 'A contract stays on its booking.'; END IF;
    IF OLD.signed_at IS NOT NULL THEN
      -- A signed contract is never edited. Only the Ejar registration, the last registered rent and a non-renewal notice move.
      IF NEW.signed_at IS DISTINCT FROM OLD.signed_at
         OR (to_jsonb(NEW) - 'ejar_status' - 'ejar_number' - 'last_registered_rent' - 'nonrenewal_date' - 'nonrenewal_by')
            <> (to_jsonb(OLD) - 'ejar_status' - 'ejar_number' - 'last_registered_rent' - 'nonrenewal_date' - 'nonrenewal_by') THEN
        RAISE EXCEPTION 'A signed contract does not change. Make the change by addendum.';
      END IF;
      IF OLD.nonrenewal_date IS NOT NULL AND (NEW.nonrenewal_date IS DISTINCT FROM OLD.nonrenewal_date OR NEW.nonrenewal_by IS DISTINCT FROM OLD.nonrenewal_by) THEN
        RAISE EXCEPTION 'A recorded non-renewal notice does not change.';
      END IF;
    ELSIF NEW.signed_at IS NOT NULL THEN
      NEW.signed_at := now();
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenancies_before_change BEFORE INSERT OR UPDATE ON booking_tenancies FOR EACH ROW EXECUTE FUNCTION before_tenancy();
CREATE TRIGGER tenancies_no_delete BEFORE DELETE ON booking_tenancies FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Addenda: changes to a signed rental. Appended, never changed. A rent above the last registered rent is refused in a frozen city.
CREATE TABLE booking_addenda (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  booking_id     uuid NOT NULL REFERENCES bookings(id),
  no             int NOT NULL CHECK (no >= 1),
  effective_date date NOT NULL,
  new_rent       numeric(18,2) CHECK (new_rent > 0),
  new_end        date,
  reason         text NOT NULL CHECK (btrim(reason) <> ''),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, no),
  CHECK (new_rent IS NOT NULL OR new_end IS NOT NULL)
);

CREATE FUNCTION before_addendum() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t booking_tenancies; b bookings; frozen text[];
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'An addendum is never changed or removed.'; END IF;
  SELECT * INTO t FROM booking_tenancies WHERE booking_id = NEW.booking_id;
  SELECT * INTO b FROM bookings WHERE id = NEW.booking_id;
  IF t.id IS NULL OR t.company_id <> NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF t.signed_at IS NULL THEN RAISE EXCEPTION 'Sign the contract first: an unsigned contract is edited directly.'; END IF;
  IF b.status IN ('departed', 'cancelled', 'no_show') THEN RAISE EXCEPTION 'This booking is finished and no longer changes.'; END IF;
  IF NEW.new_end IS NOT NULL AND NEW.new_end <= b.arrival THEN RAISE EXCEPTION 'The new end date is after the start date.'; END IF;
  IF NEW.new_rent IS NOT NULL AND t.last_registered_rent IS NOT NULL AND NEW.new_rent > t.last_registered_rent THEN
    SELECT frozen_cities INTO frozen FROM room_settings WHERE company_id = NEW.company_id;
    IF EXISTS (SELECT 1 FROM unnest(coalesce(frozen, ARRAY['Riyadh'])) c WHERE lower(btrim(c)) = lower(btrim(t.city))) THEN
      RAISE EXCEPTION 'Rent increases are blocked in %: the rent cannot go above the last registered rent of %.', btrim(t.city), t.last_registered_rent;
    END IF;
  END IF;
  IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  NEW.created_at := now();
  IF NEW.new_end IS NOT NULL THEN UPDATE bookings SET departure = NEW.new_end WHERE id = NEW.booking_id; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER addenda_before_change BEFORE INSERT OR UPDATE OR DELETE ON booking_addenda FOR EACH ROW EXECUTE FUNCTION before_addendum();

-- The payment schedule: unbilled instalments may be replaced by the service when an addendum changes the rent or end date.
CREATE TABLE booking_instalments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  booking_id   uuid NOT NULL REFERENCES bookings(id),
  no           int NOT NULL CHECK (no >= 1),
  due_date     date NOT NULL,
  amount       numeric(18,2) NOT NULL CHECK (amount > 0),
  document_id  uuid UNIQUE REFERENCES documents(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, no)
);

CREATE FUNCTION before_instalment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.document_id IS NOT NULL THEN
    -- the only change to a billed instalment: its draft invoice was deleted, which frees it
    IF TG_OP = 'UPDATE' AND NEW.document_id IS NULL AND NOT EXISTS (SELECT 1 FROM documents WHERE id = OLD.document_id)
       AND (to_jsonb(NEW) - 'document_id') = (to_jsonb(OLD) - 'document_id') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'This instalment has been billed and no longer changes.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NOT EXISTS (SELECT 1 FROM booking_tenancies t WHERE t.booking_id = NEW.booking_id AND t.company_id = NEW.company_id) THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF NEW.document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND company_id = NEW.company_id) THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF TG_OP = 'INSERT' THEN NEW.created_at := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER instalments_before_change BEFORE INSERT OR UPDATE OR DELETE ON booking_instalments FOR EACH ROW EXECUTE FUNCTION before_instalment();

-- ---------------------------------------------------------------------------
-- The registered Ejar contract PDF: an attachment on the booking. PDF only (never a picture, so never an ID photo), kept for good.
-- ---------------------------------------------------------------------------
ALTER TABLE attachments ADD COLUMN booking_id uuid REFERENCES bookings(id);
CREATE INDEX attachments_booking ON attachments (booking_id);
ALTER TABLE attachments DROP CONSTRAINT attachments_belongs_to_one;
ALTER TABLE attachments ADD CONSTRAINT attachments_belongs_to_one
  CHECK (num_nonnulls(document_id, stock_note_id, employee_document_id, portal_upload_id, booking_id) = 1);
ALTER TABLE attachments ADD CONSTRAINT attachments_booking_pdf_only CHECK (booking_id IS NULL OR content_type = 'application/pdf');

-- Same rule as 0024, plus: a booking's attachment stays for good (never a draft) and belongs to a long-term rental.
CREATE OR REPLACE FUNCTION before_attachment_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a attachments%ROWTYPE; draft boolean; u portal_uploads%ROWTYPE;
BEGIN
  a := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF a.portal_upload_id IS NOT NULL THEN SELECT * INTO u FROM portal_uploads WHERE id = a.portal_upload_id; END IF;
  draft := coalesce(CASE WHEN a.booking_id IS NOT NULL THEN false END,
                    (SELECT status = 'draft' FROM documents WHERE id = a.document_id),
                    (SELECT status = 'draft' FROM stock_notes WHERE id = a.stock_note_id),
                    CASE WHEN a.employee_document_id IS NOT NULL THEN true END,
                    CASE WHEN u.id IS NOT NULL THEN u.status = 'new' OR u.from_firm END);
  IF TG_OP = 'DELETE' THEN
    IF NOT draft THEN RAISE EXCEPTION 'Attachments of an issued document are kept. They can be added to, not removed.'; END IF;
    DELETE FROM attachment_files WHERE attachment_id = OLD.id;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'An attachment is never changed. Add a new one instead.'; END IF;
  IF app_user_id() IS NOT NULL THEN NEW.uploaded_by := app_user_id(); END IF;
  NEW.uploaded_at := now();
  IF (NEW.document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND company_id = NEW.company_id))
     OR (NEW.stock_note_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stock_notes WHERE id = NEW.stock_note_id AND company_id = NEW.company_id))
     OR (NEW.employee_document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employee_documents WHERE id = NEW.employee_document_id AND company_id = NEW.company_id))
     OR (NEW.booking_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bookings WHERE id = NEW.booking_id AND company_id = NEW.company_id))
     OR (NEW.portal_upload_id IS NOT NULL AND u.company_id IS DISTINCT FROM NEW.company_id) THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  IF NEW.booking_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bookings WHERE id = NEW.booking_id AND contract_type = 'long_term') THEN
    RAISE EXCEPTION 'Only a long-term rental takes the registered contract. Never attach a copy of an ID or passport.';
  END IF;
  IF NEW.portal_upload_id IS NOT NULL THEN
    IF u.uploaded_by <> NEW.uploaded_by THEN RAISE EXCEPTION 'Only the person who sent these documents adds files to them.'; END IF;
    IF u.status = 'processed' AND NOT u.from_firm THEN RAISE EXCEPTION 'Your accountant has dealt with these documents. Send new ones instead.'; END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Access and audit
-- ---------------------------------------------------------------------------
-- The audit rows for identity details carry only the last four characters of an ID number.
CREATE FUNCTION audit_identity_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb; o jsonb; k text;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  o := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
  FOREACH k IN ARRAY ARRAY['id_number', 'landlord_id_number', 'tenant_id_number'] LOOP
    IF r ? k THEN r := jsonb_set(r, ARRAY[k], to_jsonb('****' || right(r->>k, 4))); END IF;
    IF o IS NOT NULL AND o ? k THEN o := jsonb_set(o, ARRAY[k], to_jsonb('****' || right(o->>k, 4))); END IF;
  END LOOP;
  INSERT INTO audit_log (user_id, company_id, table_name, row_id, action, detail)
  VALUES (app_user_id(), (r->>'company_id')::uuid, TG_TABLE_NAME, r->>'id', lower(TG_OP),
          CASE WHEN o IS NULL THEN jsonb_build_object('row', r) ELSE jsonb_build_object('before', o, 'after', r) END);
  RETURN NULL;
END $$;

-- Reading identity details is itself logged: the registration record export, and opening a booking's details.
CREATE FUNCTION room_log_identity_access(p_company uuid, p_what text, p_detail jsonb DEFAULT '{}'::jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_has_role(p_company, posting_roles()) THEN RAISE EXCEPTION 'Your role does not allow this.'; END IF;
  INSERT INTO audit_log (user_id, company_id, table_name, row_id, action, detail) VALUES (app_user_id(), p_company, 'booking_guest_checks', NULL, p_what, p_detail);
END $$;
GRANT EXECUTE ON FUNCTION room_log_identity_access(uuid, text, jsonb) TO nusuh_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['room_settings', 'room_charge_lines', 'booking_addenda', 'booking_instalments'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['booking_guest_checks', 'booking_tenancies'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_identity_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- identity details: only people who can post (not viewers, not reviewers)
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()) AND app_has_role(company_id, posting_roles()))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_update', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nusuh_app', t);
  END LOOP;
END $$;

-- settings and charge lines: only the company administrator changes them
CREATE POLICY room_settings_insert ON room_settings FOR INSERT WITH CHECK (app_is_company_admin(company_id));
CREATE POLICY room_settings_update ON room_settings FOR UPDATE USING (app_is_company_admin(company_id)) WITH CHECK (app_is_company_admin(company_id));
CREATE POLICY room_charge_lines_insert ON room_charge_lines FOR INSERT WITH CHECK (app_is_company_admin(company_id));
CREATE POLICY room_charge_lines_update ON room_charge_lines FOR UPDATE USING (app_is_company_admin(company_id)) WITH CHECK (app_is_company_admin(company_id));
GRANT SELECT, INSERT, UPDATE ON room_settings, room_charge_lines TO nusuh_app;

-- addenda and instalments: those who can post
CREATE POLICY booking_addenda_insert ON booking_addenda FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY booking_instalments_insert ON booking_instalments FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY booking_instalments_update ON booking_instalments FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY booking_instalments_delete ON booking_instalments FOR DELETE USING (app_has_role(company_id, posting_roles()));
GRANT SELECT, INSERT ON booking_addenda TO nusuh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON booking_instalments TO nusuh_app;
