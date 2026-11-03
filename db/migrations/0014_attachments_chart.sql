-- 0014: Attachments (the supplier's bill, receipts, delivery notes) and rules for adding ledger accounts.
--   * An attachment belongs to one document (bill, expense, claim, invoice...) or one goods note. Its details are
--     in `attachments` (audited); the file itself is in `attachment_files`, kept apart so the audit log never
--     copies file contents. PDF and images only, up to 10 MB. Once the document is issued or posted its
--     attachments stay: they can be added to, never removed.
--   * Ledger accounts: the code has 4 digits and its first digit matches the type (1 asset, 2 liability,
--     3 equity, 4 income, 5-9 expense). Once an account has postings its code and type never change.

CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  document_id   uuid REFERENCES documents(id),
  stock_note_id uuid REFERENCES stock_notes(id),
  file_name     text NOT NULL CHECK (btrim(file_name) <> '' AND length(file_name) <= 200),
  content_type  text NOT NULL CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  size_bytes    int NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  uploaded_by   uuid NOT NULL REFERENCES users(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(document_id, stock_note_id) = 1)
);
CREATE INDEX attachments_document ON attachments (document_id);
CREATE INDEX attachments_stock_note ON attachments (stock_note_id);

CREATE TABLE attachment_files (
  attachment_id uuid PRIMARY KEY REFERENCES attachments(id),
  company_id    uuid NOT NULL REFERENCES companies(id),
  data          bytea NOT NULL
);

CREATE FUNCTION before_attachment_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a attachments%ROWTYPE; draft boolean;
BEGIN
  a := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  draft := coalesce((SELECT status = 'draft' FROM documents WHERE id = a.document_id),
                    (SELECT status = 'draft' FROM stock_notes WHERE id = a.stock_note_id));
  IF TG_OP = 'DELETE' THEN
    IF NOT draft THEN RAISE EXCEPTION 'Attachments of an issued document are kept. They can be added to, not removed.'; END IF;
    DELETE FROM attachment_files WHERE attachment_id = OLD.id;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'An attachment is never changed. Add a new one instead.'; END IF;
  IF app_user_id() IS NOT NULL THEN NEW.uploaded_by := app_user_id(); END IF;
  NEW.uploaded_at := now();
  IF (NEW.document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND company_id = NEW.company_id))
     OR (NEW.stock_note_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stock_notes WHERE id = NEW.stock_note_id AND company_id = NEW.company_id)) THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachments_before_change BEFORE INSERT OR UPDATE OR DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION before_attachment_change();
CREATE TRIGGER attachments_audit AFTER INSERT OR UPDATE OR DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION audit_row();

CREATE FUNCTION before_attachment_file_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'An attachment is never changed. Add a new one instead.'; END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM attachments WHERE id = OLD.attachment_id) AND pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'Remove the attachment, not only its file.';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM attachments WHERE id = NEW.attachment_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachment_files_before_change BEFORE INSERT OR UPDATE OR DELETE ON attachment_files FOR EACH ROW EXECUTE FUNCTION before_attachment_file_change();

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY attachments_read ON attachments FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY attachments_insert ON attachments FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY attachments_delete ON attachments FOR DELETE USING (app_has_role(company_id, posting_roles()));
CREATE POLICY attachment_files_read ON attachment_files FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY attachment_files_insert ON attachment_files FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
GRANT SELECT, INSERT, DELETE ON attachments TO nusuh_app;
GRANT SELECT, INSERT ON attachment_files TO nusuh_app;

-- ---------------------------------------------------------------------------
-- Ledger accounts: code matches type; code and type fixed once used
-- ---------------------------------------------------------------------------
CREATE FUNCTION before_account_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE allowed text[];
BEGIN
  allowed := CASE NEW.type WHEN 'asset' THEN ARRAY['1'] WHEN 'liability' THEN ARRAY['2'] WHEN 'equity' THEN ARRAY['3']
                           WHEN 'income' THEN ARRAY['4'] ELSE ARRAY['5', '6', '7', '8', '9'] END;
  IF NEW.code !~ '^[1-9][0-9]{3}$' OR NOT (left(NEW.code, 1) = ANY (allowed)) THEN
    RAISE EXCEPTION 'Account codes have 4 digits starting with 1 (assets), 2 (liabilities), 3 (equity), 4 (income) or 5-9 (expenses).';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.code <> OLD.code OR NEW.type <> OLD.type OR NEW.company_id <> OLD.company_id)
     AND EXISTS (SELECT 1 FROM journal_lines WHERE account_id = OLD.id) THEN
    RAISE EXCEPTION 'This account has postings, so its code and type can no longer change.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_before_change BEFORE INSERT OR UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION before_account_change();
