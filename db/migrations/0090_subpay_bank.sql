-- 0090 Bank details for bank-transfer payments, with the protection against somebody swapping the account.
--
-- Customers of the new payment flow are shown the details in subpay.bank_live. Only the Owner role changes them, and a CHANGE does not show at
-- once: it waits (a setting, 24 hours to begin with) in subpay.bank_changes as "pending", every Owner is e-mailed, and any Owner may cancel it. The
-- first details ever entered show at once (there is nothing to protect yet). Customers are told when the details changed in the last 7 days.
-- (The older bank lines in billing_settings, used by the Trials order page, are untouched; the new flow never reads them.)

ALTER TABLE subpay.settings ADD COLUMN bank_change_delay_hours int NOT NULL DEFAULT 24 CHECK (bank_change_delay_hours BETWEEN 1 AND 168);

CREATE TABLE subpay.bank_live (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  account_name text, bank text, iban text, swift text,
  changed_at   timestamptz,
  changed_by   uuid REFERENCES public.users(id),
  first_entry  boolean NOT NULL DEFAULT true   -- the very first details: not announced to customers as a change
);
INSERT INTO subpay.bank_live DEFAULT VALUES;

CREATE TABLE subpay.bank_changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by uuid NOT NULL REFERENCES public.users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  effective_at timestamptz NOT NULL,
  account_name text NOT NULL CHECK (char_length(btrim(account_name)) BETWEEN 2 AND 120),
  bank         text NOT NULL CHECK (char_length(btrim(bank)) BETWEEN 2 AND 120),
  iban         text NOT NULL CHECK (iban ~ '^SA[0-9]{22}$'),
  swift        text CHECK (swift IS NULL OR swift ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'applied', 'cancelled')),
  decided_by   uuid REFERENCES public.users(id),
  decided_at   timestamptz,
  CHECK ((state = 'pending') = (decided_at IS NULL) OR state = 'applied')
);
CREATE UNIQUE INDEX subpay_one_pending_bank_change ON subpay.bank_changes ((true)) WHERE state = 'pending';
ALTER TABLE subpay.bank_live ENABLE ROW LEVEL SECURITY;
ALTER TABLE subpay.bank_changes ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER subpay_bank_live_audit    AFTER INSERT OR UPDATE OR DELETE ON subpay.bank_live    FOR EACH ROW EXECUTE FUNCTION public.audit_row();
CREATE TRIGGER subpay_bank_changes_audit AFTER INSERT OR UPDATE OR DELETE ON subpay.bank_changes FOR EACH ROW EXECUTE FUNCTION public.audit_row();

/** A Saudi IBAN: SA, then 22 digits, and it passes the standard mod-97 check. */
CREATE FUNCTION subpay.iban_valid(p_iban text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s text := upper(regexp_replace(coalesce(p_iban, ''), '\s', '', 'g')); r text; acc bigint := 0; ch text; i int;
BEGIN
  IF s !~ '^SA[0-9]{22}$' THEN RETURN false; END IF;
  r := substr(s, 5) || substr(s, 1, 4);
  FOR i IN 1..char_length(r) LOOP
    ch := substr(r, i, 1);
    IF ch ~ '[0-9]' THEN acc := (acc * 10 + ch::int) % 97;
    ELSE acc := (acc * 100 + (ascii(ch) - 55)) % 97; END IF;
  END LOOP;
  RETURN acc = 1;
END $$;

/** Applies a change whose waiting time is over. Called by the functions that show the details; not for the app to call. */
CREATE FUNCTION subpay.apply_due() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE c subpay.bank_changes;
BEGIN
  SELECT * INTO c FROM subpay.bank_changes WHERE state = 'pending' AND effective_at <= now() FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    UPDATE subpay.bank_live SET account_name = c.account_name, bank = c.bank, iban = c.iban, swift = c.swift, changed_at = now(), changed_by = c.requested_by, first_entry = false;
    UPDATE subpay.bank_changes SET state = 'applied', decided_at = now() WHERE id = c.id;
  END IF;
END $$;

CREATE FUNCTION subpay.bank_get() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE l subpay.bank_live; s subpay.settings; c subpay.bank_changes;
BEGIN
  PERFORM subpay.need('payments.view');
  PERFORM subpay.apply_due();
  SELECT * INTO l FROM subpay.bank_live; SELECT * INTO s FROM subpay.settings;
  SELECT * INTO c FROM subpay.bank_changes WHERE state = 'pending';
  RETURN jsonb_build_object('delayHours', s.bank_change_delay_hours,
    'live', CASE WHEN l.iban IS NOT NULL THEN jsonb_build_object('accountName', l.account_name, 'bank', l.bank, 'iban', l.iban, 'swift', l.swift, 'changedAt', l.changed_at) END,
    'pending', CASE WHEN c.id IS NOT NULL THEN jsonb_build_object('id', c.id, 'accountName', c.account_name, 'bank', c.bank, 'iban', c.iban, 'swift', c.swift, 'effectiveAt', c.effective_at, 'requestedAt', c.requested_at,
      'by', (SELECT full_name FROM users WHERE id = c.requested_by)) END,
    'history', (SELECT coalesce(jsonb_agg(jsonb_build_object('at', h.requested_at, 'state', h.state, 'by', (SELECT full_name FROM users WHERE id = h.requested_by), 'accountName', h.account_name, 'iban', h.iban) ORDER BY h.requested_at DESC, h.effective_at DESC), '[]')
      FROM (SELECT * FROM subpay.bank_changes ORDER BY requested_at DESC, effective_at DESC LIMIT 10) h));
END $$;

/** Ask to change the bank details (Owner role only). The first details show at once; a change waits for the delay. */
CREATE FUNCTION subpay.bank_request(p_name text, p_bank text, p_iban text, p_swift text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE l subpay.bank_live; s subpay.settings; v_iban text := upper(regexp_replace(coalesce(p_iban, ''), '\s', '', 'g')); sw text := nullif(upper(regexp_replace(coalesce(p_swift, ''), '\s', '', 'g')), ''); cid uuid; eff timestamptz;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the Owner role changes the bank details.'; END IF;
  IF char_length(btrim(coalesce(p_name, ''))) NOT BETWEEN 2 AND 120 OR char_length(btrim(coalesce(p_bank, ''))) NOT BETWEEN 2 AND 120 THEN RAISE EXCEPTION 'Enter the account name and the bank (up to 120 letters each).'; END IF;
  IF NOT subpay.iban_valid(v_iban) THEN RAISE EXCEPTION 'The IBAN is not a valid Saudi IBAN (SA and 22 digits). Check it and try again.'; END IF;
  IF sw IS NOT NULL AND sw !~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$' THEN RAISE EXCEPTION 'The SWIFT code looks wrong. It is 8 or 11 letters and digits.'; END IF;
  PERFORM subpay.apply_due();
  SELECT * INTO l FROM subpay.bank_live FOR UPDATE; SELECT * INTO s FROM subpay.settings;
  IF l.iban = v_iban AND l.account_name = btrim(p_name) AND l.bank = btrim(p_bank) AND l.swift IS NOT DISTINCT FROM sw THEN RAISE EXCEPTION 'These are the details customers see now.'; END IF;
  UPDATE subpay.bank_changes SET state = 'cancelled', decided_by = app_user_id(), decided_at = now() WHERE state = 'pending';   -- a newer request replaces a waiting one
  IF l.iban IS NULL THEN
    UPDATE subpay.bank_live SET account_name = btrim(p_name), bank = btrim(p_bank), iban = v_iban, swift = sw, changed_at = now(), changed_by = app_user_id(), first_entry = true;
    INSERT INTO subpay.bank_changes (requested_by, effective_at, account_name, bank, iban, swift, state, decided_by, decided_at)
    VALUES (app_user_id(), now(), btrim(p_name), btrim(p_bank), v_iban, sw, 'applied', app_user_id(), now()) RETURNING id INTO cid;
    RETURN jsonb_build_object('immediate', true, 'id', cid, 'effectiveAt', now());
  END IF;
  eff := now() + make_interval(hours => s.bank_change_delay_hours);
  INSERT INTO subpay.bank_changes (requested_by, effective_at, account_name, bank, iban, swift) VALUES (app_user_id(), eff, btrim(p_name), btrim(p_bank), v_iban, sw) RETURNING id INTO cid;
  RETURN jsonb_build_object('immediate', false, 'id', cid, 'effectiveAt', eff);
END $$;

/** Stop a waiting change. Any person with the Owner role may. */
CREATE FUNCTION subpay.bank_cancel(p_change uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the Owner role changes the bank details.'; END IF;
  PERFORM subpay.apply_due();
  UPDATE subpay.bank_changes SET state = 'cancelled', decided_by = app_user_id(), decided_at = now() WHERE id = p_change AND state = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'There is no waiting change to cancel (it may have taken effect already).'; END IF;
END $$;

-- settings: now with the delay
DROP FUNCTION subpay.settings_set(boolean, int, int);
CREATE FUNCTION subpay.settings_set(p_enabled boolean, p_hours int, p_days int, p_delay int) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
BEGIN
  PERFORM subpay.need('payments.settings');
  IF p_enabled IS NULL OR p_hours NOT BETWEEN 1 AND 168 OR p_days NOT BETWEEN 1 AND 90 OR p_delay NOT BETWEEN 1 AND 168 THEN
    RAISE EXCEPTION 'Check the settings: review time 1 to 168 hours, open days 1 to 90, bank change delay 1 to 168 hours.';
  END IF;
  -- switching payments on needs the bank details (customers would be sent nowhere)
  IF p_enabled AND NOT EXISTS (SELECT 1 FROM subpay.bank_live WHERE iban IS NOT NULL) THEN RAISE EXCEPTION 'Enter the bank details before switching payments on.'; END IF;
  IF (SELECT bank_change_delay_hours FROM subpay.settings) <> p_delay AND NOT app_is_owner() THEN RAISE EXCEPTION 'Only the Owner role changes the delay for bank details.'; END IF;
  UPDATE subpay.settings SET payments_enabled = p_enabled, review_target_hours = p_hours, order_open_days = p_days, bank_change_delay_hours = p_delay, updated_at = now();
END $$;

CREATE OR REPLACE FUNCTION subpay.settings_get() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
BEGIN
  PERFORM subpay.need('payments.view');
  RETURN (SELECT jsonb_build_object('enabled', payments_enabled, 'reviewTargetHours', review_target_hours, 'orderOpenDays', order_open_days, 'bankChangeDelayHours', bank_change_delay_hours,
    'bankReady', EXISTS (SELECT 1 FROM subpay.bank_live WHERE iban IS NOT NULL)) FROM subpay.settings);
END $$;

-- the customer's view and the order itself now read the live details (and apply a change whose waiting time is over)
CREATE OR REPLACE FUNCTION subpay.my_order() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE f uuid := subpay.customer_firm(); o subpay.orders; l subpay.bank_live; s subpay.settings; sub subpay.submissions;
BEGIN
  SELECT * INTO s FROM subpay.settings;
  IF NOT s.payments_enabled THEN RETURN NULL; END IF;
  PERFORM subpay.apply_due();
  SELECT * INTO o FROM subpay.orders WHERE firm_id = f ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO l FROM subpay.bank_live;
  SELECT * INTO sub FROM subpay.submissions WHERE order_id = o.id ORDER BY created_at DESC LIMIT 1;
  RETURN jsonb_build_object('id', o.id, 'reference', o.reference, 'status', o.status, 'currency', o.currency,
    'subtotalHalalas', o.subtotal_halalas, 'vatRate', o.vat_rate::text, 'vatHalalas', o.vat_halalas, 'totalHalalas', o.total_halalas,
    'expiresAt', o.expires_at, 'reviewTargetHours', s.review_target_hours,
    'bank', CASE WHEN o.status IN ('awaiting_payment', 'needs_info') THEN jsonb_build_object('accountName', l.account_name, 'bank', l.bank, 'iban', l.iban,
      'changedRecently', (NOT l.first_entry AND l.changed_at > now() - interval '7 days')) END,
    'submission', CASE WHEN sub.id IS NOT NULL THEN jsonb_build_object('amountHalalas', sub.amount_halalas, 'date', sub.transfer_date, 'senderBank', sub.sender_bank, 'bankRef', sub.bank_ref, 'at', sub.created_at) END,
    'timeline', (SELECT coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'status', e.to_status, 'note', e.client_note) ORDER BY e.id), '[]') FROM subpay.order_events e WHERE e.order_id = o.id));
END $$;

CREATE OR REPLACE FUNCTION subpay.place_order() RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = subpay, public, pg_temp AS $$
DECLARE f uuid := subpay.customer_firm(); t trial_orders; b billing_settings; o subpay.orders; sub bigint; vat bigint; s subpay.settings; nid uuid;
BEGIN
  SELECT * INTO s FROM subpay.settings;
  IF NOT s.payments_enabled THEN RAISE EXCEPTION 'Payment by bank transfer is not switched on yet.'; END IF;
  PERFORM subpay.apply_due();
  SELECT * INTO t FROM trial_orders WHERE firm_id = f AND status = 'waiting' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Place an order first.'; END IF;
  SELECT * INTO b FROM billing_settings;
  IF b.currency <> 'SAR' THEN RAISE EXCEPTION 'Payments are in Saudi riyals (SAR) only for now.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM subpay.bank_live WHERE iban IS NOT NULL) THEN RAISE EXCEPTION 'The bank details are not ready yet. Contact us.'; END IF;
  SELECT * INTO o FROM subpay.orders WHERE trial_order_id = t.id AND status IN ('created', 'awaiting_payment', 'submitted', 'under_review', 'needs_info');
  IF FOUND THEN RETURN o.id; END IF;
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

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA subpay FROM PUBLIC;
GRANT EXECUTE ON FUNCTION subpay.place_order(), subpay.my_order(), subpay.settings_get(), subpay.settings_set(boolean, int, int, int), subpay.bank_get(),
  subpay.bank_request(text, text, text, text), subpay.bank_cancel(uuid), subpay.iban_valid(text) TO nusuh_app;
