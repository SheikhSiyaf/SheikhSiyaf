-- 0053 Sessions end when they should, and a two-factor code works once (security review, step 2).
--
-- 1. users.session_version is part of every sign-in cookie. A request is refused when the cookie's version is not the
--    person's current one. It goes up when the person signs out, when the password or the two-factor secret changes
--    (also through a reset or an Administrator's two-factor reset) and when the person is suspended or reactivated.
--    It only ever goes up, so nobody can bring an old cookie back to life.
-- 2. users.totp_last_step remembers the 30-second step of the last two-factor code accepted. A code from that step or an
--    earlier one is refused, so a code seen over someone's shoulder cannot be used again. It only ever goes up.

ALTER TABLE users ADD COLUMN session_version integer NOT NULL DEFAULT 1,
                  ADD COLUMN totp_last_step bigint;

CREATE FUNCTION before_user_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.session_version < OLD.session_version THEN NEW.session_version := OLD.session_version; END IF;
  IF OLD.totp_last_step IS NOT NULL AND (NEW.totp_last_step IS NULL OR NEW.totp_last_step < OLD.totp_last_step) THEN
    NEW.totp_last_step := OLD.totp_last_step;
  END IF;
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.totp_secret_enc IS DISTINCT FROM OLD.totp_secret_enc
     OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.session_version := greatest(NEW.session_version, OLD.session_version + 1);
  END IF;
  IF NEW.totp_secret_enc IS DISTINCT FROM OLD.totp_secret_enc THEN NEW.totp_last_step := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_session_guard BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION before_user_session_guard();

/** The version a new sign-in cookie carries. */
CREATE FUNCTION session_version_of(p_user uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT session_version FROM users WHERE id = p_user AND status = 'active' AND kind <> 'system'
$$;

/** Is this cookie's version still the person's current one? */
CREATE FUNCTION session_ok(p_user uuid, p_version integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT session_version = p_version FROM users WHERE id = p_user AND status = 'active' AND kind <> 'system'), false)
$$;

/** Sign out: every cookie of the signed-in person stops working. */
CREATE FUNCTION end_own_sessions() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE users SET session_version = session_version + 1 WHERE id = app_user_id()
$$;

/** Accepts a two-factor code's time step once: true the first time, false for that step or an earlier one again. */
CREATE FUNCTION totp_use(p_user uuid, p_step bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE users SET totp_last_step = p_step WHERE id = p_user AND (totp_last_step IS NULL OR totp_last_step < p_step);
  RETURN FOUND;
END $$;

-- Internal helpers the app never calls with a person's input (security review finding 7): only the owner runs them.
REVOKE EXECUTE ON FUNCTION entry_amount(uuid, uuid, uuid, text) FROM PUBLIC, nusuh_app;
REVOKE EXECUTE ON FUNCTION add_default_client_roles(uuid) FROM PUBLIC, nusuh_app;
