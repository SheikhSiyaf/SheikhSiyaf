-- 0024: Compliance calendar and client portal.
--   Calendar: the deadlines are worked out from the company and its calendar settings (src/books/compliance.ts);
--   only the settings, the client's own deadlines and which deadlines were done are stored here. Firm staff on
--   the client and anyone who enters (client accountant) keep it; view-only people read it.
--   Portal: the firm asks the client for documents (requests); the client sends documents, with or without a
--   request; the firm marks them dealt with; the firm publishes a monthly report with its commentary, which the
--   client reads. Files are attachments (10 MB, PDF or picture), like everywhere else. Nothing here posts.

CREATE FUNCTION calendar_roles() RETURNS user_role[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['partner', 'reviewer', 'staff_accountant', 'client_accountant']::user_role[]
$$;
GRANT EXECUTE ON FUNCTION calendar_roles() TO nusuh_app;

-- ---------------------------------------------------------------------------
-- Compliance calendar
-- ---------------------------------------------------------------------------
CREATE TABLE compliance_settings (
  company_id            uuid PRIMARY KEY REFERENCES companies(id),
  vat_frequency         text NOT NULL DEFAULT 'quarterly' CHECK (vat_frequency IN ('monthly', 'quarterly')),
  vat_quarter_end_month smallint NOT NULL DEFAULT 3 CHECK (vat_quarter_end_month BETWEEN 1 AND 3),
  zakat                 boolean NOT NULL,
  corporate_tax         boolean NOT NULL,
  payroll               boolean NOT NULL,
  social_insurance      boolean NOT NULL,
  updated_by            uuid REFERENCES users(id),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE compliance_custom (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  title      text NOT NULL CHECK (btrim(title) <> '' AND length(title) <= 120),
  title_ar   text CHECK (length(title_ar) <= 120),
  first_due  date NOT NULL,
  repeat     text NOT NULL CHECK (repeat IN ('none', 'monthly', 'quarterly', 'yearly')),
  notes      text,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compliance_custom_company ON compliance_custom (company_id);

CREATE TABLE compliance_done (
  company_id uuid NOT NULL REFERENCES companies(id),
  key        text NOT NULL CHECK (key ~ '^(vat|si|wps|zakat|ct|cr):\d{4}-\d{2}-\d{2}$' OR key ~ '^(doc|custom):[0-9a-z-]{1,40}:\d{4}-\d{2}-\d{2}$'),
  due_date   date NOT NULL,
  reference  text CHECK (length(reference) <= 80),
  note       text,
  done_by    uuid NOT NULL REFERENCES users(id),
  done_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);

CREATE FUNCTION before_compliance_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND NEW.company_id <> OLD.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF TG_TABLE_NAME = 'compliance_settings' THEN
    NEW.updated_by := coalesce(app_user_id(), NEW.updated_by); NEW.updated_at := now();
  ELSIF TG_TABLE_NAME = 'compliance_custom' THEN
    IF TG_OP = 'INSERT' THEN NEW.created_by := coalesce(app_user_id(), NEW.created_by); NEW.created_at := now();
    ELSIF NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN RAISE EXCEPTION 'Who added a deadline is kept.'; END IF;
  ELSE
    NEW.done_by := coalesce(app_user_id(), NEW.done_by); NEW.done_at := now();
    -- A custom deadline marked done must be this company's.
    IF NEW.key LIKE 'custom:%' AND NOT EXISTS (SELECT 1 FROM compliance_custom WHERE company_id = NEW.company_id AND id::text = split_part(NEW.key, ':', 2)) THEN
      RAISE EXCEPTION 'That belongs to a different company.';
    END IF;
    IF NEW.key LIKE 'doc:%' AND NOT EXISTS (SELECT 1 FROM employee_documents WHERE company_id = NEW.company_id AND id::text = split_part(NEW.key, ':', 2)) THEN
      RAISE EXCEPTION 'That belongs to a different company.';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER compliance_settings_before_change BEFORE INSERT OR UPDATE ON compliance_settings FOR EACH ROW EXECUTE FUNCTION before_compliance_change();
CREATE TRIGGER compliance_custom_before_change BEFORE INSERT OR UPDATE ON compliance_custom FOR EACH ROW EXECUTE FUNCTION before_compliance_change();
CREATE TRIGGER compliance_done_before_change BEFORE INSERT OR UPDATE ON compliance_done FOR EACH ROW EXECUTE FUNCTION before_compliance_change();
CREATE TRIGGER compliance_custom_no_delete BEFORE DELETE ON compliance_custom FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Client portal
-- ---------------------------------------------------------------------------
CREATE TABLE portal_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  title        text NOT NULL CHECK (btrim(title) <> '' AND length(title) <= 160),
  details      text,
  category     text NOT NULL DEFAULT 'other' CHECK (category IN ('bank_statement', 'receipts', 'sales', 'purchases', 'payroll', 'contract', 'tax', 'other')),
  period_end   date CHECK (period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date),
  due_date     date,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'done')),
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  closed_by    uuid REFERENCES users(id),
  closed_at    timestamptz,
  CHECK ((status = 'done') = (closed_at IS NOT NULL))
);
CREATE INDEX portal_requests_company ON portal_requests (company_id, status);

CREATE TABLE portal_uploads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  request_id   uuid REFERENCES portal_requests(id),
  category     text NOT NULL DEFAULT 'other' CHECK (category IN ('bank_statement', 'receipts', 'sales', 'purchases', 'payroll', 'contract', 'tax', 'other')),
  period_end   date CHECK (period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date),
  note         text,
  from_firm    boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'processed')),
  uploaded_by  uuid NOT NULL REFERENCES users(id),
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  processed_by uuid REFERENCES users(id),
  processed_at timestamptz,
  CHECK ((status = 'processed') = (processed_at IS NOT NULL))
);
CREATE INDEX portal_uploads_company ON portal_uploads (company_id, status, uploaded_at);
CREATE INDEX portal_uploads_request ON portal_uploads (request_id);

CREATE TABLE portal_letters (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  period_end   date NOT NULL CHECK (period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date),
  commentary   text NOT NULL CHECK (btrim(commentary) <> ''),
  figures      jsonb NOT NULL,
  published_by uuid NOT NULL REFERENCES users(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  read_by      uuid REFERENCES users(id),
  read_at      timestamptz,
  CHECK ((read_by IS NULL) = (read_at IS NULL))
);
CREATE INDEX portal_letters_company ON portal_letters (company_id, period_end);

ALTER TABLE attachments ADD COLUMN portal_upload_id uuid REFERENCES portal_uploads(id);
ALTER TABLE attachments DROP CONSTRAINT attachments_belongs_to_one;
ALTER TABLE attachments ADD CONSTRAINT attachments_belongs_to_one CHECK (num_nonnulls(document_id, stock_note_id, employee_document_id, portal_upload_id) = 1);
CREATE INDEX attachments_portal_upload ON attachments (portal_upload_id);

/** Is the signed-in person on the firm's side for this company (partner, reviewer, staff accountant)? */
CREATE FUNCTION portal_is_firm(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT app_has_role(p_company, review_roles()) $$;
GRANT EXECUTE ON FUNCTION portal_is_firm(uuid) TO nusuh_app;

CREATE FUNCTION before_portal_request_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.requested_by := app_user_id(); END IF;
    NEW.requested_at := now(); NEW.status := 'open'; NEW.closed_by := NULL; NEW.closed_at := NULL;
    RETURN NEW;
  END IF;
  IF (NEW.company_id, NEW.requested_by, NEW.requested_at) IS DISTINCT FROM (OLD.company_id, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'Who asked, and when, is kept.';
  END IF;
  -- A client's answer moves it to answered (set by the upload trigger, which runs as the definer).
  IF NEW.status = 'done' AND OLD.status <> 'done' THEN NEW.closed_by := app_user_id(); NEW.closed_at := now(); END IF;
  IF NEW.status <> 'done' THEN NEW.closed_by := NULL; NEW.closed_at := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_requests_before_change BEFORE INSERT OR UPDATE ON portal_requests FOR EACH ROW EXECUTE FUNCTION before_portal_request_change();
CREATE TRIGGER portal_requests_no_delete BEFORE DELETE ON portal_requests FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION before_portal_upload_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r portal_requests%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'processed' AND NOT OLD.from_firm THEN RAISE EXCEPTION 'Your accountant has dealt with these documents; they are kept.'; END IF;
    DELETE FROM attachments WHERE portal_upload_id = OLD.id;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.uploaded_by := app_user_id(); END IF;
    NEW.uploaded_at := now();
    NEW.from_firm := portal_is_firm(NEW.company_id);
    -- What the firm shares needs no action; what the client sends waits for the firm.
    IF NEW.from_firm THEN NEW.status := 'processed'; NEW.processed_by := NEW.uploaded_by; NEW.processed_at := now();
    ELSE NEW.status := 'new'; NEW.processed_by := NULL; NEW.processed_at := NULL; END IF;
    IF NEW.request_id IS NOT NULL THEN
      SELECT * INTO r FROM portal_requests WHERE id = NEW.request_id;
      IF r.id IS NULL OR r.company_id <> NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
      IF r.status = 'done' THEN RAISE EXCEPTION 'This request is already dealt with.'; END IF;
      IF NOT NEW.from_firm THEN UPDATE portal_requests SET status = 'answered' WHERE id = r.id; END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- Only the status changes after sending: the firm marks it dealt with (or not yet).
  IF (to_jsonb(NEW) - 'status' - 'processed_by' - 'processed_at') <> (to_jsonb(OLD) - 'status' - 'processed_by' - 'processed_at') THEN
    RAISE EXCEPTION 'Sent documents are not changed. Send them again instead.';
  END IF;
  IF NEW.status = 'processed' AND OLD.status <> 'processed' THEN NEW.processed_by := app_user_id(); NEW.processed_at := now(); END IF;
  IF NEW.status = 'new' THEN NEW.processed_by := NULL; NEW.processed_at := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_uploads_before_change BEFORE INSERT OR UPDATE OR DELETE ON portal_uploads FOR EACH ROW EXECUTE FUNCTION before_portal_upload_change();

CREATE FUNCTION before_portal_letter_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.published_by := app_user_id(); END IF;
    NEW.published_at := now(); NEW.read_by := NULL; NEW.read_at := NULL;
    IF NEW.period_end >= current_date THEN RAISE EXCEPTION 'A monthly report is published after the month has ended.'; END IF;
    RETURN NEW;
  END IF;
  -- A published report is never changed (publish another to correct it); the client marks it read once.
  IF (to_jsonb(NEW) - 'read_by' - 'read_at') <> (to_jsonb(OLD) - 'read_by' - 'read_at') OR OLD.read_at IS NOT NULL THEN
    RAISE EXCEPTION 'A published report is not changed. Publish a new one instead.';
  END IF;
  NEW.read_by := app_user_id(); NEW.read_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER portal_letters_before_change BEFORE INSERT OR UPDATE ON portal_letters FOR EACH ROW EXECUTE FUNCTION before_portal_letter_change();
CREATE TRIGGER portal_letters_no_delete BEFORE DELETE ON portal_letters FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Attachments can belong to a portal upload. Only the person who sent it adds files to it; they can be removed
-- while the firm has not dealt with it (always, for what the firm shared).
CREATE OR REPLACE FUNCTION before_attachment_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a attachments%ROWTYPE; draft boolean; u portal_uploads%ROWTYPE;
BEGIN
  a := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF a.portal_upload_id IS NOT NULL THEN SELECT * INTO u FROM portal_uploads WHERE id = a.portal_upload_id; END IF;
  draft := coalesce((SELECT status = 'draft' FROM documents WHERE id = a.document_id),
                    (SELECT status = 'draft' FROM stock_notes WHERE id = a.stock_note_id),
                    CASE WHEN a.employee_document_id IS NOT NULL THEN true END,
                    CASE WHEN u.id IS NOT NULL THEN u.status = 'new' OR u.from_firm END);
  IF TG_OP = 'DELETE' THEN
    IF NOT draft THEN RAISE EXCEPTION 'Attachments of an issued document are kept. They can be added to, not removed.'; END IF;
    DELETE FROM attachment_files WHERE attachment_id = OLD.id;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'An attachment is never changed. Add a new one instead.'; END IF;
  IF app_user_id() IS NOT NULL THEN NEW.uploaded_by := app_user_id(); END IF;
  NEW.uploaded_at := now();
  IF (NEW.document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND company_id = NEW.company_id))
     OR (NEW.stock_note_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stock_notes WHERE id = NEW.stock_note_id AND company_id = NEW.company_id))
     OR (NEW.employee_document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employee_documents WHERE id = NEW.employee_document_id AND company_id = NEW.company_id))
     OR (NEW.portal_upload_id IS NOT NULL AND u.company_id IS DISTINCT FROM NEW.company_id) THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  IF NEW.portal_upload_id IS NOT NULL THEN
    IF u.uploaded_by <> NEW.uploaded_by THEN RAISE EXCEPTION 'Only the person who sent these documents adds files to them.'; END IF;
    IF u.status = 'processed' AND NOT u.from_firm THEN RAISE EXCEPTION 'Your accountant has dealt with these documents. Send new ones instead.'; END IF;
  END IF;
  RETURN NEW;
END $$;

-- The firm's view across its clients: new documents and requests waiting.
CREATE FUNCTION portal_my_clients() RETURNS TABLE (company_id uuid, new_uploads int, open_requests int, answered_requests int, unread_letters int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c, (SELECT count(*) FROM portal_uploads WHERE company_id = c AND status = 'new')::int,
            (SELECT count(*) FROM portal_requests WHERE company_id = c AND status = 'open')::int,
            (SELECT count(*) FROM portal_requests WHERE company_id = c AND status = 'answered')::int,
            (SELECT count(*) FROM portal_letters WHERE company_id = c AND read_at IS NULL)::int
  FROM unnest(app_company_ids()) c
$$;
GRANT EXECUTE ON FUNCTION portal_my_clients() TO nusuh_app;

-- ---------------------------------------------------------------------------
-- Audit and row-level security
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['compliance_settings', 'compliance_custom', 'compliance_done', 'portal_requests', 'portal_uploads', 'portal_letters'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nusuh_app', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['compliance_settings', 'compliance_custom', 'compliance_done'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_has_role(company_id, calendar_roles()))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_has_role(company_id, calendar_roles())) WITH CHECK (app_has_role(company_id, calendar_roles()))', t || '_update', t);
  END LOOP;
END $$;
CREATE POLICY compliance_done_delete ON compliance_done FOR DELETE USING (app_has_role(company_id, calendar_roles()));
GRANT DELETE ON compliance_done TO nusuh_app;

-- The firm asks and closes; anyone on the client sends documents; the firm marks them dealt with.
CREATE POLICY portal_requests_insert ON portal_requests FOR INSERT WITH CHECK (portal_is_firm(company_id));
CREATE POLICY portal_requests_update ON portal_requests FOR UPDATE USING (portal_is_firm(company_id)) WITH CHECK (portal_is_firm(company_id));
CREATE POLICY portal_uploads_insert ON portal_uploads FOR INSERT WITH CHECK (company_id = ANY (app_company_ids()));
CREATE POLICY portal_uploads_update ON portal_uploads FOR UPDATE USING (portal_is_firm(company_id)) WITH CHECK (portal_is_firm(company_id));
CREATE POLICY portal_uploads_delete ON portal_uploads FOR DELETE USING (company_id = ANY (app_company_ids()) AND uploaded_by = app_user_id());
GRANT DELETE ON portal_uploads TO nusuh_app;
CREATE POLICY portal_letters_insert ON portal_letters FOR INSERT WITH CHECK (portal_is_firm(company_id));
CREATE POLICY portal_letters_update ON portal_letters FOR UPDATE USING (company_id = ANY (app_company_ids()) AND NOT portal_is_firm(company_id))
  WITH CHECK (company_id = ANY (app_company_ids()));

-- Files of a portal upload: added and removed by the person who sent it, whatever their role.
CREATE POLICY attachments_portal_insert ON attachments FOR INSERT
  WITH CHECK (portal_upload_id IS NOT NULL AND EXISTS (SELECT 1 FROM portal_uploads u WHERE u.id = portal_upload_id AND u.uploaded_by = app_user_id()));
CREATE POLICY attachments_portal_delete ON attachments FOR DELETE
  USING (portal_upload_id IS NOT NULL AND EXISTS (SELECT 1 FROM portal_uploads u WHERE u.id = portal_upload_id AND u.uploaded_by = app_user_id()));
CREATE POLICY attachment_files_portal_insert ON attachment_files FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM attachments a JOIN portal_uploads u ON u.id = a.portal_upload_id WHERE a.id = attachment_id AND u.uploaded_by = app_user_id()));
