-- 0042 Support chat between customers and Nusuh Books (the platform owner).
--
-- Anyone signed in to a customer (company users, firm staff, Administrators) can raise an issue: a conversation with a
-- subject and messages. The owner answers from the owner console. It carries only what people write: the owner still
-- never sees anyone's books.
--   Who sees a conversation: the person who raised it, their own customer's Administrators, and the owner.
--   Status: open (waiting for Nusuh Books), answered (waiting for the customer), closed; a new message reopens it.
--   Unread: each side has a last-seen time; messages from the other side after it are unread.
-- Rows are written only through the SECURITY DEFINER functions below, so "from Nusuh Books" cannot be forged.

CREATE TABLE support_threads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id          uuid NOT NULL REFERENCES firms(id),
  company_id       uuid REFERENCES companies(id),        -- the company the person was working in, if any
  opened_by        uuid NOT NULL REFERENCES users(id),
  subject          text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 200),
  category         text NOT NULL DEFAULT 'question' CHECK (category IN ('question', 'problem', 'billing', 'idea', 'other')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  owner_seen_at    timestamptz,
  customer_seen_at timestamptz
);
CREATE INDEX support_threads_firm ON support_threads (firm_id, last_message_at DESC);
CREATE INDEX support_threads_status ON support_threads (status, last_message_at DESC);

CREATE TABLE support_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid NOT NULL REFERENCES support_threads(id),
  author      uuid NOT NULL REFERENCES users(id),
  from_owner  boolean NOT NULL,
  body        text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_messages_thread ON support_messages (thread_id, created_at);
CREATE TRIGGER support_threads_no_delete BEFORE DELETE ON support_threads FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER support_messages_no_change BEFORE UPDATE OR DELETE ON support_messages FOR EACH ROW EXECUTE FUNCTION forbid_change();

/** May the signed-in person see this conversation? */
CREATE FUNCTION support_can_see(p_firm uuid, p_opened_by uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_is_owner() OR p_opened_by = app_user_id()
      OR EXISTS (SELECT 1 FROM users u JOIN firms f ON f.id = u.firm_id
                 WHERE u.id = app_user_id() AND u.kind = 'admin' AND u.status = 'active' AND u.firm_id = p_firm)
$$;

ALTER TABLE support_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY support_threads_read ON support_threads FOR SELECT USING (support_can_see(firm_id, opened_by));
CREATE POLICY support_messages_read ON support_messages FOR SELECT
  USING (EXISTS (SELECT 1 FROM support_threads t WHERE t.id = thread_id AND support_can_see(t.firm_id, t.opened_by)));
GRANT SELECT ON support_threads, support_messages TO nusuh_app;   -- no INSERT or UPDATE: only the functions below write

/** Raises an issue (a person of a customer, never the owner). The company, if given, must be one of theirs. */
CREATE FUNCTION support_open(p_subject text, p_category text, p_company uuid, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u users; tid uuid;
BEGIN
  SELECT * INTO u FROM users WHERE id = app_user_id() AND status = 'active';
  IF u.id IS NULL OR u.kind = 'owner' THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  IF p_company IS NOT NULL AND NOT (p_company = ANY (app_company_ids())) THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF length(btrim(coalesce(p_subject, ''))) = 0 THEN RAISE EXCEPTION 'Say in a few words what it is about.'; END IF;
  IF length(btrim(coalesce(p_body, ''))) = 0 THEN RAISE EXCEPTION 'Write your message.'; END IF;
  INSERT INTO support_threads (firm_id, company_id, opened_by, subject, category, customer_seen_at)
  VALUES (u.firm_id, p_company, u.id, btrim(p_subject), coalesce(p_category, 'question'), now()) RETURNING id INTO tid;
  INSERT INTO support_messages (thread_id, author, from_owner, body) VALUES (tid, u.id, false, btrim(p_body));
  RETURN tid;
END $$;

/** A message in a conversation: from the owner it is answered; from the customer it is open again. */
CREATE FUNCTION support_post(p_thread uuid, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t support_threads; owner boolean := app_is_owner(); mid uuid;
BEGIN
  SELECT * INTO t FROM support_threads WHERE id = p_thread FOR UPDATE;
  IF t.id IS NULL OR NOT support_can_see(t.firm_id, t.opened_by) THEN RAISE EXCEPTION 'Not found.'; END IF;
  IF length(btrim(coalesce(p_body, ''))) = 0 THEN RAISE EXCEPTION 'Write your message.'; END IF;
  INSERT INTO support_messages (thread_id, author, from_owner, body) VALUES (t.id, app_user_id(), owner, btrim(p_body)) RETURNING id INTO mid;
  UPDATE support_threads SET status = CASE WHEN owner THEN 'answered' ELSE 'open' END, last_message_at = now(),
    owner_seen_at = CASE WHEN owner THEN now() ELSE owner_seen_at END, customer_seen_at = CASE WHEN owner THEN customer_seen_at ELSE now() END
  WHERE id = t.id;
  RETURN mid;
END $$;

/** Either side closes a conversation (a new message opens it again). */
CREATE FUNCTION support_close(p_thread uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t support_threads;
BEGIN
  SELECT * INTO t FROM support_threads WHERE id = p_thread FOR UPDATE;
  IF t.id IS NULL OR NOT support_can_see(t.firm_id, t.opened_by) THEN RAISE EXCEPTION 'Not found.'; END IF;
  UPDATE support_threads SET status = 'closed' WHERE id = t.id;
END $$;

/** Marks a conversation read for the side that is looking at it. */
CREATE FUNCTION support_seen(p_thread uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t support_threads;
BEGIN
  SELECT * INTO t FROM support_threads WHERE id = p_thread;
  IF t.id IS NULL OR NOT support_can_see(t.firm_id, t.opened_by) THEN RAISE EXCEPTION 'Not found.'; END IF;
  IF app_is_owner() THEN UPDATE support_threads SET owner_seen_at = now() WHERE id = t.id;
  ELSE UPDATE support_threads SET customer_seen_at = now() WHERE id = t.id; END IF;
END $$;

/** The conversations the person may see, with the customer, the person who raised it, the company, and unread. */
CREATE FUNCTION support_list() RETURNS TABLE (id uuid, subject text, category text, status text, created_at timestamptz, last_message_at timestamptz,
  firm_id uuid, customer text, customer_kind text, opened_by uuid, opened_by_name text, company text, messages int, unread int, last_body text, last_from_owner boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.subject, t.category, t.status, t.created_at, t.last_message_at, t.firm_id, f.name, f.kind, t.opened_by, u.full_name, c.name,
    (SELECT count(*)::int FROM support_messages m WHERE m.thread_id = t.id),
    (SELECT count(*)::int FROM support_messages m WHERE m.thread_id = t.id AND m.from_owner <> app_is_owner()
       AND m.created_at > coalesce(CASE WHEN app_is_owner() THEN t.owner_seen_at ELSE t.customer_seen_at END, '-infinity')),
    (SELECT m.body FROM support_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1),
    (SELECT m.from_owner FROM support_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1)
  FROM support_threads t JOIN firms f ON f.id = t.firm_id JOIN users u ON u.id = t.opened_by LEFT JOIN companies c ON c.id = t.company_id
  WHERE app_user_id() IS NOT NULL AND support_can_see(t.firm_id, t.opened_by)
  ORDER BY (t.status = 'closed'), t.last_message_at DESC
$$;

/** One conversation's messages, with who wrote each (Nusuh Books' people are shown as Nusuh Books). */
CREATE FUNCTION support_messages_of(p_thread uuid) RETURNS TABLE (id uuid, from_owner boolean, author_name text, mine boolean, body text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.id, m.from_owner, CASE WHEN m.from_owner AND NOT app_is_owner() THEN 'Nusuh Books' ELSE u.full_name END, m.author = app_user_id(), m.body, m.created_at
  FROM support_messages m JOIN support_threads t ON t.id = m.thread_id JOIN users u ON u.id = m.author
  WHERE m.thread_id = p_thread AND support_can_see(t.firm_id, t.opened_by)
  ORDER BY m.created_at
$$;

/** For the owner's reply email: who raised the conversation (the owner cannot read other customers' people). */
CREATE FUNCTION support_opener(p_thread uuid) RETURNS TABLE (firm_id uuid, subject text, name text, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.firm_id, t.subject, u.full_name, u.email FROM support_threads t JOIN users u ON u.id = t.opened_by
  WHERE t.id = p_thread AND app_is_owner()
$$;

CREATE TRIGGER support_threads_audit AFTER INSERT OR UPDATE OR DELETE ON support_threads FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER support_messages_audit AFTER INSERT OR UPDATE OR DELETE ON support_messages FOR EACH ROW EXECUTE FUNCTION audit_row();
REVOKE ALL ON FUNCTION support_can_see(uuid, uuid), support_open(text, text, uuid, text), support_post(uuid, text), support_close(uuid), support_seen(uuid),
  support_list(), support_messages_of(uuid), support_opener(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support_can_see(uuid, uuid), support_open(text, text, uuid, text), support_post(uuid, text), support_close(uuid), support_seen(uuid),
  support_list(), support_messages_of(uuid), support_opener(uuid) TO nusuh_app;
