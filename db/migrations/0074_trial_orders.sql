-- 0074 Buying inside the software: the order, the payment confirmation, the bank details, and the owner's view of every trial.
--
-- A customer in a trial (or locked, or closed before deletion) places an order for the optional modules it wants and the optional
-- accounts clean-up; the amounts are worked out HERE from the prices in Payment settings (never from the browser). It transfers the
-- money by bank, then confirms the payment (amount, date, reference, optional proof). The platform owner checks the bank and marks it
-- paid: that converts the SAME customer to a paying one (all data stays), switches off the optional modules that were not bought,
-- and (in src/books/trialOrders.ts) makes and settles the first invoice and thanks the customer. Every step is recorded.
-- Bank details are set by the owner in Payment settings; until all four are filled the screens say they come with the invoice.
-- The proof of payment is kept apart from the order (and out of the audit log) and only the owner can read it.

ALTER TABLE billing_settings
  ADD COLUMN bank_account_name text CHECK (char_length(bank_account_name) <= 120),
  ADD COLUMN bank_name         text CHECK (char_length(bank_name) <= 120),
  ADD COLUMN bank_iban         text CHECK (bank_iban IS NULL OR bank_iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  ADD COLUMN bank_swift        text CHECK (bank_swift IS NULL OR bank_swift ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$');

-- When someone last signed in (kept apart from the user row so every sign-in does not fill the audit log).
CREATE TABLE user_last_login (user_id uuid PRIMARY KEY REFERENCES users(id), at timestamptz NOT NULL);
ALTER TABLE user_last_login ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION record_login(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Only the server records sign-ins.'; END IF;
  INSERT INTO user_last_login (user_id, at) VALUES (p_user, now()) ON CONFLICT (user_id) DO UPDATE SET at = excluded.at;
END $$;

ALTER TABLE subscription_events DROP CONSTRAINT subscription_events_kind_check;
ALTER TABLE subscription_events ADD CONSTRAINT subscription_events_kind_check
  CHECK (kind IN ('trial_started', 'trial_extended', 'trial_ended', 'converted', 'reactivated', 'cancelled', 'reminder_resent'));

CREATE TABLE trial_orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id              uuid NOT NULL REFERENCES firms(id),
  status               text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'paid', 'cancelled')),
  modules              text[] NOT NULL DEFAULT '{}' CHECK (modules <@ ARRAY['Inventory', 'Restaurant', 'Rooms', 'Assets', 'Rentals', 'Projects', 'HRM', 'CRM']),
  cleanup              boolean NOT NULL DEFAULT false,
  currency             char(3) NOT NULL,
  lines                jsonb NOT NULL,      -- the prices the customer was shown: [{key, name, quantity, amount}]
  one_time_total       numeric(18,2) NOT NULL CHECK (one_time_total >= 0),   -- before VAT
  yearly_total         numeric(18,2) NOT NULL CHECK (yearly_total >= 0),     -- before VAT
  placed_by            uuid REFERENCES users(id),
  placed_at            timestamptz NOT NULL DEFAULT now(),
  payment_confirmed_at timestamptz,
  payment_amount       numeric(18,2) CHECK (payment_amount > 0 AND payment_amount <= 10000000),
  payment_date         date,
  payment_reference    text CHECK (char_length(payment_reference) BETWEEN 1 AND 80),
  proof_name           text,
  paid_at              timestamptz,
  paid_by              uuid REFERENCES users(id),
  paid_reference       text,
  CHECK (cardinality(modules) <= 8)
);
CREATE UNIQUE INDEX trial_orders_one_waiting ON trial_orders (firm_id) WHERE status = 'waiting';
CREATE INDEX trial_orders_firm ON trial_orders (firm_id, placed_at DESC);

CREATE TABLE trial_order_proofs (
  order_id uuid PRIMARY KEY REFERENCES trial_orders(id),
  name     text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  type     text NOT NULL CHECK (type IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  bytes    bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 5242880)
);
ALTER TABLE trial_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial_order_proofs ENABLE ROW LEVEL SECURITY;
CREATE POLICY trial_orders_owner ON trial_orders FOR SELECT USING (app_is_owner());
CREATE POLICY trial_order_proofs_owner ON trial_order_proofs FOR SELECT USING (app_is_owner());
GRANT SELECT ON trial_orders, trial_order_proofs TO nusuh_app;   -- written only by the functions below
CREATE TRIGGER trial_orders_audit AFTER INSERT OR UPDATE OR DELETE ON trial_orders FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ---------------------------------------------------------------------------
-- The customer: place an order, see it with the bank details, confirm the payment
-- ---------------------------------------------------------------------------
/** The amounts of an order, from the prices in Payment settings: [lines, one_time_total, yearly_total, currency]. */
CREATE FUNCTION trial_order_quote(p_modules text[], p_cleanup boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d jsonb := public_site_data(); n int := coalesce(cardinality(p_modules), 0); lines jsonb := '[]'; impl numeric; clean numeric; yr numeric; perm numeric;
BEGIN
  SELECT (l->>'amount')::numeric INTO impl FROM jsonb_array_elements(d->'lines') l WHERE l->>'key' = 'implementation';
  SELECT (l->>'amount')::numeric INTO clean FROM jsonb_array_elements(d->'lines') l WHERE l->>'key' = 'cleanup';
  SELECT (l->>'amount')::numeric INTO yr FROM jsonb_array_elements(d->'lines') l WHERE l->>'key' = 'annualCore';
  SELECT (l->>'amount')::numeric INTO perm FROM jsonb_array_elements(d->'lines') l WHERE l->>'key' = 'perModule';
  lines := jsonb_build_array(
    jsonb_build_object('key', 'implementation', 'quantity', 1, 'amount', impl),
    jsonb_build_object('key', 'annualCore', 'quantity', 1, 'amount', yr));
  IF p_cleanup THEN lines := lines || jsonb_build_object('key', 'cleanup', 'quantity', 1, 'amount', clean); END IF;
  IF n > 0 THEN lines := lines || jsonb_build_object('key', 'perModule', 'quantity', n, 'amount', perm * n); END IF;
  RETURN jsonb_build_object('currency', d->>'currency', 'lines', lines,
    'oneTime', impl + CASE WHEN p_cleanup THEN clean ELSE 0 END, 'yearly', yr + perm * n);
END $$;

/** Places the caller's customer's order (replacing one still waiting). Not for the platform owner. */
CREATE FUNCTION trial_order_place(p_modules text[], p_cleanup boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid := app_firm_id(); q jsonb; mods text[]; s subscriptions; nid uuid;
BEGIN
  IF app_user_id() IS NULL OR app_is_owner() OR f IS NULL THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  SELECT * INTO s FROM subscriptions WHERE firm_id = f;
  IF NOT FOUND OR s.trial_ends_at IS NULL OR s.converted_at IS NOT NULL THEN RAISE EXCEPTION 'There is nothing to buy: this customer has no trial.'; END IF;
  mods := coalesce(ARRAY(SELECT DISTINCT m FROM unnest(coalesce(p_modules, ARRAY[]::text[])) m ORDER BY m), ARRAY[]::text[]);
  IF NOT (mods <@ ARRAY['Inventory', 'Restaurant', 'Rooms', 'Assets', 'Rentals', 'Projects', 'HRM', 'CRM']) THEN RAISE EXCEPTION 'Choose optional modules from the list.'; END IF;
  q := trial_order_quote(mods, coalesce(p_cleanup, false));
  UPDATE trial_orders SET status = 'cancelled' WHERE firm_id = f AND status = 'waiting';
  INSERT INTO trial_orders (firm_id, modules, cleanup, currency, lines, one_time_total, yearly_total, placed_by)
  VALUES (f, mods, coalesce(p_cleanup, false), q->>'currency', q->'lines', (q->>'oneTime')::numeric, (q->>'yearly')::numeric, app_user_id()) RETURNING id INTO nid;
  RETURN nid;
END $$;

/** The caller's customer's waiting order, and the bank details to pay into (only when all four are filled). */
CREATE FUNCTION my_trial_order() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o trial_orders; b billing_settings; vat numeric;
BEGIN
  IF app_user_id() IS NULL OR app_is_owner() THEN RETURN NULL; END IF;
  SELECT * INTO b FROM billing_settings;
  SELECT * INTO o FROM trial_orders WHERE firm_id = app_firm_id() AND status = 'waiting';
  IF NOT FOUND THEN RETURN NULL; END IF;
  vat := round((o.one_time_total + o.yearly_total) * b.vat_rate / 100, 2);   -- the invoice's rule: VAT on the subtotal, rounded to the cent
  RETURN jsonb_build_object('id', o.id, 'vatRate', b.vat_rate::text, 'vat', vat::text, 'total', (o.one_time_total + o.yearly_total + vat)::text, 'modules', o.modules, 'cleanup', o.cleanup, 'currency', o.currency, 'lines', o.lines,
    'oneTime', o.one_time_total, 'yearly', o.yearly_total, 'placedAt', o.placed_at,
    'confirmed', o.payment_confirmed_at IS NOT NULL, 'paymentAmount', o.payment_amount::text, 'paymentDate', o.payment_date, 'paymentReference', o.payment_reference,
    'bank', CASE WHEN coalesce(b.bank_account_name, '') <> '' AND coalesce(b.bank_name, '') <> '' AND coalesce(b.bank_iban, '') <> '' AND coalesce(b.bank_swift, '') <> ''
                 THEN jsonb_build_object('accountName', b.bank_account_name, 'bank', b.bank_name, 'iban', b.bank_iban, 'swift', b.bank_swift) END);
END $$;

/** The customer says it has paid: amount, date, reference, and optionally a proof (PDF, PNG, JPG or WebP up to 5 MB). */
CREATE FUNCTION trial_order_confirm(p_amount numeric, p_date date, p_reference text, p_name text, p_type text, p_proof bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o trial_orders;
BEGIN
  IF app_user_id() IS NULL OR app_is_owner() THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  SELECT * INTO o FROM trial_orders WHERE firm_id = app_firm_id() AND status = 'waiting' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Place an order first.'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 10000000 THEN RAISE EXCEPTION 'Enter the amount you transferred.'; END IF;
  IF p_date IS NULL OR p_date > current_date + 1 OR p_date < current_date - 90 THEN RAISE EXCEPTION 'Enter the date of the transfer (within the last 90 days).'; END IF;
  IF btrim(coalesce(p_reference, '')) = '' OR char_length(btrim(p_reference)) > 80 THEN RAISE EXCEPTION 'Enter the transfer reference (up to 80 letters).'; END IF;
  UPDATE trial_orders SET payment_confirmed_at = now(), payment_amount = p_amount, payment_date = p_date, payment_reference = btrim(p_reference),
    proof_name = CASE WHEN p_proof IS NULL THEN NULL ELSE left(p_name, 200) END WHERE id = o.id;
  DELETE FROM trial_order_proofs WHERE order_id = o.id;
  IF p_proof IS NOT NULL THEN INSERT INTO trial_order_proofs (order_id, name, type, bytes) VALUES (o.id, left(p_name, 200), p_type, p_proof); END IF;
  RETURN o.id;
END $$;

-- ---------------------------------------------------------------------------
-- The owner: orders, the proof, marking paid, and the view of every trial
-- ---------------------------------------------------------------------------
CREATE FUNCTION owner_trial_orders(p_firm uuid DEFAULT NULL) RETURNS TABLE (id uuid, firm_id uuid, firm_name text, status text, modules text[], cleanup boolean,
  currency char(3), lines jsonb, one_time_total numeric, yearly_total numeric, placed_at timestamptz, payment_confirmed_at timestamptz, payment_amount numeric,
  payment_date date, payment_reference text, proof_name text, paid_at timestamptz, paid_reference text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  RETURN QUERY SELECT o.id, o.firm_id, f.name, o.status, o.modules, o.cleanup, o.currency, o.lines, o.one_time_total, o.yearly_total, o.placed_at, o.payment_confirmed_at,
    o.payment_amount, o.payment_date, o.payment_reference, o.proof_name, o.paid_at, o.paid_reference
    FROM trial_orders o JOIN firms f ON f.id = o.firm_id WHERE p_firm IS NULL OR o.firm_id = p_firm ORDER BY o.placed_at DESC LIMIT 300;
END $$;

CREATE FUNCTION owner_order_proof(p_order uuid) RETURNS TABLE (name text, type text, bytes bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  RETURN QUERY SELECT p.name, p.type, p.bytes FROM trial_order_proofs p WHERE p.order_id = p_order;
END $$;

/** The owner checked the bank: the order is paid. Converts the SAME customer to a paying one (data stays), keeps the optional modules that were
 *  bought and switches off the rest, and records everything. With no waiting order, one is made from p_modules and p_cleanup (the customer paid some
 *  other way). The first invoice is made and settled by the caller (src/books/trialOrders.ts) in the same transaction. */
CREATE FUNCTION owner_order_paid(p_firm uuid, p_modules text[], p_cleanup boolean, p_reference text, p_paid_on date, p_reason text, p_now timestamptz, p_term_start date)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE o trial_orders; q jsonb; mods text[]; one_company uuid; n int;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF btrim(coalesce(p_reason, '')) = '' THEN RAISE EXCEPTION 'Say why the trial is changed.'; END IF;
  SELECT * INTO o FROM trial_orders WHERE firm_id = p_firm AND status = 'waiting' FOR UPDATE;
  IF NOT FOUND THEN
    mods := coalesce(ARRAY(SELECT DISTINCT m FROM unnest(coalesce(p_modules, ARRAY[]::text[])) m ORDER BY m), ARRAY[]::text[]);
    IF NOT (mods <@ ARRAY['Inventory', 'Restaurant', 'Rooms', 'Assets', 'Rentals', 'Projects', 'HRM', 'CRM']) THEN RAISE EXCEPTION 'Choose optional modules from the list.'; END IF;
    q := trial_order_quote(mods, coalesce(p_cleanup, false));
    INSERT INTO trial_orders (firm_id, modules, cleanup, currency, lines, one_time_total, yearly_total, placed_by)
    VALUES (p_firm, mods, coalesce(p_cleanup, false), q->>'currency', q->'lines', (q->>'oneTime')::numeric, (q->>'yearly')::numeric, app_user_id()) RETURNING * INTO o;
  END IF;
  PERFORM trial_convert(p_firm, p_reason, p_now, p_term_start);   -- the same customer, unlocked, all data kept (owner only, recorded)
  UPDATE subscriptions SET implementation = o.cleanup WHERE firm_id = p_firm;
  -- the optional modules: what was not bought is switched off; a company that runs alone also gets what was bought switched on
  SELECT count(*) INTO n FROM companies WHERE firm_id = p_firm AND status = 'active';
  UPDATE companies c SET modules = ARRAY(SELECT m FROM unnest(CASE WHEN n = 1 THEN c.modules || o.modules ELSE c.modules END) m
                                         WHERE m = ANY (o.modules) GROUP BY m ORDER BY m)
  WHERE c.firm_id = p_firm AND c.status = 'active';
  UPDATE trial_orders SET status = 'paid', paid_at = p_now, paid_by = app_user_id(), paid_reference = nullif(btrim(coalesce(p_reference, '')), ''),
    payment_date = coalesce(payment_date, p_paid_on) WHERE id = o.id;
  RETURN o.id;
END $$;

/** Records that the owner sent a reminder again (with the reason). */
CREATE FUNCTION owner_reminder_resent(p_firm uuid, p_reason text, p_template text, p_now timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE st text;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF btrim(coalesce(p_reason, '')) = '' THEN RAISE EXCEPTION 'Say why the trial is changed.'; END IF;
  SELECT status INTO st FROM subscriptions WHERE firm_id = p_firm;
  IF NOT FOUND THEN RAISE EXCEPTION 'This customer has no subscription.'; END IF;
  PERFORM subscription_event(p_firm, 'reminder_resent', st, st, p_reason, p_now, jsonb_build_object('template', p_template));
END $$;

/** Every customer that has had a trial: where it stands, who to write to, when somebody last signed in, how many reminders, and any order. Owner only. */
CREATE FUNCTION owner_trials_overview() RETURNS TABLE (firm_id uuid, firm_name text, kind text, status text, trial_started_at timestamptz, trial_ends_at timestamptz,
  grace_ends_at timestamptz, converted_at timestamptz, cancelled_at timestamptz, companies text[], admin_name text, admin_email text, last_login_at timestamptz,
  emails_sent int, emails_failed int, order_id uuid, order_confirmed boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  RETURN QUERY
  SELECT s.firm_id, f.name, f.kind, s.status, s.trial_started_at, s.trial_ends_at, s.grace_ends_at, s.converted_at, s.cancelled_at,
    coalesce((SELECT array_agg(c.name ORDER BY c.name) FROM companies c WHERE c.firm_id = s.firm_id AND c.status = 'active'), ARRAY[]::text[]),
    a.full_name, a.email,
    (SELECT max(l.at) FROM user_last_login l JOIN users u ON u.id = l.user_id WHERE u.firm_id = s.firm_id),
    (SELECT count(*)::int FROM trial_email_log t WHERE t.firm_id = s.firm_id),
    (SELECT count(*)::int FROM trial_email_log t JOIN email_outbox e ON e.id = t.outbox_id WHERE t.firm_id = s.firm_id AND e.status = 'failed'),
    w.id, coalesce(w.payment_confirmed_at IS NOT NULL, false)
  FROM subscriptions s
  JOIN firms f ON f.id = s.firm_id
  LEFT JOIN LATERAL (SELECT u.full_name, u.email FROM users u WHERE u.firm_id = s.firm_id AND u.kind = 'admin' AND u.status = 'active' ORDER BY u.created_at, u.id LIMIT 1) a ON true
  LEFT JOIN trial_orders w ON w.firm_id = s.firm_id AND w.status = 'waiting'
  WHERE s.trial_started_at IS NOT NULL
  ORDER BY s.trial_ends_at DESC;
END $$;

/** A customer's name for the owner's alert e-mails and thank-you (the owner is not "inside" any customer). Owner, or the server with nobody signed in. */
CREATE FUNCTION firm_name_of(p_firm uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (app_is_owner() OR app_user_id() IS NULL OR app_firm_id() = p_firm) THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  RETURN (SELECT name FROM firms WHERE id = p_firm);
END $$;

REVOKE ALL ON FUNCTION firm_name_of(uuid), record_login(uuid), trial_order_quote(text[], boolean), trial_order_place(text[], boolean), my_trial_order(),
  trial_order_confirm(numeric, date, text, text, text, bytea), owner_trial_orders(uuid), owner_order_proof(uuid),
  owner_order_paid(uuid, text[], boolean, text, date, text, timestamptz, date), owner_trials_overview(), owner_reminder_resent(uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION firm_name_of(uuid), record_login(uuid), trial_order_place(text[], boolean), my_trial_order(), trial_order_confirm(numeric, date, text, text, text, bytea),
  owner_trial_orders(uuid), owner_order_proof(uuid), owner_order_paid(uuid, text[], boolean, text, date, text, timestamptz, date), owner_trials_overview(),
  owner_reminder_resent(uuid, text, text, timestamptz) TO nusuh_app;
