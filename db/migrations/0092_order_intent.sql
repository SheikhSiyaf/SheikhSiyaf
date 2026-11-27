-- Website to software hand-over (trial as the front door). The website's Order button opens the software with only a module selection.
-- The software stores that selection on the server (an "order intent", found again by a secret token, never by an id), attaches it to the
-- sign-up or the signed-in customer, and shows it pre-ticked on the buy screen. Nothing here is a price: the server prices every order itself.
-- Also records which terms version a person accepted at sign-up, and when.
-- Additive and reversible: DROP the functions and the two tables, and the three signup_requests columns.

CREATE TABLE order_intents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      text NOT NULL UNIQUE,                       -- sha-256 of the secret token; the token itself is never stored
  modules         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(modules) <= 12),
  cleanup         boolean NOT NULL DEFAULT false,
  ip_key          text NOT NULL,                              -- keyed hash of the address (never the address itself)
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  claimed_firm_id uuid REFERENCES firms(id),
  claimed_at      timestamptz,
  CHECK ((claimed_firm_id IS NULL) = (claimed_at IS NULL))
);
CREATE INDEX order_intents_ip ON order_intents (ip_key, created_at);
ALTER TABLE order_intents ENABLE ROW LEVEL SECURITY;          -- no policy and no grant: only the functions below can touch it

ALTER TABLE signup_requests ADD COLUMN intent_hash text, ADD COLUMN terms_version text, ADD COLUMN terms_at timestamptz;

CREATE TABLE terms_acceptances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES firms(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  version     text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 40),
  accepted_at timestamptz NOT NULL,
  source      text NOT NULL CHECK (source IN ('signup')),
  UNIQUE (firm_id, user_id, version)
);
ALTER TABLE terms_acceptances ENABLE ROW LEVEL SECURITY;      -- no policy and no grant
CREATE TRIGGER terms_acceptances_immutable BEFORE UPDATE OR DELETE ON terms_acceptances FOR EACH ROW EXECUTE FUNCTION public.forbid_change();

/** Anyone (the visitor has no account yet). 'throttled' after 20 an hour from one address or 2,000 an hour in all. */
CREATE FUNCTION order_intent_create(p_token_hash text, p_modules text[], p_cleanup boolean, p_ip_key text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM order_intents WHERE ip_key = p_ip_key AND created_at > now() - interval '1 hour') >= 20
     OR (SELECT count(*) FROM order_intents WHERE created_at > now() - interval '1 hour') >= 2000 THEN RETURN 'throttled'; END IF;
  INSERT INTO order_intents (token_hash, modules, cleanup, ip_key, expires_at) VALUES (p_token_hash, coalesce(p_modules, '{}'), coalesce(p_cleanup, false), p_ip_key, now() + interval '7 days');
  RETURN 'ok';
END $$;

/** What a token holds, for the /order page. Null when unknown or expired (the two look the same). */
CREATE FUNCTION order_intent_peek(p_token_hash text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('modules', modules, 'cleanup', cleanup) FROM order_intents WHERE token_hash = p_token_hash AND expires_at > now()
$$;

/** The server, right after it queued the confirmation e-mail: remember the selection and the terms version on the pending request. */
CREATE FUNCTION signup_attach_meta(p_email_key text, p_intent_hash text, p_terms_version text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (app_user_id() IS NULL OR app_is_owner()) THEN RAISE EXCEPTION 'Only the server does this.'; END IF;
  UPDATE signup_requests SET terms_version = left(p_terms_version, 40), terms_at = now(),
         intent_hash = CASE WHEN EXISTS (SELECT 1 FROM order_intents WHERE token_hash = p_intent_hash AND expires_at > now() AND claimed_firm_id IS NULL) THEN p_intent_hash END
   WHERE email_key = p_email_key AND status = 'pending';
END $$;

/** The server, inside the sign-up transaction, once the customer exists: record the terms acceptance and hand the selection to the new customer. */
CREATE FUNCTION signup_finish_meta(p_email_key text, p_firm uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r signup_requests;
BEGIN
  IF NOT (app_user_id() IS NULL OR app_is_owner()) THEN RAISE EXCEPTION 'Only the server does this.'; END IF;
  SELECT * INTO r FROM signup_requests WHERE email_key = p_email_key AND status = 'verified' ORDER BY verified_at DESC NULLS LAST LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  IF r.terms_version IS NOT NULL THEN
    INSERT INTO terms_acceptances (firm_id, user_id, version, accepted_at, source) VALUES (p_firm, p_user, r.terms_version, coalesce(r.terms_at, now()), 'signup') ON CONFLICT DO NOTHING;
  END IF;
  IF r.intent_hash IS NOT NULL THEN
    UPDATE order_intents SET claimed_firm_id = p_firm, claimed_at = now() WHERE token_hash = r.intent_hash AND claimed_firm_id IS NULL AND expires_at > now();
  END IF;
END $$;

/** A signed-in customer (not platform staff) claims a selection they arrived with. One selection belongs to one customer. */
CREATE FUNCTION order_intent_claim(p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid := app_firm_id(); i order_intents;
BEGIN
  IF app_user_id() IS NULL OR f IS NULL OR EXISTS (SELECT 1 FROM users WHERE id = app_user_id() AND kind = 'owner') THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  SELECT * INTO i FROM order_intents WHERE token_hash = p_token_hash AND expires_at > now() FOR UPDATE;
  IF NOT FOUND OR (i.claimed_firm_id IS NOT NULL AND i.claimed_firm_id <> f) THEN RETURN NULL; END IF;   -- unknown, expired or someone else's: the same answer
  IF i.claimed_firm_id IS NULL THEN UPDATE order_intents SET claimed_firm_id = f, claimed_at = now() WHERE id = i.id; END IF;
  RETURN jsonb_build_object('modules', i.modules, 'cleanup', i.cleanup, 'fresh', i.claimed_firm_id IS NULL);   -- fresh: first claim (a new sign-up was claimed already)
END $$;

/** The selection this customer arrived with (the newest within 30 days), or null. */
CREATE FUNCTION my_order_intent() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('modules', modules, 'cleanup', cleanup) FROM order_intents
   WHERE claimed_firm_id = app_firm_id() AND app_firm_id() IS NOT NULL AND claimed_at > now() - interval '30 days' ORDER BY claimed_at DESC LIMIT 1
$$;

REVOKE ALL ON FUNCTION order_intent_create(text, text[], boolean, text), order_intent_peek(text), signup_attach_meta(text, text, text), signup_finish_meta(text, uuid, uuid), order_intent_claim(text), my_order_intent() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION order_intent_create(text, text[], boolean, text), order_intent_peek(text), signup_attach_meta(text, text, text), signup_finish_meta(text, uuid, uuid), order_intent_claim(text), my_order_intent() TO nusuh_app;
