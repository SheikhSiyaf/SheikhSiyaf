-- 0040 Sign-in throttling in the database.
--
-- Wrong passwords and two-factor codes were counted in each server's memory: a restart forgot them and several
-- servers each counted their own. Now every failure is a row, shared by all servers:
--   account  normalised email: 5 failures in 15 minutes lock the account for 15 minutes (even the right password)
--   ip       client address: 30 failures in 15 minutes, across any accounts, block the address for 15 minutes
--   mfa      person (user id): 5 wrong two-factor codes in 15 minutes lock their code step for 15 minutes
--   reset, pay   other public endpoints (password reset by email, Pay online by invoice link)
-- Unknown emails are counted like known ones. The tables are not per company: the app role has no rights on them and
-- row-level security is on with no policies (deny all), so only the SECURITY DEFINER functions below touch them, like
-- auth_user_by_email. Rows older than 24 hours are purged.

CREATE TABLE auth_attempts (
  id    bigserial PRIMARY KEY,
  kind  text NOT NULL CHECK (kind ~ '^[a-z]{2,20}$'),
  key   text NOT NULL CHECK (length(key) BETWEEN 1 AND 320),
  at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_key ON auth_attempts (kind, key, at);
CREATE INDEX auth_attempts_at ON auth_attempts (at);

CREATE TABLE auth_locks (
  kind   text NOT NULL,
  key    text NOT NULL,
  until  timestamptz NOT NULL,
  PRIMARY KEY (kind, key)
);

REVOKE ALL ON auth_attempts, auth_locks FROM PUBLIC;
REVOKE ALL ON auth_attempts, auth_locks FROM nusuh_app;
ALTER TABLE auth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_locks ENABLE ROW LEVEL SECURITY;

/** Is this key locked at this moment? */
CREATE FUNCTION auth_throttle_blocked(p_kind text, p_key text, p_now timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM auth_locks WHERE kind = p_kind AND key = p_key AND until > p_now)
$$;

/** Records a failure. When the failures in the window reach the limit, the key is locked for the window and, for an
 *  account or a person's two-factor step, the lockout is written to the audit log (no password data). Returns
 *  whether the key is now locked. */
CREATE FUNCTION auth_throttle_fail(p_kind text, p_key text, p_max int, p_window_seconds int, p_now timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int; w interval := make_interval(secs => p_window_seconds); was boolean;
BEGIN
  INSERT INTO auth_attempts (kind, key, at) VALUES (p_kind, p_key, p_now);
  SELECT count(*) INTO n FROM auth_attempts WHERE kind = p_kind AND key = p_key AND at > p_now - w AND at <= p_now;
  IF n < p_max THEN RETURN false; END IF;
  was := EXISTS (SELECT 1 FROM auth_locks WHERE kind = p_kind AND key = p_key AND until > p_now);
  INSERT INTO auth_locks (kind, key, until) VALUES (p_kind, p_key, p_now + w)
    ON CONFLICT (kind, key) DO UPDATE SET until = GREATEST(auth_locks.until, EXCLUDED.until);
  IF NOT was AND p_kind IN ('account', 'mfa') THEN
    INSERT INTO audit_log (user_id, company_id, table_name, row_id, action, detail)
    VALUES (NULL, NULL, 'auth_locks', p_key, 'lockout', jsonb_build_object('kind', p_kind, 'attempts', n, 'until', p_now + w));
  END IF;
  RETURN true;
END $$;

/** A successful sign-in clears that key's count (the account's, never the address's). */
CREATE FUNCTION auth_throttle_clear(p_kind text, p_key text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM auth_attempts WHERE kind = p_kind AND key = p_key AND p_kind <> 'ip';
  DELETE FROM auth_locks WHERE kind = p_kind AND key = p_key AND p_kind <> 'ip';
$$;

/** The scheduled job: attempts older than 24 hours and ended locks go. */
CREATE FUNCTION auth_throttle_purge() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  DELETE FROM auth_attempts WHERE at < now() - interval '24 hours';
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM auth_locks WHERE until < now() - interval '24 hours';
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION auth_throttle_blocked(text, text, timestamptz), auth_throttle_fail(text, text, int, int, timestamptz),
  auth_throttle_clear(text, text), auth_throttle_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_throttle_blocked(text, text, timestamptz), auth_throttle_fail(text, text, int, int, timestamptz),
  auth_throttle_clear(text, text), auth_throttle_purge() TO nusuh_app;
