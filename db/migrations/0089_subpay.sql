-- 0089 Manual bank-transfer payments ("subpay"): orders, the customer's "I paid" form, review decisions, and an append-only trail.
--
-- Money is SAR only, in halalas (bigint). A customer buys by bank transfer; a person at Nusuh Books checks the bank and approves.
-- This builds on the existing purchase path instead of replacing it: an order wraps the customer's waiting trial order (its lines, modules and the
-- prices from Payment settings), and approval runs the EXISTING conversion in the same transaction (the same customer becomes a paying one, the
-- first invoice is made and marked paid). Nothing here touches ledger, journal or customer-invoice tables.
--
--   Statuses (the database refuses every other move):
--     created -> awaiting_payment -> submitted -> under_review -> approved | rejected | needs_info -> under_review ; any open one -> expired ;
--     approved -> refunded | partially_refunded
--   Rights: customers place and submit (their own order only); people with payments.view see the queue; payments.review may recommend, reject or ask
--   for more information; ONLY the Owner role approves (approval converts and bills a customer, and those functions are Owner-only already).
--   Self-approval is refused; a second approval of the same order is impossible (the order row is locked, and the customer can only be converted once).
--   The feature flag subpay.settings.payments_enabled is OFF: with it off every customer function refuses and nothing else changes.
--   The app role has no table rights here: it reaches everything through the functions below.

CREATE SCHEMA subpay;
GRANT USAGE ON SCHEMA subpay TO nusuh_app;

CREATE TABLE subpay.settings (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
  payments_enabled    boolean NOT NULL DEFAULT false,
  review_target_hours int NOT NULL DEFAULT 4 CHECK (review_target_hours BETWEEN 1 AND 168),
  order_open_days     int NOT NULL DEFAULT 14 CHECK (order_open_days BETWEEN 1 AND 90),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO subpay.settings DEFAULT VALUES;

CREATE TABLE subpay.orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id        uuid NOT NULL REFERENCES public.firms(id),
  trial_order_id uuid NOT NULL REFERENCES public.trial_orders(id),
  currency       char(3) NOT NULL DEFAULT 'SAR' CHECK (currency = 'SAR'),
  subtotal_halalas bigint NOT NULL CHECK (subtotal_halalas > 0),
  vat_rate       numeric(5,2) NOT NULL CHECK (vat_rate BETWEEN 0 AND 100),
  vat_halalas    bigint NOT NULL CHECK (vat_halalas >= 0),
  total_halalas  bigint NOT NULL CHECK (total_halalas > 0),
  reference      text NOT NULL UNIQUE CHECK (reference ~ '^NB-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]$'),
  status         text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('created', 'awaiting_payment', 'submitted', 'under_review', 'approved', 'rejected', 'needs_info', 'expired', 'refunded', 'partially_refunded')),
  created_by     uuid NOT NULL REFERENCES public.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  recommended_by uuid REFERENCES public.users(id),
  decided_by     uuid REFERENCES public.users(id),
  decided_at     timestamptz,
  CHECK (total_halalas = subtotal_halalas + vat_halalas),
  CHECK ((status IN ('approved', 'refunded', 'partially_refunded')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL AND status <> 'rejected') OR status = 'rejected')
);
CREATE INDEX subpay_orders_firm ON subpay.orders (firm_id, created_at DESC);
CREATE INDEX subpay_orders_trial ON subpay.orders (trial_order_id);
-- only one order per waiting trial order can be open at a time
CREATE UNIQUE INDEX subpay_one_open ON subpay.orders (trial_order_id) WHERE status IN ('created', 'awaiting_payment', 'submitted', 'under_review', 'needs_info');

CREATE TABLE subpay.order_events (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES subpay.orders(id),
  at          timestamptz NOT NULL DEFAULT now(),
  actor       uuid REFERENCES public.users(id),
  from_status text,
  to_status   text NOT NULL,
  client_note text CHECK (char_length(client_note) <= 1000),   -- shown to the customer (the reason, or what is missing)
  staff_note  text CHECK (char_length(staff_note) <= 1000)     -- shown to staff only
);
CREATE INDEX subpay_events_order ON subpay.order_events (order_id, id);
CREATE TRIGGER subpay_events_immutable BEFORE UPDATE OR DELETE ON subpay.order_events FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

CREATE TABLE subpay.submissions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES subpay.orders(id),
  amount_halalas bigint NOT NULL CHECK (amount_halalas > 0 AND amount_halalas <= 100000000000),
  transfer_date  date NOT NULL,
  sender_bank    text CHECK (char_length(sender_bank) <= 120),
  bank_ref       text CHECK (char_length(bank_ref) <= 80),
  note           text CHECK (char_length(note) <= 1000),
  flags          text[] NOT NULL DEFAULT '{}',   -- what the system noticed: duplicate_file, duplicate_bank_ref, amount_under, amount_over
  created_by     uuid NOT NULL REFERENCES public.users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subpay_submissions_order ON subpay.submissions (order_id, created_at DESC);
CREATE INDEX subpay_submissions_bankref ON subpay.submissions (lower(bank_ref)) WHERE bank_ref IS NOT NULL;

CREATE TABLE subpay.files (
  submission_id uuid PRIMARY KEY REFERENCES subpay.submissions(id),
  name   text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  type   text NOT NULL CHECK (type IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes  bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 5242880)
);
CREATE INDEX subpay_files_hash ON subpay.files (sha256);

ALTER TABLE subpay.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE subpay.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE subpay.order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE subpay.submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subpay.files ENABLE ROW LEVEL SECURITY;
-- no policies and no table grants for nusuh_app: only the functions below reach these tables
CREATE TRIGGER subpay_orders_audit      AFTER INSERT OR UPDATE OR DELETE ON subpay.orders      FOR EACH ROW EXECUTE FUNCTION public.audit_row();
CREATE TRIGGER subpay_submissions_audit AFTER INSERT OR UPDATE OR DELETE ON subpay.submissions FOR EACH ROW EXECUTE FUNCTION public.audit_row();
CREATE TRIGGER subpay_settings_audit    AFTER INSERT OR UPDATE OR DELETE ON subpay.settings    FOR EACH ROW EXECUTE FUNCTION public.audit_row();

-- ---------------------------------------------------------------------------
-- The status machine: the database refuses every move that is not listed
-- ---------------------------------------------------------------------------
CREATE FUNCTION subpay.before_order_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.firm_id <> NEW.firm_id OR OLD.reference <> NEW.reference OR OLD.total_halalas <> NEW.total_halalas OR OLD.subtotal_halalas <> NEW.subtotal_halalas OR OLD.vat_halalas <> NEW.vat_halalas
     OR OLD.vat_rate <> NEW.vat_rate OR OLD.trial_order_id <> NEW.trial_order_id OR OLD.currency <> NEW.currency OR OLD.created_by <> NEW.created_by THEN
    RAISE EXCEPTION 'The amounts, reference and customer of an order never change.';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM (VALUES
      ('created', 'awaiting_payment'), ('created', 'expired'),
      ('awaiting_payment', 'submitted'), ('awaiting_payment', 'expired'),
      ('submitted', 'under_review'), ('submitted', 'expired'),
      ('under_review', 'approved'), ('under_review', 'rejected'), ('under_review', 'needs_info'),
      ('needs_info', 'under_review'), ('needs_info', 'expired'), ('needs_info', 'rejected'),
      ('approved', 'refunded'), ('approved', 'partially_refunded'), ('partially_refunded', 'refunded')
    ) AS m(f, t) WHERE m.f = OLD.status AND m.t = NEW.status) THEN
    RAISE EXCEPTION 'An order cannot move from % to %.', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subpay_orders_status BEFORE UPDATE ON subpay.orders FOR EACH ROW EXECUTE FUNCTION subpay.before_order_status();

-- ---------------------------------------------------------------------------
-- References: NB-XXXX-XXXX-C. Random (from the database's secure generator), no look-alike letters, last character is a check character.
-- ---------------------------------------------------------------------------
CREATE FUNCTION subpay.ref_check(p_body text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE alpha constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; s int := 0; i int; p int;
BEGIN
  FOR i IN 1..char_length(p_body) LOOP
    p := position(substr(p_body, i, 1) IN alpha) - 1;
    IF p < 0 THEN RETURN NULL; END IF;
    s := s + p * (i + 1);
  END LOOP;
  RETURN substr(alpha, (s % 31) + 1, 1);
END $$;

CREATE FUNCTION subpay.ref_valid(p_ref text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_ref ~ '^NB-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]$'
     AND subpay.ref_check(substr(p_ref, 4, 4) || substr(p_ref, 9, 4)) = substr(p_ref, 14, 1)
$$;

CREATE FUNCTION subpay.ref_make() RETURNS text LANGUAGE plpgsql AS $$
DECLARE alpha constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; body text; b bytea; i int; r text;
BEGIN
  FOR n IN 1..20 LOOP
    b := uuid_send(gen_random_uuid()); body := '';
    FOR i IN 0..7 LOOP body := body || substr(alpha, (get_byte(b, i) % 31) + 1, 1); END LOOP;
    r := 'NB-' || substr(body, 1, 4) || '-' || substr(body, 5, 4) || '-' || subpay.ref_check(body);
    IF NOT EXISTS (SELECT 1 FROM subpay.orders WHERE reference = r) THEN RETURN r; END IF;
  END LOOP;
  RAISE EXCEPTION 'Could not make a payment reference. Try again.';
END $$;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION subpay.enabled() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
  SELECT payments_enabled FROM subpay.settings
$$;

/** A customer's own person (not platform staff). */
CREATE FUNCTION subpay.customer_firm() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE f uuid;
BEGIN
  IF app_user_id() IS NULL OR EXISTS (SELECT 1 FROM users WHERE id = app_user_id() AND kind = 'owner') THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  f := app_firm_id();
  IF f IS NULL THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  RETURN f;
END $$;

CREATE FUNCTION subpay.file_ok(p_type text, p_bytes bytea) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type
    WHEN 'application/pdf' THEN encode(substring(p_bytes from 1 for 4), 'hex') = '25504446'
    WHEN 'image/png'       THEN encode(substring(p_bytes from 1 for 4), 'hex') = '89504e47'
    WHEN 'image/jpeg'      THEN encode(substring(p_bytes from 1 for 3), 'hex') = 'ffd8ff'
    WHEN 'image/webp'      THEN encode(substring(p_bytes from 1 for 4), 'hex') = '52494646' AND encode(substring(p_bytes from 9 for 4), 'hex') = '57454250'
    ELSE false END
$$;

CREATE FUNCTION subpay.event(p_order uuid, p_from text, p_to text, p_client text, p_staff text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
  INSERT INTO subpay.order_events (order_id, actor, from_status, to_status, client_note, staff_note) VALUES (p_order, app_user_id(), p_from, p_to, p_client, p_staff)
$$;

-- ---------------------------------------------------------------------------
-- The customer
-- ---------------------------------------------------------------------------
/** Place (or return) the order for the customer's waiting trial order. The amounts are worked out here from the stored trial order and the VAT rate; the caller sends nothing. */
CREATE FUNCTION subpay.place_order() RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE f uuid := subpay.customer_firm(); t trial_orders; b billing_settings; o subpay.orders; sub bigint; vat bigint; s subpay.settings; nid uuid;
BEGIN
  SELECT * INTO s FROM subpay.settings;
  IF NOT s.payments_enabled THEN RAISE EXCEPTION 'Payment by bank transfer is not switched on yet.'; END IF;
  SELECT * INTO t FROM trial_orders WHERE firm_id = f AND status = 'waiting' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Place an order first.'; END IF;
  SELECT * INTO b FROM billing_settings;
  IF b.currency <> 'SAR' THEN RAISE EXCEPTION 'Payments are in Saudi riyals (SAR) only for now.'; END IF;
  IF coalesce(b.bank_account_name, '') = '' OR coalesce(b.bank_name, '') = '' OR coalesce(b.bank_iban, '') = '' THEN RAISE EXCEPTION 'The bank details are not ready yet. Contact us.'; END IF;
  SELECT * INTO o FROM subpay.orders WHERE trial_order_id = t.id AND status IN ('created', 'awaiting_payment', 'submitted', 'under_review', 'needs_info');
  IF FOUND THEN RETURN o.id; END IF;
  -- an unsubmitted order for an older trial order is closed
  FOR o IN SELECT * FROM subpay.orders WHERE firm_id = f AND status = 'awaiting_payment' FOR UPDATE LOOP
    UPDATE subpay.orders SET status = 'expired' WHERE id = o.id;
    PERFORM subpay.event(o.id, 'awaiting_payment', 'expired', NULL, 'replaced by a newer order');
  END LOOP;
  sub := round(t.one_time_total * 100)::bigint + round(t.yearly_total * 100)::bigint;
  vat := round(sub * b.vat_rate / 100)::bigint;
  INSERT INTO subpay.orders (firm_id, trial_order_id, subtotal_halalas, vat_rate, vat_halalas, total_halalas, reference, created_by, expires_at)
  VALUES (f, t.id, sub, b.vat_rate, vat, sub + vat, subpay.ref_make(), app_user_id(), now() + make_interval(days => s.order_open_days)) RETURNING id INTO nid;
  PERFORM subpay.event(nid, NULL, 'awaiting_payment', NULL, NULL);
  RETURN nid;
END $$;

/** The customer's latest order, the bank details to pay into, and its timeline. NULL when there is none. */
CREATE FUNCTION subpay.my_order() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE f uuid := subpay.customer_firm(); o subpay.orders; b billing_settings; s subpay.settings; sub subpay.submissions;
BEGIN
  SELECT * INTO s FROM subpay.settings;
  IF NOT s.payments_enabled THEN RETURN NULL; END IF;
  SELECT * INTO o FROM subpay.orders WHERE firm_id = f ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO b FROM billing_settings;
  SELECT * INTO sub FROM subpay.submissions WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1;
  RETURN jsonb_build_object('id', o.id, 'reference', o.reference, 'status', o.status, 'currency', o.currency,
    'subtotalHalalas', o.subtotal_halalas, 'vatRate', o.vat_rate::text, 'vatHalalas', o.vat_halalas, 'totalHalalas', o.total_halalas,
    'expiresAt', o.expires_at, 'reviewTargetHours', s.review_target_hours,
    'bank', CASE WHEN o.status IN ('awaiting_payment', 'needs_info') THEN jsonb_build_object('accountName', b.bank_account_name, 'bank', b.bank_name, 'iban', b.bank_iban) END,
    'submission', CASE WHEN sub.id IS NOT NULL THEN jsonb_build_object('amountHalalas', sub.amount_halalas, 'date', sub.transfer_date, 'senderBank', sub.sender_bank, 'bankRef', sub.bank_ref, 'at', sub.created_at) END,
    'timeline', (SELECT coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'status', e.to_status, 'note', e.client_note) ORDER BY e.id), '[]') FROM subpay.order_events e WHERE e.order_id = o.id));
END $$;

/** "I have paid": amount, date, sender bank, bank reference, a note, and optionally the slip. Goes straight into review. */
CREATE FUNCTION subpay.submit(p_order uuid, p_amount bigint, p_date date, p_bank text, p_ref text, p_note text, p_name text, p_type text, p_bytes bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE f uuid := subpay.customer_firm(); o subpay.orders; sid uuid; fl text[] := '{}'; h text;
BEGIN
  SELECT * INTO o FROM subpay.orders WHERE id = p_order AND firm_id = f FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found.'; END IF;
  IF o.status NOT IN ('awaiting_payment', 'needs_info') THEN RAISE EXCEPTION 'This order is not waiting for a payment.'; END IF;
  IF o.status = 'awaiting_payment' AND o.expires_at < now() THEN RAISE EXCEPTION 'This order has expired. Start a new one.'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 100000000000 THEN RAISE EXCEPTION 'Enter the amount you transferred.'; END IF;
  IF p_date IS NULL OR p_date > current_date + 1 OR p_date < current_date - 90 THEN RAISE EXCEPTION 'Enter the date of the transfer (within the last 90 days).'; END IF;
  IF char_length(coalesce(p_bank, '')) > 120 OR char_length(coalesce(p_ref, '')) > 80 OR char_length(coalesce(p_note, '')) > 1000 THEN RAISE EXCEPTION 'One of the texts is too long.'; END IF;
  IF (SELECT count(*) FROM subpay.submissions WHERE order_id = o.id AND created_at > now() - interval '1 day') >= 5 THEN RAISE EXCEPTION 'Too many tries today. Contact us.'; END IF;
  IF p_bytes IS NOT NULL THEN
    IF octet_length(p_bytes) NOT BETWEEN 1 AND 5242880 THEN RAISE EXCEPTION 'The file must be under 5 MB.'; END IF;
    IF NOT subpay.file_ok(p_type, p_bytes) THEN RAISE EXCEPTION 'Send a PDF, PNG, JPG or WebP file.'; END IF;
    h := encode(sha256(p_bytes), 'hex');
    IF EXISTS (SELECT 1 FROM subpay.files x JOIN subpay.submissions s ON s.id = x.submission_id WHERE x.sha256 = h AND s.order_id <> o.id) THEN fl := fl || 'duplicate_file'::text; END IF;
  END IF;
  IF nullif(btrim(coalesce(p_ref, '')), '') IS NOT NULL
     AND EXISTS (SELECT 1 FROM subpay.submissions s WHERE lower(s.bank_ref) = lower(btrim(p_ref)) AND s.order_id <> o.id) THEN fl := fl || 'duplicate_bank_ref'::text; END IF;
  IF p_amount < o.total_halalas THEN fl := fl || 'amount_under'::text; ELSIF p_amount > o.total_halalas THEN fl := fl || 'amount_over'::text; END IF;
  INSERT INTO subpay.submissions (order_id, amount_halalas, transfer_date, sender_bank, bank_ref, note, flags, created_by)
  VALUES (o.id, p_amount, p_date, nullif(btrim(coalesce(p_bank, '')), ''), nullif(btrim(coalesce(p_ref, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), fl, app_user_id()) RETURNING id INTO sid;
  IF p_bytes IS NOT NULL THEN INSERT INTO subpay.files (submission_id, name, type, sha256, bytes) VALUES (sid, left(coalesce(nullif(btrim(p_name), ''), 'slip'), 200), p_type, h, p_bytes); END IF;
  IF o.status = 'awaiting_payment' THEN
    UPDATE subpay.orders SET status = 'submitted' WHERE id = o.id;
    PERFORM subpay.event(o.id, 'awaiting_payment', 'submitted', NULL, NULL);
    UPDATE subpay.orders SET status = 'under_review' WHERE id = o.id;
    PERFORM subpay.event(o.id, 'submitted', 'under_review', NULL, NULL);
  ELSE
    UPDATE subpay.orders SET status = 'under_review' WHERE id = o.id;
    PERFORM subpay.event(o.id, 'needs_info', 'under_review', NULL, 'customer answered');
  END IF;
  RETURN sid;
END $$;

-- ---------------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------------
CREATE FUNCTION subpay.need(p_perm text) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
BEGIN
  IF NOT app_staff_can(p_perm) THEN RAISE EXCEPTION 'Your role does not allow this.'; END IF;
END $$;

CREATE FUNCTION subpay.queue() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE s subpay.settings;
BEGIN
  PERFORM subpay.need('payments.view');
  SELECT * INTO s FROM subpay.settings;
  RETURN jsonb_build_object('reviewTargetHours', s.review_target_hours, 'enabled', s.payments_enabled, 'orders', (SELECT coalesce(jsonb_agg(q ORDER BY q->>'waitingSince'), '[]') FROM (
    SELECT jsonb_build_object('id', o.id, 'reference', o.reference, 'status', o.status, 'firmId', o.firm_id, 'firm', f.name, 'totalHalalas', o.total_halalas,
      'enteredHalalas', sub.amount_halalas, 'flags', coalesce(sub.flags, '{}'), 'recommended', o.recommended_by IS NOT NULL, 'hasFile', fl.submission_id IS NOT NULL,
      'waitingSince', sub.created_at, 'hoursWaiting', round(extract(epoch FROM now() - sub.created_at) / 3600, 1),
      'overdue', extract(epoch FROM now() - sub.created_at) / 3600 > s.review_target_hours) AS q
    FROM subpay.orders o JOIN firms f ON f.id = o.firm_id
    JOIN LATERAL (SELECT * FROM subpay.submissions x WHERE x.order_id = o.id ORDER BY x.created_at DESC LIMIT 1) sub ON true
    LEFT JOIN subpay.files fl ON fl.submission_id = sub.id
    WHERE o.status IN ('under_review', 'needs_info')) z));
END $$;

CREATE FUNCTION subpay.order_detail(p_order uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE o subpay.orders; f firms;
BEGIN
  PERFORM subpay.need('payments.view');
  SELECT * INTO o FROM subpay.orders WHERE id = p_order;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found.'; END IF;
  SELECT * INTO f FROM firms WHERE id = o.firm_id;
  RETURN jsonb_build_object('id', o.id, 'reference', o.reference, 'status', o.status, 'firm', f.name, 'firmId', o.firm_id, 'currency', o.currency,
    'subtotalHalalas', o.subtotal_halalas, 'vatRate', o.vat_rate::text, 'vatHalalas', o.vat_halalas, 'totalHalalas', o.total_halalas, 'createdAt', o.created_at,
    'recommendedBy', (SELECT full_name FROM users WHERE id = o.recommended_by),
    'submissions', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'amountHalalas', s.amount_halalas, 'date', s.transfer_date, 'senderBank', s.sender_bank, 'bankRef', s.bank_ref,
        'note', s.note, 'flags', s.flags, 'at', s.created_at, 'file', CASE WHEN x.submission_id IS NOT NULL THEN jsonb_build_object('name', x.name, 'type', x.type) END) ORDER BY s.created_at DESC), '[]')
      FROM subpay.submissions s LEFT JOIN subpay.files x ON x.submission_id = s.id WHERE s.order_id = o.id),
    'timeline', (SELECT coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'status', e.to_status, 'by', (SELECT full_name FROM users WHERE id = e.actor), 'clientNote', e.client_note, 'staffNote', e.staff_note) ORDER BY e.id), '[]')
      FROM subpay.order_events e WHERE e.order_id = o.id));
END $$;

CREATE FUNCTION subpay.file_get(p_submission uuid) RETURNS TABLE (name text, type text, bytes bytea) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
BEGIN
  PERFORM subpay.need('payments.view');
  RETURN QUERY SELECT x.name, x.type, x.bytes FROM subpay.files x WHERE x.submission_id = p_submission;
END $$;

/** Locks the order and returns it, for a review action; refuses a customer's order the actor placed (nobody reviews their own). */
CREATE FUNCTION subpay.lock_for_review(p_order uuid, p_from text[]) RETURNS subpay.orders LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE o subpay.orders;
BEGIN
  SELECT * INTO o FROM subpay.orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found.'; END IF;
  IF o.created_by = app_user_id() THEN RAISE EXCEPTION 'You cannot review a payment you made yourself.'; END IF;
  IF NOT o.status = ANY (p_from) THEN RAISE EXCEPTION 'This payment is % and cannot be changed this way.', o.status; END IF;
  RETURN o;
END $$;

CREATE FUNCTION subpay.recommend(p_order uuid, p_note text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE o subpay.orders;
BEGIN
  PERFORM subpay.need('payments.review');
  o := subpay.lock_for_review(p_order, ARRAY['under_review']);
  UPDATE subpay.orders SET recommended_by = app_user_id() WHERE id = o.id;
  PERFORM subpay.event(o.id, o.status, o.status, NULL, 'recommended for approval' || coalesce(': ' || nullif(left(btrim(p_note), 500), ''), ''));
END $$;

CREATE FUNCTION subpay.reject(p_order uuid, p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE o subpay.orders;
BEGIN
  PERFORM subpay.need('payments.review');
  IF char_length(btrim(coalesce(p_reason, ''))) < 3 OR char_length(p_reason) > 1000 THEN RAISE EXCEPTION 'Give the reason (3 to 1000 letters). The customer will read it.'; END IF;
  o := subpay.lock_for_review(p_order, ARRAY['under_review', 'needs_info']);
  UPDATE subpay.orders SET status = 'rejected', decided_by = app_user_id(), decided_at = now() WHERE id = o.id;
  PERFORM subpay.event(o.id, o.status, 'rejected', btrim(p_reason), NULL);
END $$;

CREATE FUNCTION subpay.need_info(p_order uuid, p_message text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE o subpay.orders;
BEGIN
  PERFORM subpay.need('payments.review');
  IF char_length(btrim(coalesce(p_message, ''))) < 3 OR char_length(p_message) > 1000 THEN RAISE EXCEPTION 'Say what is missing (3 to 1000 letters). The customer will read it.'; END IF;
  o := subpay.lock_for_review(p_order, ARRAY['under_review']);
  UPDATE subpay.orders SET status = 'needs_info' WHERE id = o.id;
  PERFORM subpay.event(o.id, o.status, 'needs_info', btrim(p_message), NULL);
END $$;

/** Step 1 of approving (Owner role only): lock the order and check it can be approved; returns what the conversion needs. */
CREATE FUNCTION subpay.begin_approve(p_order uuid, p_override text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE o subpay.orders; sub subpay.submissions; t trial_orders;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the Owner role approves a payment.'; END IF;
  o := subpay.lock_for_review(p_order, ARRAY['under_review']);
  SELECT * INTO sub FROM subpay.submissions WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'The customer has not said they paid.'; END IF;
  SELECT * INTO t FROM trial_orders WHERE id = o.trial_order_id FOR UPDATE;
  IF t.status <> 'waiting' THEN RAISE EXCEPTION 'The order behind this payment is no longer waiting (it was settled another way). Check the customer before doing anything.'; END IF;
  IF sub.amount_halalas <> o.total_halalas AND char_length(btrim(coalesce(p_override, ''))) < 5 THEN
    RAISE EXCEPTION 'The amount transferred differs from the amount due. Give the reason to approve anyway.';
  END IF;
  RETURN jsonb_build_object('firmId', o.firm_id, 'modules', t.modules, 'cleanup', t.cleanup, 'reference', o.reference, 'paidOn', sub.transfer_date,
    'totalHalalas', o.total_halalas, 'enteredHalalas', sub.amount_halalas, 'override', nullif(btrim(coalesce(p_override, '')), ''));
END $$;

/** Step 2 (same transaction, after the existing conversion): record the approval. Refuses unless the customer really was converted. */
CREATE FUNCTION subpay.finish_approve(p_order uuid, p_invoice text, p_override text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE o subpay.orders;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the Owner role approves a payment.'; END IF;
  o := subpay.lock_for_review(p_order, ARRAY['under_review']);
  IF NOT EXISTS (SELECT 1 FROM trial_orders WHERE id = o.trial_order_id AND status = 'paid') THEN RAISE EXCEPTION 'The customer was not converted, so the payment is not approved.'; END IF;
  UPDATE subpay.orders SET status = 'approved', decided_by = app_user_id(), decided_at = now() WHERE id = o.id;
  PERFORM subpay.event(o.id, 'under_review', 'approved', NULL, 'invoice ' || coalesce(p_invoice, '') || coalesce('; amount differed: ' || nullif(btrim(p_override), ''), ''));
END $$;

/** Settings (Owner role / payments.settings): the on-off switch, the review target, how long an unpaid order stays open. */
CREATE FUNCTION subpay.settings_get() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
BEGIN
  PERFORM subpay.need('payments.view');
  RETURN (SELECT jsonb_build_object('enabled', payments_enabled, 'reviewTargetHours', review_target_hours, 'orderOpenDays', order_open_days) FROM subpay.settings);
END $$;

CREATE FUNCTION subpay.settings_set(p_enabled boolean, p_hours int, p_days int) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
BEGIN
  PERFORM subpay.need('payments.settings');
  IF p_hours NOT BETWEEN 1 AND 168 OR p_days NOT BETWEEN 1 AND 90 OR p_enabled IS NULL THEN RAISE EXCEPTION 'Check the settings: review time 1 to 168 hours, open days 1 to 90.'; END IF;
  UPDATE subpay.settings SET payments_enabled = p_enabled, review_target_hours = p_hours, order_open_days = p_days, updated_at = now();
END $$;

/** Closes orders nobody paid in time. Owner role (and the daily job, once wired). Returns how many. */
CREATE FUNCTION subpay.expire_stale() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE n int := 0; o subpay.orders;
BEGIN
  PERFORM subpay.need('payments.settings');
  FOR o IN SELECT * FROM subpay.orders WHERE status = 'awaiting_payment' AND expires_at < now() FOR UPDATE SKIP LOCKED LOOP
    UPDATE subpay.orders SET status = 'expired' WHERE id = o.id;
    PERFORM subpay.event(o.id, 'awaiting_payment', 'expired', 'This order was not paid in time. Start a new one.', 'expired');
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA subpay FROM PUBLIC;
GRANT EXECUTE ON FUNCTION subpay.place_order(), subpay.my_order(), subpay.submit(uuid, bigint, date, text, text, text, text, text, bytea), subpay.queue(), subpay.order_detail(uuid),
  subpay.file_get(uuid), subpay.recommend(uuid, text), subpay.reject(uuid, text), subpay.need_info(uuid, text), subpay.begin_approve(uuid, text), subpay.finish_approve(uuid, text, text),
  subpay.settings_get(), subpay.settings_set(boolean, int, int), subpay.expire_stale(), subpay.ref_valid(text) TO nusuh_app;
