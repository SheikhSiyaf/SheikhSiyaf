-- 0076 Two clicks on "Place my order" at the same moment (or two browser tabs) could make one of them fail with a confusing error: both
-- cancelled the waiting order and both tried to insert a new one, and the "one waiting order per customer" rule stopped the second.
-- The same function now takes a short lock for the customer first, so the second request simply waits and then replaces the first order.
CREATE OR REPLACE FUNCTION trial_order_place(p_modules text[], p_cleanup boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid := app_firm_id(); q jsonb; mods text[]; s subscriptions; nid uuid;
BEGIN
  IF app_user_id() IS NULL OR app_is_owner() OR f IS NULL THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('trial_order:' || f::text));
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
