-- 0070 The free-trial lifecycle: start, lock, grace period, closing, and buying.
--
-- A customer's subscription now carries the trial's dates: when it started, when it ends (23:59:59.999 Riyadh time on
-- the last day), when the grace period ends, when the customer bought and when it was cancelled. Two statuses join the
-- old ones: 'trial_ended' (locked, waiting for the customer to buy) and, through 'cancelled', the closed state.
--
--   trial -> trial_ended -> cancelled     (unpaid: the daily job moves it on, or the owner does)
--   trial / trial_ended / cancelled -> active   (the customer bought; the owner converts it)
--
-- The numbers (15 days, 30 days of grace, ...) are NOT written here: they live once in src/books/trialRules.ts and arrive
-- as parameters. The one Riyadh time zone name below is only for filling in the dates of trials that already exist.
-- Whether someone may still use the software is decided in the API from the clock (never only from the status column), so
-- a day the job did not run cannot leave an unpaid customer with open access. Row-level security is unchanged.
--
-- Every change is also written to subscription_events (what, from which status to which, why, who, and when), which only
-- the platform owner can read and nobody can change or delete.
-- The billing run no longer turns a trial into a paying subscription by itself: an unpaid trial locks instead.

ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('trial', 'trial_ended', 'active', 'past_due', 'cancelled'));

ALTER TABLE subscriptions
  ADD COLUMN trial_started_at timestamptz,
  ADD COLUMN trial_ends_at    timestamptz,    -- the last millisecond of the last trial day, Riyadh time
  ADD COLUMN grace_ends_at    timestamptz,    -- after this an unpaid customer is closed
  ADD COLUMN converted_at     timestamptz,    -- when the customer bought
  ADD COLUMN cancelled_at     timestamptz;    -- when it was closed (the day the 60-day export window and the 90-day deletion count from)

-- Trials that already exist: their dates in Riyadh time. (trial_ends was the first day after the trial.)
UPDATE subscriptions
SET trial_started_at = started_on::timestamp AT TIME ZONE 'Asia/Riyadh',
    trial_ends_at    = (trial_ends::timestamp AT TIME ZONE 'Asia/Riyadh') - interval '1 millisecond'
WHERE status = 'trial' AND trial_ends IS NOT NULL;

ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_trial_dates
  CHECK (status NOT IN ('trial', 'trial_ended') OR (trial_started_at IS NOT NULL AND trial_ends_at IS NOT NULL));

-- ---------------------------------------------------------------------------
-- The record of every lifecycle change
-- ---------------------------------------------------------------------------
CREATE TABLE subscription_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL REFERENCES firms(id),
  kind          text NOT NULL CHECK (kind IN ('trial_started', 'trial_extended', 'trial_ended', 'converted', 'reactivated', 'cancelled')),
  from_status   text,
  to_status     text NOT NULL,
  reason        text,                                  -- required for every change the owner makes by hand
  actor_user_id uuid REFERENCES users(id),             -- empty when the system (the daily job) made the change
  occurred_at   timestamptz NOT NULL,                  -- when it took effect
  details       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_events_firm ON subscription_events (firm_id, occurred_at);
CREATE TRIGGER subscription_events_immutable BEFORE UPDATE OR DELETE ON subscription_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscription_events_owner ON subscription_events FOR SELECT USING (app_is_owner());
GRANT SELECT ON subscription_events TO nusuh_app;   -- rows are written only by the functions below

/** Writes one event. Used only by the functions below (nobody is granted it). */
CREATE FUNCTION subscription_event(p_firm uuid, p_kind text, p_from text, p_to text, p_reason text, p_at timestamptz, p_details jsonb DEFAULT '{}')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO subscription_events (firm_id, kind, from_status, to_status, reason, actor_user_id, occurred_at, details)
  VALUES (p_firm, p_kind, p_from, p_to, nullif(btrim(coalesce(p_reason, '')), ''), app_user_id(), p_at, coalesce(p_details, '{}'));
END $$;
REVOKE ALL ON FUNCTION subscription_event(uuid, text, text, text, text, timestamptz, jsonb) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- What the API needs to decide access
-- ---------------------------------------------------------------------------
/** The trial facts of the signed-in person's own customer. Everyone in the customer may ask (an Administrator alone can read
 *  the subscription itself); the platform owner and nobody-signed-in get nothing, so they are never locked. */
CREATE FUNCTION my_access_state() RETURNS TABLE (status text, trial_started_at timestamptz, trial_ends_at timestamptz, grace_ends_at timestamptz,
                                                 converted_at timestamptz, cancelled_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.status, s.trial_started_at, s.trial_ends_at, s.grace_ends_at, s.converted_at, s.cancelled_at
  FROM subscriptions s
  WHERE app_user_id() IS NOT NULL AND NOT app_is_owner() AND s.firm_id = app_firm_id()
$$;

/** The same, for sign-in, before there is a session: by user. */
CREATE FUNCTION access_state_for_user(p_user uuid) RETURNS TABLE (status text, trial_started_at timestamptz, trial_ends_at timestamptz,
                                                                  grace_ends_at timestamptz, converted_at timestamptz, cancelled_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.status, s.trial_started_at, s.trial_ends_at, s.grace_ends_at, s.converted_at, s.cancelled_at
  FROM users u JOIN subscriptions s ON s.firm_id = u.firm_id
  WHERE u.id = p_user AND u.kind <> 'owner'
$$;

-- ---------------------------------------------------------------------------
-- Starting a trial (the owner, or the server when a customer signs up on its own)
-- ---------------------------------------------------------------------------
CREATE FUNCTION trial_begin(p_firm uuid, p_plan uuid, p_cycle text, p_implementation boolean, p_discount numeric, p_notes text,
                            p_started_on date, p_trial_ends_on date, p_started_at timestamptz, p_ends_at timestamptz, p_grace_ends_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cur subscriptions; sid uuid;
BEGIN
  IF NOT (app_is_owner() OR app_user_id() IS NULL) THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF p_ends_at <= p_started_at OR p_grace_ends_at <= p_ends_at THEN RAISE EXCEPTION 'The trial dates are not in order.'; END IF;
  SELECT * INTO cur FROM subscriptions WHERE firm_id = p_firm FOR UPDATE;
  IF FOUND AND cur.status <> 'cancelled' THEN RAISE EXCEPTION 'This customer already has a subscription.'; END IF;
  IF FOUND THEN   -- a cancelled customer starts again
    UPDATE subscriptions SET plan_id = p_plan, cycle = p_cycle, status = 'trial', started_on = p_started_on, trial_ends = p_trial_ends_on,
      next_bill_on = p_trial_ends_on, discount_pct = p_discount, notes = p_notes, implementation = p_implementation, setup_billed = false,
      cancel_at_period_end = false, trial_started_at = p_started_at, trial_ends_at = p_ends_at, grace_ends_at = p_grace_ends_at,
      converted_at = NULL, cancelled_at = NULL
    WHERE id = cur.id RETURNING id INTO sid;
  ELSE
    INSERT INTO subscriptions (firm_id, plan_id, cycle, status, started_on, trial_ends, next_bill_on, discount_pct, notes, implementation,
                               trial_started_at, trial_ends_at, grace_ends_at)
    VALUES (p_firm, p_plan, p_cycle, 'trial', p_started_on, p_trial_ends_on, p_trial_ends_on, p_discount, p_notes, p_implementation,
            p_started_at, p_ends_at, p_grace_ends_at) RETURNING id INTO sid;
  END IF;
  PERFORM subscription_event(p_firm, 'trial_started', cur.status, 'trial', NULL, p_started_at, jsonb_build_object('endsAt', p_ends_at, 'graceEndsAt', p_grace_ends_at));
  RETURN sid;
END $$;

-- ---------------------------------------------------------------------------
-- The owner's actions (each needs a reason and is recorded)
-- ---------------------------------------------------------------------------
/** Gives a trial more days. Its grace period moves by the same number of days. A locked customer whose trial is open again
 *  can work again at once. */
CREATE FUNCTION trial_extend(p_firm uuid, p_days int, p_reason text, p_now timestamptz, p_grace_days int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s subscriptions; new_end timestamptz; new_grace timestamptz; new_status text;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF btrim(coalesce(p_reason, '')) = '' THEN RAISE EXCEPTION 'Say why the trial is changed.'; END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN RAISE EXCEPTION 'Extend a trial by 1 to 90 days.'; END IF;
  SELECT * INTO s FROM subscriptions WHERE firm_id = p_firm FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This customer has no subscription.'; END IF;
  IF s.status NOT IN ('trial', 'trial_ended') THEN RAISE EXCEPTION 'Only a trial can be extended.'; END IF;
  new_end := s.trial_ends_at + p_days * interval '1 day';
  new_grace := coalesce(s.grace_ends_at, s.trial_ends_at + p_grace_days * interval '1 day') + p_days * interval '1 day';
  new_status := CASE WHEN new_end >= p_now THEN 'trial' ELSE s.status END;
  UPDATE subscriptions SET trial_ends_at = new_end, grace_ends_at = new_grace, status = new_status,
    trial_ends = s.trial_ends + p_days, next_bill_on = s.trial_ends + p_days
  WHERE id = s.id;
  PERFORM subscription_event(p_firm, 'trial_extended', s.status, new_status, p_reason, p_now,
    jsonb_build_object('days', p_days, 'endsAtBefore', s.trial_ends_at, 'endsAtAfter', new_end));
END $$;

/** The customer bought: unlocks the same customer with all its data. The first bill (software, any implementation, the
 *  yearly membership, extra modules) is made by the next billing run, dated p_term_start. Also brings back a customer that
 *  was closed but not yet deleted. */
CREATE FUNCTION trial_convert(p_firm uuid, p_reason text, p_now timestamptz, p_term_start date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s subscriptions;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF btrim(coalesce(p_reason, '')) = '' THEN RAISE EXCEPTION 'Say why the trial is changed.'; END IF;
  SELECT * INTO s FROM subscriptions WHERE firm_id = p_firm FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This customer has no subscription.'; END IF;
  IF s.status NOT IN ('trial', 'trial_ended', 'cancelled') THEN RAISE EXCEPTION 'This customer is already paying.'; END IF;
  UPDATE subscriptions SET status = 'active', converted_at = p_now, cancelled_at = NULL, cancel_at_period_end = false, next_bill_on = p_term_start
  WHERE id = s.id;
  PERFORM subscription_event(p_firm, CASE WHEN s.status = 'cancelled' THEN 'reactivated' ELSE 'converted' END, s.status, 'active', p_reason, p_now,
    jsonb_build_object('termStart', p_term_start));
END $$;

/** Closes a trial now (before its end, or while it waits locked). The export window and the deletion date count from now. */
CREATE FUNCTION trial_cancel(p_firm uuid, p_reason text, p_now timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s subscriptions;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF btrim(coalesce(p_reason, '')) = '' THEN RAISE EXCEPTION 'Say why the trial is changed.'; END IF;
  SELECT * INTO s FROM subscriptions WHERE firm_id = p_firm FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This customer has no subscription.'; END IF;
  IF s.status NOT IN ('trial', 'trial_ended') THEN RAISE EXCEPTION 'Only a trial can be closed this way.'; END IF;
  UPDATE subscriptions SET status = 'cancelled', cancelled_at = p_now WHERE id = s.id;
  PERFORM subscription_event(p_firm, 'cancelled', s.status, 'cancelled', p_reason, p_now, '{}');
END $$;

-- ---------------------------------------------------------------------------
-- The hourly job: moves unpaid trials on (all customers, or just p_firm). Safe to run twice and to miss days (it catches up in one go).
-- ---------------------------------------------------------------------------
CREATE FUNCTION lifecycle_advance(p_now timestamptz, p_grace_days int, p_firm uuid DEFAULT NULL)
RETURNS TABLE (r_firm uuid, r_from text, r_to text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s subscriptions; g timestamptz;
BEGIN
  IF NOT (app_is_owner() OR app_user_id() IS NULL) THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('lifecycle_advance'));
  FOR s IN SELECT * FROM subscriptions WHERE status IN ('trial', 'trial_ended') AND trial_ends_at IS NOT NULL
                 AND (p_firm IS NULL OR firm_id = p_firm) ORDER BY firm_id FOR UPDATE LOOP
    g := coalesce(s.grace_ends_at, s.trial_ends_at + p_grace_days * interval '1 day');
    IF s.status = 'trial' AND p_now > s.trial_ends_at THEN
      UPDATE subscriptions SET status = 'trial_ended', grace_ends_at = g WHERE id = s.id;
      PERFORM subscription_event(s.firm_id, 'trial_ended', 'trial', 'trial_ended', NULL, s.trial_ends_at, jsonb_build_object('by', 'system'));
      r_firm := s.firm_id; r_from := 'trial'; r_to := 'trial_ended';
      RETURN NEXT;
      s.status := 'trial_ended';
    END IF;
    IF s.status = 'trial_ended' AND p_now > g THEN
      -- Closed on the day the grace period ended, not on the day the job happened to run, so a late job never pushes the dates later.
      UPDATE subscriptions SET status = 'cancelled', cancelled_at = g WHERE id = s.id;
      PERFORM subscription_event(s.firm_id, 'cancelled', 'trial_ended', 'cancelled', NULL, g, jsonb_build_object('by', 'system'));
      r_firm := s.firm_id; r_from := 'trial_ended'; r_to := 'cancelled';
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Billing: a trial is never billed or turned into a paying subscription by the run. (Same as 0068's billing_run, except
-- that trial and trial_ended subscriptions are skipped, and a cancellation records its time.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing_run(p_day date)
RETURNS TABLE (invoice_id uuid, firm_id uuid, number text, customer_name text, total numeric, currency char(3), due_on date, period_start date, period_end date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE s subscriptions; q jsonb; st billing_settings; n int; b billing_invoices; guard int;
BEGIN
  IF app_user_id() IS NOT NULL AND NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('billing_run'));
  SELECT * INTO st FROM billing_settings;
  FOR s IN SELECT * FROM subscriptions WHERE status NOT IN ('cancelled', 'trial', 'trial_ended') AND next_bill_on <= p_day ORDER BY next_bill_on FOR UPDATE LOOP
    guard := 0;
    WHILE s.next_bill_on <= p_day AND guard < 24 LOOP
      guard := guard + 1;
      IF s.cancel_at_period_end THEN
        UPDATE subscriptions SET status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()) WHERE id = s.id;
        EXIT;
      END IF;
      q := billing_quote(s.firm_id, s.next_bill_on);
      SELECT count(*) + 1 INTO n FROM billing_invoices WHERE number LIKE 'NB-' || extract(year FROM p_day)::int || '-%';
      INSERT INTO billing_invoices (firm_id, number, customer_name, plan_name, cycle, period_start, period_end, issued_on, due_on, currency, lines,
                                    subtotal, discount, vat_rate, vat, total)
      VALUES (s.firm_id, 'NB-' || extract(year FROM p_day)::int || '-' || lpad(n::text, 4, '0'),
              (SELECT f.name FROM firms f WHERE f.id = s.firm_id), q->>'planName', s.cycle, s.next_bill_on,
              (q->>'periodEnd')::date, p_day, p_day + st.terms_days, q->>'currency', q->'lines',
              (q->>'subtotal')::numeric, (q->>'discount')::numeric, (q->>'vatRate')::numeric, (q->>'vat')::numeric, (q->>'total')::numeric)
      RETURNING * INTO b;
      invoice_id := b.id; firm_id := b.firm_id; number := b.number; customer_name := b.customer_name; total := b.total; currency := b.currency;
      due_on := b.due_on; period_start := b.period_start; period_end := b.period_end;
      RETURN NEXT;
      s.next_bill_on := (q->>'periodEnd')::date + 1;
      UPDATE subscriptions SET next_bill_on = s.next_bill_on,
                               setup_billed = setup_billed OR EXISTS (SELECT 1 FROM jsonb_array_elements(q->'lines') l WHERE l->>'key' IN ('software', 'implementation'))
      WHERE id = s.id;
    END LOOP;
  END LOOP;
  UPDATE subscriptions x SET status = 'past_due'
  WHERE x.status = 'active' AND EXISTS (SELECT 1 FROM billing_invoices b WHERE b.firm_id = x.firm_id AND b.status = 'open' AND b.due_on < p_day);
END $$;

REVOKE ALL ON FUNCTION my_access_state(), access_state_for_user(uuid),
  trial_begin(uuid, uuid, text, boolean, numeric, text, date, date, timestamptz, timestamptz, timestamptz),
  trial_extend(uuid, int, text, timestamptz, int), trial_convert(uuid, text, timestamptz, date), trial_cancel(uuid, text, timestamptz),
  lifecycle_advance(timestamptz, int, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_access_state(), access_state_for_user(uuid),
  trial_begin(uuid, uuid, text, boolean, numeric, text, date, date, timestamptz, timestamptz, timestamptz),
  trial_extend(uuid, int, text, timestamptz, int), trial_convert(uuid, text, timestamptz, date), trial_cancel(uuid, text, timestamptz),
  lifecycle_advance(timestamptz, int, uuid) TO nusuh_app;
