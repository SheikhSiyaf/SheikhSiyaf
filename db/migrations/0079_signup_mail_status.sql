-- 0079 What became of each sign-up e-mail. A confirmation link that never arrives is the worst moment of a sign-up, and the cause is usually
-- outside the software (the e-mail service refuses the sender or is not set up). The owner's sign-up activity now shows, for every request,
-- whether its e-mail was sent, is still waiting, or failed, with the e-mail service's own error text.
CREATE TABLE signup_mail (
  id          bigserial PRIMARY KEY,
  email_key   text NOT NULL,
  outbox_id   uuid NOT NULL REFERENCES email_outbox(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signup_mail_key ON signup_mail (email_key, created_at);
ALTER TABLE signup_mail ENABLE ROW LEVEL SECURITY;   -- no policy, no grant: only the functions below

CREATE FUNCTION signup_mail_log(p_email_key text, p_outbox uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Only the server does this.'; END IF;
  INSERT INTO signup_mail (email_key, outbox_id) VALUES (p_email_key, p_outbox);
END $$;

DROP FUNCTION owner_signup_activity(int);
CREATE FUNCTION owner_signup_activity(p_limit int DEFAULT 200) RETURNS TABLE (id bigint, at timestamptz, kind text, email_domain text, company_name text, country text, firm_id uuid, flags text[],
  same_key_attempts int, mail_status text, mail_error text, mail_attempts int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  RETURN QUERY SELECT e.id, e.at, e.kind, e.email_domain, e.company_name, e.country, e.firm_id, e.flags,
    (SELECT count(*)::int FROM signup_events x WHERE x.email_key IS NOT NULL AND x.email_key = e.email_key),
    m.status, m.last_error, m.attempts
  FROM signup_events e
  LEFT JOIN LATERAL (SELECT o.status, o.last_error, o.attempts FROM signup_mail s JOIN email_outbox o ON o.id = s.outbox_id
                     WHERE s.email_key = e.email_key AND e.kind IN ('started', 'blocked_email_used') AND s.created_at >= e.at ORDER BY s.created_at LIMIT 1) m ON true
  ORDER BY e.at DESC, e.id DESC LIMIT least(coalesce(p_limit, 200), 500);
END $$;
REVOKE ALL ON FUNCTION signup_mail_log(text, uuid), owner_signup_activity(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION signup_mail_log(text, uuid), owner_signup_activity(int) TO nusuh_app;
