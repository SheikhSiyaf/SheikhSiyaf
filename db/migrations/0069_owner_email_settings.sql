-- 0069 Owner Settings: a verified change of sign-in email, a backup email for the owner, and test emails.
--
-- The email a person signs in with is the account itself, so it only changes through a link sent to the NEW address
-- (one hour, used once), after the person proved who they are with their password (and two-factor code). A changed
-- sign-in email ends every older sign-in. The backup email (platform owner only) counts only after its own link is used.
-- Test emails go only to the owner's own verified addresses, at most 5 presses a day.

ALTER TABLE users
  ADD COLUMN backup_email text CHECK (backup_email IS NULL OR backup_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  ADD COLUMN backup_email_verified_at timestamptz,
  ADD CONSTRAINT users_backup_email_owner_only CHECK (backup_email IS NULL OR kind = 'owner');

-- Waiting changes. Only the hash of the link is kept. No policy and no grant: only the functions below read or write it.
CREATE TABLE email_change_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  purpose     text NOT NULL CHECK (purpose IN ('main', 'backup')),
  new_email   text NOT NULL CHECK (new_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  token_hash  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  used_at     timestamptz
);
CREATE INDEX email_change_requests_user ON email_change_requests (user_id, created_at DESC);
ALTER TABLE email_change_requests ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER email_change_requests_no_delete BEFORE DELETE ON email_change_requests FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Which test emails the owner pressed, and which queued email each became (its status is read from email_outbox).
CREATE TABLE email_tests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch       uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id),
  outbox_id   uuid NOT NULL REFERENCES email_outbox(id),
  to_email    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_tests_user ON email_tests (user_id, created_at DESC);
ALTER TABLE email_tests ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER email_tests_no_delete BEFORE DELETE ON email_tests FOR EACH ROW EXECUTE FUNCTION forbid_change();

/** The signed-in person's own addresses. */
CREATE FUNCTION own_email_settings() RETURNS TABLE (email text, backup_email text, backup_verified boolean, kind user_kind)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.email, u.backup_email, (u.backup_email IS NOT NULL AND u.backup_email_verified_at IS NOT NULL), u.kind
  FROM users u WHERE u.id = app_user_id() AND u.status = 'active'
$$;

/** Changes the signed-in person has asked for and not yet confirmed. */
CREATE FUNCTION own_pending_email_changes() RETURNS TABLE (purpose text, new_email text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.purpose, r.new_email, r.expires_at FROM email_change_requests r
  WHERE r.user_id = app_user_id() AND r.used_at IS NULL AND r.expires_at > now() ORDER BY r.created_at DESC
$$;

/** Asks for a change (the link's hash is stored; the server mails the link to the NEW address). A newer request replaces an older one. */
CREATE FUNCTION email_change_request(p_purpose text, p_new_email text, p_token_hash text) RETURNS TABLE (old_email text, backup_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE uid uuid := app_user_id(); u users%ROWTYPE; n text := lower(btrim(coalesce(p_new_email, '')));
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'Please sign in.'; END IF;
  SELECT * INTO u FROM users WHERE id = uid AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Please sign in.'; END IF;
  IF p_purpose NOT IN ('main', 'backup') THEN RAISE EXCEPTION 'Unknown kind of change.'; END IF;
  IF p_purpose = 'backup' AND u.kind <> 'owner' THEN RAISE EXCEPTION 'Only the platform owner has a backup email.'; END IF;
  IF n !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'Enter a valid email address.'; END IF;
  IF lower(u.email) = n THEN RAISE EXCEPTION 'That address is already your sign-in email.'; END IF;
  -- The same wording whether the address is free or not: this must not tell anyone which addresses have accounts.
  IF p_purpose = 'main' AND EXISTS (SELECT 1 FROM users x WHERE lower(x.email) = n) THEN RAISE EXCEPTION 'That address cannot be used. Choose another.'; END IF;
  IF (SELECT count(*) FROM email_change_requests r WHERE r.user_id = uid AND r.created_at > now() - interval '1 day') >= 6 THEN
    RAISE EXCEPTION 'Too many requests today. Try again tomorrow.';
  END IF;
  UPDATE email_change_requests r SET used_at = now() WHERE r.user_id = uid AND r.purpose = p_purpose AND r.used_at IS NULL;
  INSERT INTO email_change_requests (user_id, purpose, new_email, token_hash) VALUES (uid, p_purpose, n, p_token_hash);
  RETURN QUERY SELECT u.email, CASE WHEN u.backup_email_verified_at IS NOT NULL THEN u.backup_email END;
END $$;

/** What a link would do, for the confirmation page (nobody signed in). */
CREATE FUNCTION email_change_info(p_token_hash text) RETURNS TABLE (purpose text, new_email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.purpose, r.new_email FROM email_change_requests r JOIN users u ON u.id = r.user_id
  WHERE r.token_hash = p_token_hash AND r.used_at IS NULL AND r.expires_at > now() AND u.status = 'active'
$$;

/** Uses the link (nobody signed in; the audit log records the person). A new sign-in email ends every older sign-in. */
CREATE FUNCTION email_change_confirm(p_token_hash text)
RETURNS TABLE (ok boolean, purpose text, user_id uuid, full_name text, old_email text, new_email text, backup_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r email_change_requests%ROWTYPE; u users%ROWTYPE;
BEGIN
  SELECT * INTO r FROM email_change_requests WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text; RETURN; END IF;
  SELECT * INTO u FROM users WHERE id = r.user_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text; RETURN; END IF;
  PERFORM set_config('app.user_id', u.id::text, true);
  IF r.purpose = 'main' THEN
    IF EXISTS (SELECT 1 FROM users x WHERE lower(x.email) = r.new_email AND x.id <> u.id) THEN
      UPDATE email_change_requests SET used_at = now() WHERE id = r.id;
      RETURN QUERY SELECT false, NULL::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text; RETURN;
    END IF;
    UPDATE users SET email = r.new_email, session_version = session_version + 1 WHERE id = u.id;
  ELSE
    UPDATE users SET backup_email = r.new_email, backup_email_verified_at = now() WHERE id = u.id;
  END IF;
  UPDATE email_change_requests SET used_at = now() WHERE id = r.id;
  RETURN QUERY SELECT true, r.purpose, u.id, u.full_name, u.email, r.new_email, CASE WHEN u.backup_email_verified_at IS NOT NULL THEN u.backup_email END;
END $$;

/** Platform owner only: queues a test email to the owner's own sign-in email (and the verified backup). Never to any other address. */
CREATE FUNCTION owner_queue_test_emails(p_subject text, p_text text, p_html text) RETURNS TABLE (outbox_id uuid, to_email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE uid uuid := app_user_id(); u users%ROWTYPE; b uuid := gen_random_uuid(); a text; nid uuid;
BEGIN
  SELECT * INTO u FROM users WHERE id = uid AND kind = 'owner' AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF EXISTS (SELECT 1 FROM email_tests t WHERE t.user_id = uid AND t.created_at > now() - interval '20 seconds') THEN
    RAISE EXCEPTION 'Wait a few seconds before sending another test.';
  END IF;
  IF (SELECT count(DISTINCT t.batch) FROM email_tests t WHERE t.user_id = uid AND t.created_at > now() - interval '1 day') >= 5 THEN
    RAISE EXCEPTION 'You have sent 5 test emails today. Try again tomorrow.';
  END IF;
  FOR a IN SELECT x FROM unnest(ARRAY[u.email, CASE WHEN u.backup_email_verified_at IS NOT NULL THEN u.backup_email END]) AS x WHERE x IS NOT NULL LOOP
    INSERT INTO email_outbox (firm_id, kind, to_email, to_name, subject, body_text, body_html, created_by)
    VALUES (u.firm_id, 'notice', lower(a), u.full_name, p_subject, p_text, p_html, uid) RETURNING id INTO nid;
    INSERT INTO email_tests (batch, user_id, outbox_id, to_email) VALUES (b, uid, nid, lower(a));
    outbox_id := nid; to_email := lower(a); RETURN NEXT;
  END LOOP;
END $$;

/** Platform owner only: the last test emails and what became of them. */
CREATE FUNCTION owner_email_tests() RETURNS TABLE (id uuid, created_at timestamptz, to_email text, status text, attempts int, last_error text, sent_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.created_at, t.to_email, o.status, o.attempts, o.last_error, o.sent_at
  FROM email_tests t JOIN email_outbox o ON o.id = t.outbox_id
  WHERE t.user_id = app_user_id() AND EXISTS (SELECT 1 FROM users x WHERE x.id = app_user_id() AND x.kind = 'owner')
  ORDER BY t.created_at DESC LIMIT 10
$$;

-- The links in the new emails are scrubbed from the stored copy once sent, like invitation links.
/** For the sender job only: the result. A failure is retried later (1, 5, 30 minutes, then 2 hours), up to 6 times. */
CREATE OR REPLACE FUNCTION email_done(p_id uuid, p_ok boolean, p_error text, p_provider_id text, p_hold boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Only the server sends email.'; END IF;
  UPDATE email_outbox SET
    status = CASE WHEN p_ok THEN 'sent' WHEN p_hold THEN 'queued' WHEN attempts >= 6 THEN 'failed' ELSE 'queued' END,
    sent_at = CASE WHEN p_ok THEN now() END, provider_id = p_provider_id, last_error = CASE WHEN p_ok THEN NULL ELSE p_error END,
    body_text = CASE WHEN p_ok THEN regexp_replace(body_text, '/(invite|i|confirm-email)/[A-Za-z0-9_-]+', '/\1/(link sent)', 'g') ELSE body_text END,
    body_html = CASE WHEN p_ok THEN regexp_replace(body_html, '/(invite|i|confirm-email)/[A-Za-z0-9_-]+', '/\1/(link sent)', 'g') ELSE body_html END,
    attempts = CASE WHEN p_hold THEN greatest(attempts - 1, 0) ELSE attempts END,
    next_try_at = now() + CASE WHEN p_hold THEN interval '15 minutes'
                               ELSE (ARRAY[interval '1 minute', interval '5 minutes', interval '30 minutes', interval '2 hours', interval '2 hours', interval '2 hours'])[least(attempts, 6)] END
  WHERE id = p_id;
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['own_email_settings()', 'own_pending_email_changes()', 'email_change_request(text, text, text)', 'email_change_info(text)',
                           'email_change_confirm(text)', 'owner_queue_test_emails(text, text, text)', 'owner_email_tests()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO nusuh_app', f);
  END LOOP;
END $$;
