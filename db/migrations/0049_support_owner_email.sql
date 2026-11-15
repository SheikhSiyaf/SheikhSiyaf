-- 0049 A new support issue emails the platform owner.
--
-- When a customer's person raises a support issue, every active owner account gets an email in the outbox (sent by
-- the normal email job; held while OUTSIDE_CALLS=off). It carries the issue's subject and its category, and the number
-- of conversations waiting for an answer; never the message, the customer's or person's name, or accounting data.
-- Replies in an existing conversation send nothing.

CREATE OR REPLACE FUNCTION support_open(p_subject text, p_category text, p_company uuid, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u users; tid uuid; waiting int; platform uuid; subj text := left(btrim(coalesce(p_subject, '')), 200);
BEGIN
  SELECT * INTO u FROM users WHERE id = app_user_id() AND status = 'active';
  IF u.id IS NULL OR u.kind = 'owner' THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  IF p_company IS NOT NULL AND NOT (p_company = ANY (app_company_ids())) THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF length(subj) = 0 THEN RAISE EXCEPTION 'Say in a few words what it is about.'; END IF;
  IF length(btrim(coalesce(p_body, ''))) = 0 THEN RAISE EXCEPTION 'Write your message.'; END IF;
  INSERT INTO support_threads (firm_id, company_id, opened_by, subject, category, customer_seen_at)
  VALUES (u.firm_id, p_company, u.id, subj, coalesce(p_category, 'question'), now()) RETURNING id INTO tid;
  INSERT INTO support_messages (thread_id, author, from_owner, body) VALUES (tid, u.id, false, btrim(p_body));

  SELECT count(*)::int INTO waiting FROM support_threads WHERE status = 'open';
  SELECT id INTO platform FROM firms WHERE kind = 'platform' ORDER BY id LIMIT 1;
  INSERT INTO email_outbox (firm_id, company_id, kind, to_email, to_name, subject, body_text, created_by)
  SELECT platform, NULL, 'notice', o.email, o.full_name,
         'New support issue: ' || subj || ' · طلب دعم جديد',
         'A customer raised a new support issue.' || E'\n' ||
         'Subject: ' || subj || E'\n' ||
         'Category: ' || coalesce(p_category, 'question') || E'\n' ||
         'Conversations waiting for an answer: ' || waiting || E'\n\n' ||
         'Read it in the owner console under Support.' || E'\n\n' ||
         'رفع أحد العملاء طلب دعم جديداً.' || E'\n' ||
         'الموضوع: ' || subj || E'\n' ||
         'محادثات تنتظر الرد: ' || waiting || E'\n' ||
         'اقرأه في لوحة المالك تحت الدعم.',
         u.id
  FROM users o WHERE o.kind = 'owner' AND o.status = 'active' AND o.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$';
  RETURN tid;
END $$;
REVOKE ALL ON FUNCTION support_open(text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support_open(text, text, uuid, text) TO nusuh_app;
