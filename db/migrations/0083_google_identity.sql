-- Sign in with Google. A person's Google account is remembered by Google's own permanent id for it (the "sub"), never by e-mail alone,
-- so a later change of the e-mail on the Google side cannot open somebody else's account. The first time a Google account with a
-- verified e-mail matching an existing user signs in, the two are linked. Passwords keep working; a Google sign-up gets a password nobody knows
-- (they can set one with "Forgot password").

CREATE TABLE google_identities (
  google_sub  text PRIMARY KEY CHECK (char_length(google_sub) BETWEEN 1 AND 255),
  user_id     uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,   -- one Google account per user, one user per Google account
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE google_identities ENABLE ROW LEVEL SECURITY;   -- no policy and no grant: only the functions below can touch it
CREATE TRIGGER google_identities_audit AFTER INSERT OR UPDATE OR DELETE ON google_identities FOR EACH ROW EXECUTE FUNCTION audit_row();

-- Who is this Google account? Server only, before anybody is signed in. Returns:
--   ok        the user (found by the stored Google id, or linked now by the verified e-mail)
--   none      no user has this Google id or e-mail
--   other     the user with this e-mail is already linked to a different Google account: refused
CREATE FUNCTION google_sign_in_user(p_sub text, p_email text) RETURNS TABLE (user_id uuid, user_email text, outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE uid uuid;
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Only the server does this.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('google:' || p_sub));
  SELECT g.user_id INTO uid FROM google_identities g WHERE g.google_sub = p_sub;
  IF uid IS NOT NULL THEN user_id := uid; user_email := (SELECT u.email FROM users u WHERE u.id = uid); outcome := 'ok'; RETURN NEXT; RETURN; END IF;
  SELECT u.id INTO uid FROM users u WHERE lower(u.email) = lower(p_email);
  IF uid IS NULL THEN outcome := 'none'; RETURN NEXT; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM google_identities g WHERE g.user_id = uid) THEN outcome := 'other'; RETURN NEXT; RETURN; END IF;
  PERFORM set_config('app.user_id', uid::text, true);   -- the audit log records the person themselves
  INSERT INTO google_identities (google_sub, user_id) VALUES (p_sub, uid);
  user_id := uid; user_email := (SELECT u.email FROM users u WHERE u.id = uid); outcome := 'ok'; RETURN NEXT;
END $$;

-- After a Google sign-up created the user: remember the Google id.
CREATE FUNCTION google_link_user(p_sub text, p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (app_user_id() IS NULL OR app_is_owner()) THEN RAISE EXCEPTION 'Only the server does this.'; END IF;
  INSERT INTO google_identities (google_sub, user_id) VALUES (p_sub, p_user) ON CONFLICT DO NOTHING;
END $$;

REVOKE ALL ON FUNCTION google_sign_in_user(text, text), google_link_user(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION google_sign_in_user(text, text), google_link_user(text, uuid) TO nusuh_app;
