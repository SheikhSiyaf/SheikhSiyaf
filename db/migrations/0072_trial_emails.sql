-- 0072 Trial reminder e-mails: the log that makes each reminder go out once only, and what the daily job needs.
--
-- Which reminder is current, and when, is decided in src/books/trialRules.ts (currentNotice). The job asks for the unpaid trials
-- below, claims the reminder in trial_email_log (one row per customer and reminder: a second claim finds the row and sends
-- nothing), and queues the e-mail in the ordinary outbox. The claim and the queued e-mail are saved together or not at all,
-- so a failure never leaves a reminder marked as sent that was not queued, nor queues one twice.
-- Only the platform owner can read the log. Nobody can change or delete a row.

ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_kind_check;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_kind_check
  CHECK (kind IN ('invitation', 'password_reset', 'document', 'statement', 'reminder', 'approval', 'notice', 'billing', 'trial'));

CREATE TABLE trial_email_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id          uuid NOT NULL REFERENCES firms(id),
  template         text NOT NULL CHECK (template IN ('welcome', 'five_days', 'two_days', 'last_notice', 'trial_ended', 'grace_week', 'closing_soon')),
  to_email         text NOT NULL,
  outbox_id        uuid REFERENCES email_outbox(id),     -- the e-mail to the customer
  copy_outbox_id   uuid REFERENCES email_outbox(id),     -- the copy to hello@, for the last reminders
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firm_id, template)
);
CREATE TRIGGER trial_email_log_attach_only BEFORE UPDATE ON trial_email_log FOR EACH ROW
  WHEN (OLD.outbox_id IS NOT NULL OR (to_jsonb(NEW) - 'outbox_id' - 'copy_outbox_id') <> (to_jsonb(OLD) - 'outbox_id' - 'copy_outbox_id')) EXECUTE FUNCTION forbid_change();
CREATE TRIGGER trial_email_log_no_delete BEFORE DELETE ON trial_email_log FOR EACH ROW EXECUTE FUNCTION forbid_change();
ALTER TABLE trial_email_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY trial_email_log_owner ON trial_email_log FOR SELECT USING (app_is_owner());
GRANT SELECT ON trial_email_log TO nusuh_app;

/** The unpaid trials the daily job looks at, with the first active Administrator to write to and the optional modules switched on. Server or owner only. */
CREATE FUNCTION trial_mail_targets() RETURNS TABLE (firm_id uuid, firm_name text, status text, trial_ends_at timestamptz, grace_ends_at timestamptz,
  converted_at timestamptz, cancelled_at timestamptz, admin_name text, admin_email text, modules text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (app_user_id() IS NULL OR app_is_owner()) THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  RETURN QUERY
  SELECT s.firm_id, f.name, s.status, s.trial_ends_at, s.grace_ends_at, s.converted_at, s.cancelled_at,
         a.full_name, a.email,
         coalesce((SELECT array_agg(DISTINCT m ORDER BY m) FROM companies c, unnest(c.modules) m
                   WHERE c.firm_id = s.firm_id AND c.status = 'active'
                     AND m IN ('Inventory', 'Restaurant', 'Rooms', 'Assets', 'Rentals', 'Projects', 'HRM', 'CRM')), ARRAY[]::text[])
  FROM subscriptions s
  JOIN firms f ON f.id = s.firm_id AND f.status = 'active'
  LEFT JOIN LATERAL (SELECT u.full_name, u.email FROM users u WHERE u.firm_id = s.firm_id AND u.kind = 'admin' AND u.status = 'active' ORDER BY u.created_at, u.id LIMIT 1) a ON true
  WHERE s.trial_ends_at IS NOT NULL AND s.converted_at IS NULL AND s.status IN ('trial', 'trial_ended')
  ORDER BY s.firm_id;
END $$;

/** Claims a reminder for a customer. Returns the log id, or nothing when that reminder was already sent: it is sent once only. */
CREATE FUNCTION trial_email_claim(p_firm uuid, p_template text, p_to text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE nid uuid;
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Only the server sends these.'; END IF;
  INSERT INTO trial_email_log (firm_id, template, to_email) VALUES (p_firm, p_template, lower(btrim(p_to)))
  ON CONFLICT (firm_id, template) DO NOTHING RETURNING id INTO nid;
  RETURN nid;
END $$;

/** Records which queued e-mails a claimed reminder became. */
CREATE FUNCTION trial_email_attach(p_log uuid, p_outbox uuid, p_copy uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Only the server sends these.'; END IF;
  UPDATE trial_email_log SET outbox_id = p_outbox, copy_outbox_id = p_copy WHERE id = p_log;
END $$;

/** For the owner: every trial reminder (all customers, or one), what became of it, and any failure. */
CREATE FUNCTION owner_trial_emails(p_firm uuid DEFAULT NULL) RETURNS TABLE (firm_id uuid, firm_name text, template text, to_email text, queued_at timestamptz,
  status text, attempts int, last_error text, sent_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  RETURN QUERY
  SELECT l.firm_id, f.name, l.template, l.to_email, l.created_at, coalesce(o.status, 'queued'), coalesce(o.attempts, 0), o.last_error, o.sent_at
  FROM trial_email_log l JOIN firms f ON f.id = l.firm_id LEFT JOIN email_outbox o ON o.id = l.outbox_id
  WHERE p_firm IS NULL OR l.firm_id = p_firm
  ORDER BY l.created_at DESC, l.template LIMIT 500;
END $$;

REVOKE ALL ON FUNCTION trial_mail_targets(), trial_email_claim(uuid, text, text), trial_email_attach(uuid, uuid, uuid), owner_trial_emails(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trial_mail_targets(), trial_email_claim(uuid, text, text), trial_email_attach(uuid, uuid, uuid), owner_trial_emails(uuid) TO nusuh_app;
