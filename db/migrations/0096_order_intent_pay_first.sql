-- 0096 Two ways to start from the website: the 15-day free trial, or order and pay straight away.
-- order_intents gets pay_first: the visitor chose "Order and pay now" on the /order page. It changes nothing about what is priced or owed: the
-- order is still priced in the database and paid by bank transfer, and the paid plan still starts when the payment is approved. It only decides
-- where the new customer lands after confirming the e-mail: the buy screen (pay now) or the home page (trial).
-- order_intent_set_mode: the /order page records the choice under the secret token; only an unclaimed, unexpired selection can be changed.
-- order_intent_peek, order_intent_claim and my_order_intent now also return payFirst.

ALTER TABLE order_intents ADD COLUMN pay_first boolean NOT NULL DEFAULT false;

CREATE FUNCTION order_intent_set_mode(p_token_hash text, p_pay_first boolean) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (UPDATE order_intents SET pay_first = coalesce(p_pay_first, false)
              WHERE token_hash = p_token_hash AND expires_at > now() AND claimed_firm_id IS NULL RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

CREATE OR REPLACE FUNCTION order_intent_peek(p_token_hash text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('modules', modules, 'cleanup', cleanup, 'payFirst', pay_first) FROM order_intents WHERE token_hash = p_token_hash AND expires_at > now()
$$;

CREATE OR REPLACE FUNCTION order_intent_claim(p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid := app_firm_id(); i order_intents;
BEGIN
  IF app_user_id() IS NULL OR f IS NULL OR EXISTS (SELECT 1 FROM users WHERE id = app_user_id() AND kind = 'owner') THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  SELECT * INTO i FROM order_intents WHERE token_hash = p_token_hash AND expires_at > now() FOR UPDATE;
  IF NOT FOUND OR (i.claimed_firm_id IS NOT NULL AND i.claimed_firm_id <> f) THEN RETURN NULL; END IF;   -- unknown, expired or someone else's: the same answer
  IF i.claimed_firm_id IS NULL THEN UPDATE order_intents SET claimed_firm_id = f, claimed_at = now() WHERE id = i.id; END IF;
  RETURN jsonb_build_object('modules', i.modules, 'cleanup', i.cleanup, 'payFirst', i.pay_first, 'fresh', i.claimed_firm_id IS NULL);   -- fresh: first claim (a new sign-up was claimed already)
END $$;

CREATE OR REPLACE FUNCTION my_order_intent() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('modules', modules, 'cleanup', cleanup, 'payFirst', pay_first) FROM order_intents
   WHERE claimed_firm_id = app_firm_id() AND app_firm_id() IS NOT NULL AND claimed_at > now() - interval '30 days' ORDER BY claimed_at DESC LIMIT 1
$$;

REVOKE ALL ON FUNCTION order_intent_set_mode(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION order_intent_set_mode(text, boolean) TO nusuh_app;
