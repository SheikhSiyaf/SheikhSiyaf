-- 0077 Self-service sign-up for the free trial.
-- A visitor gives a name, company, e-mail and password; nothing is created until the e-mail link is opened (so nobody can start a trial with
-- somebody else's address). The link makes the customer, its company, its books, its one user (job title Owner, who can also manage users)
-- and its 15-day trial, all in one transaction. One trial per person and per company: the e-mail (in a form where Gmail dots and +tags
-- count as the same address) and the company registration number are remembered as keyed hashes in trial_fingerprints, which survive
-- if the customer is later deleted. Every attempt, allowed or refused, is written to signup_events for the owner. Customers never read
-- these tables; the server uses the functions below, and only the owner reads the log.

ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_kind_check;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_kind_check
  CHECK (kind IN ('invitation', 'password_reset', 'document', 'statement', 'reminder', 'approval', 'notice', 'billing', 'trial', 'signup'));

CREATE TABLE signup_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  email_key      text NOT NULL,                      -- keyed hash of the e-mail's comparison form
  cr_key         text,                               -- keyed hash of the company registration number, when given
  full_name      text NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 120),
  company_name   text NOT NULL CHECK (char_length(company_name) BETWEEN 2 AND 160),
  country        text NOT NULL CHECK (country IN ('SA', 'AE')),
  city           text NOT NULL DEFAULT 'Riyadh' CHECK (char_length(city) BETWEEN 2 AND 60),
  cr_number      text CHECK (cr_number IS NULL OR char_length(cr_number) <= 30),
  password_hash  text NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  ip_key         text NOT NULL,                      -- keyed hash of the address (never the address itself)
  lang           text NOT NULL DEFAULT 'en' CHECK (lang IN ('en', 'ar')),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'replaced')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  verified_at    timestamptz
);
CREATE UNIQUE INDEX signup_requests_one_pending ON signup_requests (email_key) WHERE status = 'pending';
ALTER TABLE signup_requests ENABLE ROW LEVEL SECURITY;   -- no policy and no grant: only the functions below can touch it

CREATE TABLE trial_fingerprints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_key   text NOT NULL UNIQUE,
  cr_key      text UNIQUE,
  firm_id     uuid,                                   -- no foreign key on purpose: the record stays after a customer is deleted
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE trial_fingerprints ENABLE ROW LEVEL SECURITY;

CREATE TABLE signup_events (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL CHECK (kind IN ('started', 'verified', 'blocked_email_used', 'blocked_org_used', 'blocked_disposable', 'blocked_password', 'throttled', 'honeypot', 'bad_token', 'expired_token', 'created_by_owner')),
  email_domain  text,
  email_key     text,
  company_name  text,
  country       text,
  ip_key        text,
  firm_id       uuid,
  flags         text[] NOT NULL DEFAULT ARRAY[]::text[]
);
CREATE INDEX signup_events_at ON signup_events (at DESC);
CREATE INDEX signup_events_ip ON signup_events (ip_key, at);
ALTER TABLE signup_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY signup_events_owner ON signup_events FOR SELECT USING (app_is_owner());
GRANT SELECT ON signup_events TO nusuh_app;
CREATE TRIGGER signup_events_immutable BEFORE UPDATE OR DELETE ON signup_events FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- The platform owner's user id, so the server can create the customer the same way the owner does (nobody signed in only).
-- ---------------------------------------------------------------------------
CREATE FUNCTION signup_platform_owner() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Only the server does this.'; END IF;
  RETURN (SELECT u.id FROM users u WHERE u.kind = 'owner' AND u.status = 'active' ORDER BY u.created_at, u.id LIMIT 1);
END $$;

-- ---------------------------------------------------------------------------
-- Step 1: record a request (after the server checked the rules that need no database). Returns what happened:
--   sent | email_used | org_used | throttled (too many from one address) | quiet (nothing to send, nothing to say)
-- ---------------------------------------------------------------------------
CREATE FUNCTION signup_begin(p_email text, p_email_key text, p_cr_key text, p_name text, p_company text, p_country text, p_cr text,
                             p_password_hash text, p_token_hash text, p_ip_key text, p_lang text, p_city text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int; last_at timestamptz;
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Only the server does this.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('signup:' || p_email_key));
  -- too many requests from one address in an hour, or the same e-mail again within a minute
  SELECT count(*) INTO n FROM signup_requests WHERE ip_key = p_ip_key AND created_at > now() - interval '1 hour';
  IF n >= 6 THEN
    INSERT INTO signup_events (kind, email_domain, email_key, company_name, country, ip_key) VALUES ('throttled', split_part(lower(p_email), '@', 2), p_email_key, p_company, p_country, p_ip_key);
    RETURN 'throttled';
  END IF;
  -- already an account or an earlier trial with this address (in any spelling that counts as the same): the screen says the same as for a new
  -- address; only the mailbox owner is told, and at most three times an hour so this form cannot be used to flood somebody's inbox
  IF EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(p_email)) OR EXISTS (SELECT 1 FROM trial_fingerprints WHERE email_key = p_email_key) THEN
    SELECT count(*) INTO n FROM signup_events WHERE kind = 'blocked_email_used' AND email_key = p_email_key AND at > now() - interval '1 hour';
    INSERT INTO signup_events (kind, email_domain, email_key, company_name, country, ip_key) VALUES ('blocked_email_used', split_part(lower(p_email), '@', 2), p_email_key, p_company, p_country, p_ip_key);
    RETURN CASE WHEN n >= 3 THEN 'quiet' ELSE 'email_used' END;
  END IF;
  -- the same new address again within a minute, or more than five times an hour: nothing more is sent (the screen still says it was sent)
  SELECT max(created_at), count(*) INTO last_at, n FROM signup_requests WHERE email_key = p_email_key AND created_at > now() - interval '1 hour';
  IF (last_at IS NOT NULL AND last_at > now() - interval '60 seconds') OR n >= 5 THEN RETURN 'quiet'; END IF;
  -- already a company or an earlier trial with this registration number
  IF p_cr_key IS NOT NULL AND (EXISTS (SELECT 1 FROM trial_fingerprints WHERE cr_key = p_cr_key) OR EXISTS (SELECT 1 FROM companies WHERE cr_number = p_cr)
      OR EXISTS (SELECT 1 FROM signup_requests WHERE cr_key = p_cr_key AND status = 'pending' AND email_key <> p_email_key)) THEN
    INSERT INTO signup_events (kind, email_domain, email_key, company_name, country, ip_key) VALUES ('blocked_org_used', split_part(lower(p_email), '@', 2), p_email_key, p_company, p_country, p_ip_key);
    RETURN 'org_used';
  END IF;
  UPDATE signup_requests SET status = 'replaced' WHERE email_key = p_email_key AND status = 'pending';
  INSERT INTO signup_requests (email, email_key, cr_key, full_name, company_name, country, city, cr_number, password_hash, token_hash, ip_key, lang, expires_at)
  VALUES (lower(btrim(p_email)), p_email_key, p_cr_key, btrim(p_name), btrim(p_company), p_country, btrim(p_city), nullif(btrim(coalesce(p_cr, '')), ''), p_password_hash, p_token_hash, p_ip_key, p_lang, now() + interval '24 hours');
  INSERT INTO signup_events (kind, email_domain, email_key, company_name, country, ip_key) VALUES ('started', split_part(lower(p_email), '@', 2), p_email_key, p_company, p_country, p_ip_key);
  RETURN 'sent';
END $$;

-- ---------------------------------------------------------------------------
-- Step 2: the link was opened. Takes the request once (a second try finds nothing) and records the permanent fingerprint.
-- Called in the same transaction that creates the customer, so a failure leaves the request waiting.
-- ---------------------------------------------------------------------------
CREATE FUNCTION signup_take(p_token_hash text) RETURNS TABLE (email text, email_key text, cr_key text, full_name text, company_name text, country text, city text, cr_number text, password_hash text, lang text, outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r signup_requests;
BEGIN
  IF NOT (app_user_id() IS NULL OR app_is_owner()) THEN RAISE EXCEPTION 'Only the server does this.'; END IF;
  SELECT * INTO r FROM signup_requests WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR r.status <> 'pending' THEN
    INSERT INTO signup_events (kind) VALUES ('bad_token');
    outcome := 'bad'; RETURN NEXT; RETURN;
  END IF;
  IF r.expires_at < now() THEN
    INSERT INTO signup_events (kind, email_domain, email_key, company_name, country, ip_key) VALUES ('expired_token', split_part(r.email, '@', 2), r.email_key, r.company_name, r.country, r.ip_key);
    outcome := 'expired'; RETURN NEXT; RETURN;
  END IF;
  -- two people confirming the same company number (or address) at the same moment take turns, so the second sees the first
  PERFORM pg_advisory_xact_lock(hashtext('signup-cr:' || coalesce(r.cr_key, r.email_key)));
  PERFORM pg_advisory_xact_lock(hashtext('signup-email:' || r.email_key));
  -- the address or registration number may have been used by somebody else since the request was made
  IF EXISTS (SELECT 1 FROM users WHERE lower(users.email) = r.email) OR EXISTS (SELECT 1 FROM trial_fingerprints f WHERE f.email_key = r.email_key)
     OR (r.cr_key IS NOT NULL AND (EXISTS (SELECT 1 FROM trial_fingerprints f WHERE f.cr_key = r.cr_key) OR EXISTS (SELECT 1 FROM companies c WHERE c.cr_number = r.cr_number))) THEN
    UPDATE signup_requests SET status = 'replaced' WHERE id = r.id;
    outcome := 'used'; RETURN NEXT; RETURN;
  END IF;
  UPDATE signup_requests SET status = 'verified', verified_at = now() WHERE id = r.id;
  INSERT INTO trial_fingerprints (email_key, cr_key) VALUES (r.email_key, r.cr_key);
  email := r.email; email_key := r.email_key; cr_key := r.cr_key; full_name := r.full_name; company_name := r.company_name; country := r.country; city := r.city;
  cr_number := r.cr_number; password_hash := r.password_hash; lang := r.lang; outcome := 'ok';
  RETURN NEXT;
END $$;

/** After the customer exists: ties the fingerprint to it and logs the sign-up, with any flags (for example a company name that is already in use). */
CREATE FUNCTION signup_done(p_email_key text, p_firm uuid, p_email text, p_company text, p_country text, p_ip_key text) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE fl text[] := ARRAY[]::text[];
BEGIN
  IF NOT (app_user_id() IS NULL OR app_is_owner()) THEN RAISE EXCEPTION 'Only the server does this.'; END IF;
  UPDATE trial_fingerprints SET firm_id = p_firm WHERE email_key = p_email_key;
  IF EXISTS (SELECT 1 FROM companies c WHERE lower(btrim(c.name)) = lower(btrim(p_company)) AND c.country = p_country AND c.firm_id <> p_firm) THEN fl := fl || 'same_company_name'; END IF;
  IF (SELECT count(*) FROM signup_events e WHERE e.ip_key = p_ip_key AND e.kind = 'verified' AND e.at > now() - interval '7 days') >= 2 THEN fl := fl || 'same_address_often'; END IF;
  INSERT INTO signup_events (kind, email_domain, email_key, company_name, country, ip_key, firm_id, flags) VALUES ('verified', split_part(lower(p_email), '@', 2), p_email_key, p_company, p_country, p_ip_key, p_firm, fl);
  RETURN fl;
END $$;

/** A line in the log for a customer the owner created by hand (so the owner's record shows every customer, however it began). */
CREATE FUNCTION signup_log_event(p_kind text, p_email text, p_email_key text, p_company text, p_country text, p_ip_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (app_user_id() IS NULL OR app_is_owner()) THEN RAISE EXCEPTION 'Only the server does this.'; END IF;
  INSERT INTO signup_events (kind, email_domain, email_key, company_name, country, ip_key) VALUES (p_kind, split_part(lower(coalesce(p_email, '')), '@', 2), p_email_key, p_company, p_country, p_ip_key);
END $$;

/** Housekeeping: pending requests older than a week are removed. */
CREATE FUNCTION signup_cleanup() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Only the server does this.'; END IF;
  DELETE FROM signup_requests WHERE (status <> 'verified' AND created_at < now() - interval '7 days') OR (status = 'verified' AND verified_at < now() - interval '30 days');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

/** The owner's view of recent sign-up activity, newest first (no passwords, no full e-mails of refused attempts: only the domain). */
CREATE FUNCTION owner_signup_activity(p_limit int DEFAULT 200) RETURNS TABLE (id bigint, at timestamptz, kind text, email_domain text, company_name text, country text, firm_id uuid, flags text[], same_key_attempts int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  RETURN QUERY SELECT e.id, e.at, e.kind, e.email_domain, e.company_name, e.country, e.firm_id, e.flags,
    (SELECT count(*)::int FROM signup_events x WHERE x.email_key IS NOT NULL AND x.email_key = e.email_key)
  FROM signup_events e ORDER BY e.at DESC, e.id DESC LIMIT least(coalesce(p_limit, 200), 500);
END $$;

REVOKE ALL ON FUNCTION signup_platform_owner(), signup_begin(text, text, text, text, text, text, text, text, text, text, text, text), signup_take(text), signup_done(text, uuid, text, text, text, text),
  signup_log_event(text, text, text, text, text, text), signup_cleanup(), owner_signup_activity(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION signup_platform_owner(), signup_begin(text, text, text, text, text, text, text, text, text, text, text, text), signup_take(text), signup_done(text, uuid, text, text, text, text),
  signup_log_event(text, text, text, text, text, text), signup_cleanup(), owner_signup_activity(int) TO nusuh_app;
