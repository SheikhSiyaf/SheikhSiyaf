-- 0021: The review layer: queries between the firm and the client, the monthly checklist, explained check
-- findings, and period sign-off ("reviewed by your accountant").
--   * Firm staff on the client (partner, reviewer, staff accountant) raise queries, tick the checklist and explain
--     findings. Everyone on the client can read them and reply to a query.
--   * Only a partner or reviewer signs off a month, and only when it has ended and none of its queries are still
--     open. A sign-off is never changed; a partner or reviewer can withdraw it with a reason (kept).
--   * The automated checks themselves are read from the books (src/books/reviewService.ts); nothing here posts.

CREATE FUNCTION review_roles() RETURNS user_role[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['partner', 'reviewer', 'staff_accountant']::user_role[] $$;
CREATE FUNCTION signoff_roles() RETURNS user_role[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['partner', 'reviewer']::user_role[] $$;
GRANT EXECUTE ON FUNCTION review_roles(), signoff_roles() TO nusuh_app;

CREATE TABLE review_queries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  period_end  date NOT NULL CHECK (period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date),
  subject     text NOT NULL CHECK (btrim(subject) <> ''),
  about_type  text CHECK (about_type IN ('entry', 'document', 'account', 'bank_line', 'check')),
  about_id    text,
  about_label text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  raised_by   uuid NOT NULL REFERENCES users(id),
  raised_at   timestamptz NOT NULL DEFAULT now(),
  closed_by   uuid REFERENCES users(id),
  closed_at   timestamptz,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX review_queries_company ON review_queries (company_id, period_end, status);

CREATE TABLE review_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  query_id   uuid NOT NULL REFERENCES review_queries(id),
  author     uuid NOT NULL REFERENCES users(id),
  body       text NOT NULL CHECK (btrim(body) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_messages_query ON review_messages (query_id, created_at);

CREATE TABLE review_checklist (
  company_id uuid NOT NULL REFERENCES companies(id),
  period_end date NOT NULL CHECK (period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date),
  item       text NOT NULL CHECK (item ~ '^[a-z_]{2,40}$'),
  done       boolean NOT NULL DEFAULT true,
  note       text,
  done_by    uuid NOT NULL REFERENCES users(id),
  done_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, period_end, item)
);

CREATE TABLE review_explained (
  company_id uuid NOT NULL REFERENCES companies(id),
  check_key  text NOT NULL,
  item_key   text NOT NULL,
  note       text NOT NULL CHECK (btrim(note) <> ''),
  by_user    uuid NOT NULL REFERENCES users(id),
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, check_key, item_key)
);

CREATE TABLE review_signoffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  period_end      date NOT NULL CHECK (period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date),
  note            text,
  signed_by       uuid NOT NULL REFERENCES users(id),
  signed_at       timestamptz NOT NULL DEFAULT now(),
  withdrawn_by    uuid REFERENCES users(id),
  withdrawn_at    timestamptz,
  withdraw_reason text,
  CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL) AND (withdrawn_at IS NULL OR btrim(coalesce(withdraw_reason, '')) <> ''))
);
CREATE UNIQUE INDEX review_signoffs_active ON review_signoffs (company_id, period_end) WHERE withdrawn_at IS NULL;

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------
CREATE FUNCTION before_review_query_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.raised_by := app_user_id(); END IF;
    NEW.raised_at := now(); NEW.status := 'open'; NEW.closed_by := NULL; NEW.closed_at := NULL;
    RETURN NEW;
  END IF;
  IF (NEW.company_id, NEW.period_end, NEW.subject, NEW.about_type, NEW.about_id, NEW.raised_by, NEW.raised_at)
     IS DISTINCT FROM (OLD.company_id, OLD.period_end, OLD.subject, OLD.about_type, OLD.about_id, OLD.raised_by, OLD.raised_at) THEN
    RAISE EXCEPTION 'A query keeps its subject; reply to it instead.';
  END IF;
  -- Closing or reopening is for the firm; a client reply marks it answered.
  IF (NEW.status = 'closed' OR OLD.status = 'closed') AND NEW.status IS DISTINCT FROM OLD.status AND NOT app_has_role(NEW.company_id, review_roles()) THEN
    RAISE EXCEPTION 'Only the accounting firm closes or reopens a query.';
  END IF;
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN NEW.closed_by := app_user_id(); NEW.closed_at := now(); END IF;
  IF NEW.status <> 'closed' THEN NEW.closed_by := NULL; NEW.closed_at := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_queries_before_change BEFORE INSERT OR UPDATE ON review_queries FOR EACH ROW EXECUTE FUNCTION before_review_query_change();

CREATE FUNCTION before_review_message() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE q review_queries%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'A message is never changed. Add another reply.'; END IF;
  SELECT * INTO q FROM review_queries WHERE id = NEW.query_id;
  IF q.id IS NULL OR q.company_id <> NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF q.status = 'closed' THEN RAISE EXCEPTION 'This query is closed. Reopen it to reply.'; END IF;
  IF app_user_id() IS NOT NULL THEN NEW.author := app_user_id(); END IF;
  NEW.created_at := now();
  -- A reply from the client answers the query; a reply from the firm puts it back to open.
  UPDATE review_queries SET status = CASE WHEN app_has_role(q.company_id, review_roles()) THEN 'open' ELSE 'answered' END WHERE id = q.id;
  RETURN NEW;
END $$;
CREATE TRIGGER review_messages_before_change BEFORE INSERT OR UPDATE OR DELETE ON review_messages FOR EACH ROW EXECUTE FUNCTION before_review_message();

CREATE FUNCTION before_review_note_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j jsonb := to_jsonb(NEW);
BEGIN
  IF TG_TABLE_NAME = 'review_checklist' THEN
    NEW.done_by := coalesce(app_user_id(), NEW.done_by); NEW.done_at := now();
    IF EXISTS (SELECT 1 FROM review_signoffs WHERE company_id = NEW.company_id AND period_end = NEW.period_end AND withdrawn_at IS NULL) THEN
      RAISE EXCEPTION 'This month is signed off; its checklist no longer changes.';
    END IF;
  ELSE
    NEW.by_user := coalesce(app_user_id(), NEW.by_user); NEW.at := now();
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.company_id <> OLD.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_checklist_before_change BEFORE INSERT OR UPDATE ON review_checklist FOR EACH ROW EXECUTE FUNCTION before_review_note_change();
CREATE TRIGGER review_explained_before_change BEFORE INSERT OR UPDATE ON review_explained FOR EACH ROW EXECUTE FUNCTION before_review_note_change();

CREATE FUNCTION before_review_signoff_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A sign-off is never deleted. Withdraw it with a reason.'; END IF;
  IF app_user_id() IS NOT NULL AND NOT app_has_role(NEW.company_id, signoff_roles()) THEN
    RAISE EXCEPTION 'Only a partner or reviewer signs off a month.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.signed_by := app_user_id(); END IF;
    NEW.signed_at := now(); NEW.withdrawn_by := NULL; NEW.withdrawn_at := NULL; NEW.withdraw_reason := NULL;
    IF NEW.period_end >= current_date THEN RAISE EXCEPTION 'A month is signed off after it has ended.'; END IF;
    IF EXISTS (SELECT 1 FROM review_queries WHERE company_id = NEW.company_id AND period_end = NEW.period_end AND status <> 'closed') THEN
      RAISE EXCEPTION 'Close this month''s queries before signing it off.';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.withdrawn_at IS NOT NULL OR (to_jsonb(NEW) - 'withdrawn_by' - 'withdrawn_at' - 'withdraw_reason') <> (to_jsonb(OLD) - 'withdrawn_by' - 'withdrawn_at' - 'withdraw_reason') THEN
    RAISE EXCEPTION 'A sign-off is never changed. Withdraw it with a reason.';
  END IF;
  IF app_user_id() IS NOT NULL THEN NEW.withdrawn_by := app_user_id(); END IF;
  NEW.withdrawn_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER review_signoffs_before_change BEFORE INSERT OR UPDATE OR DELETE ON review_signoffs FOR EACH ROW EXECUTE FUNCTION before_review_signoff_change();
CREATE TRIGGER review_queries_no_delete BEFORE DELETE ON review_queries FOR EACH ROW EXECUTE FUNCTION forbid_change();

/** Is this person on the firm's side for the company (to show who wrote a message)? Members of the company only. */
CREATE FUNCTION review_from_firm(p_company uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_company = ANY (app_company_ids()) AND EXISTS (SELECT 1 FROM memberships WHERE company_id = p_company AND user_id = p_user AND role = ANY (review_roles()))
$$;
GRANT EXECUTE ON FUNCTION review_from_firm(uuid, uuid) TO nusuh_app;

/** The latest month signed off and still standing, for the client's "reviewed by your accountant" badge. */
CREATE FUNCTION reviewed_up_to(p_company uuid) RETURNS TABLE (period_end date, signed_by text, signed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.period_end, u.full_name, s.signed_at FROM review_signoffs s JOIN users u ON u.id = s.signed_by
  WHERE s.company_id = p_company AND s.withdrawn_at IS NULL AND p_company = ANY (app_company_ids())
  ORDER BY s.period_end DESC LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION reviewed_up_to(uuid) TO nusuh_app;

-- ---------------------------------------------------------------------------
-- Audit and row-level security
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['review_queries', 'review_messages', 'review_checklist', 'review_explained', 'review_signoffs'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nusuh_app', t);
  END LOOP;
END $$;
-- The firm raises queries, ticks the checklist and explains findings; partners and reviewers sign off.
CREATE POLICY review_queries_insert ON review_queries FOR INSERT WITH CHECK (app_has_role(company_id, review_roles()));
CREATE POLICY review_queries_update ON review_queries FOR UPDATE USING (app_has_role(company_id, review_roles())) WITH CHECK (app_has_role(company_id, review_roles()));
-- Anyone on the client replies to a query (client management included: they answer questions too).
CREATE POLICY review_messages_insert ON review_messages FOR INSERT WITH CHECK (company_id = ANY (app_company_ids()));
CREATE POLICY review_checklist_insert ON review_checklist FOR INSERT WITH CHECK (app_has_role(company_id, review_roles()));
CREATE POLICY review_checklist_update ON review_checklist FOR UPDATE USING (app_has_role(company_id, review_roles())) WITH CHECK (app_has_role(company_id, review_roles()));
CREATE POLICY review_explained_insert ON review_explained FOR INSERT WITH CHECK (app_has_role(company_id, review_roles()));
CREATE POLICY review_explained_update ON review_explained FOR UPDATE USING (app_has_role(company_id, review_roles())) WITH CHECK (app_has_role(company_id, review_roles()));
CREATE POLICY review_explained_delete ON review_explained FOR DELETE USING (app_has_role(company_id, review_roles()));
GRANT DELETE ON review_explained TO nusuh_app;
CREATE POLICY review_signoffs_insert ON review_signoffs FOR INSERT WITH CHECK (app_has_role(company_id, signoff_roles()));
CREATE POLICY review_signoffs_update ON review_signoffs FOR UPDATE USING (app_has_role(company_id, signoff_roles())) WITH CHECK (app_has_role(company_id, signoff_roles()));
