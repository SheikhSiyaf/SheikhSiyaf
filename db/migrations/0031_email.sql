-- 0031 Sending email, and links that let a customer see an invoice without signing in.
--
-- email_outbox: every email the platform sends (invitations, password resets, invoices and credit notes, statements,
-- reminders, approvals waiting). Rows are queued by people (through queue_email) and sent by the server's job
-- (email_take / email_done, with nobody signed in). Never deleted.
-- document_links: a random link per issued sales document (only its hash is kept) that opens a read-only page of the
-- document, to print or save as PDF and, later, to pay online. Revocable.

CREATE TABLE email_outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid REFERENCES firms(id),
  company_id    uuid REFERENCES companies(id),
  kind          text NOT NULL CHECK (kind IN ('invitation', 'password_reset', 'document', 'statement', 'reminder', 'approval', 'notice')),
  to_email      text NOT NULL CHECK (to_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  to_name       text,
  reply_to      text,
  subject       text NOT NULL CHECK (btrim(subject) <> ''),
  body_text     text NOT NULL,
  body_html     text,
  attachments   jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(attachments) = 'array'),   -- [{fileName, contentType, base64}]
  document_id   uuid REFERENCES documents(id),
  contact_id    uuid REFERENCES contacts(id),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts      int NOT NULL DEFAULT 0,
  last_error    text,
  provider_id   text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  next_try_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_outbox_queue ON email_outbox (status, next_try_at);
CREATE INDEX email_outbox_company ON email_outbox (company_id, created_at DESC);

ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_outbox_read ON email_outbox FOR SELECT
  USING ((company_id IS NOT NULL AND company_id = ANY (app_company_ids())) OR (company_id IS NULL AND app_is_admin() AND firm_id = app_firm_id()));
GRANT SELECT ON email_outbox TO nusuh_app;
-- Not mirrored into the audit log: bodies can hold one-time links (invitations, password resets). The outbox itself
-- records who queued what and when, and links are scrubbed from the stored body once sent (email_done).
CREATE TRIGGER email_outbox_no_delete BEFORE DELETE ON email_outbox FOR EACH ROW EXECUTE FUNCTION forbid_change();

/** Queues an email. Company emails: anyone in the company. Firm emails (invitations): its Administrator or the platform owner.
 *  Nobody signed in: the server itself (password resets). */
CREATE FUNCTION queue_email(p jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cid uuid := nullif(p->>'company_id', '')::uuid; fid uuid := nullif(p->>'firm_id', '')::uuid; nid uuid;
BEGIN
  IF app_user_id() IS NOT NULL THEN
    IF cid IS NOT NULL AND NOT (cid = ANY (app_company_ids())) THEN RAISE EXCEPTION 'Not allowed.'; END IF;
    IF cid IS NULL AND NOT (app_is_admin() OR EXISTS (SELECT 1 FROM users WHERE id = app_user_id() AND kind = 'owner')) THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  END IF;
  IF cid IS NOT NULL THEN fid := (SELECT firm_id FROM companies WHERE id = cid); END IF;
  INSERT INTO email_outbox (firm_id, company_id, kind, to_email, to_name, reply_to, subject, body_text, body_html, attachments, document_id, contact_id, created_by)
  VALUES (fid, cid, p->>'kind', lower(btrim(p->>'to_email')), p->>'to_name', p->>'reply_to', p->>'subject', p->>'body_text', p->>'body_html',
          coalesce(p->'attachments', '[]'), nullif(p->>'document_id', '')::uuid, nullif(p->>'contact_id', '')::uuid, app_user_id())
  RETURNING id INTO nid;
  RETURN nid;
END $$;

/** For the sender job only: the next emails due, marked as being sent. */
CREATE FUNCTION email_take(p_limit int) RETURNS SETOF email_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Only the server sends email.'; END IF;
  RETURN QUERY UPDATE email_outbox SET status = 'sending', attempts = attempts + 1
    WHERE id IN (SELECT id FROM email_outbox WHERE status = 'queued' AND next_try_at <= now() ORDER BY created_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
    RETURNING *;
END $$;

/** For the sender job only: the result. A failure is retried later (1, 5, 30 minutes, then 2 hours), up to 6 times. */
CREATE FUNCTION email_done(p_id uuid, p_ok boolean, p_error text, p_provider_id text, p_hold boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Only the server sends email.'; END IF;
  UPDATE email_outbox SET
    status = CASE WHEN p_ok THEN 'sent' WHEN p_hold THEN 'queued' WHEN attempts >= 6 THEN 'failed' ELSE 'queued' END,
    sent_at = CASE WHEN p_ok THEN now() END, provider_id = p_provider_id, last_error = CASE WHEN p_ok THEN NULL ELSE p_error END,
    body_text = CASE WHEN p_ok THEN regexp_replace(body_text, '/(invite|i)/[A-Za-z0-9_-]+', '/\1/(link sent)', 'g') ELSE body_text END,
    body_html = CASE WHEN p_ok THEN regexp_replace(body_html, '/(invite|i)/[A-Za-z0-9_-]+', '/\1/(link sent)', 'g') ELSE body_html END,
    attempts = CASE WHEN p_hold THEN greatest(attempts - 1, 0) ELSE attempts END,
    next_try_at = now() + CASE WHEN p_hold THEN interval '15 minutes'
                               ELSE (ARRAY[interval '1 minute', interval '5 minutes', interval '30 minutes', interval '2 hours', interval '2 hours', interval '2 hours'])[least(attempts, 6)] END
  WHERE id = p_id;
END $$;

/** A person asks to send a failed email again. */
CREATE FUNCTION email_retry(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE email_outbox SET status = 'queued', attempts = 0, next_try_at = now()
  WHERE id = p_id AND status = 'failed' AND company_id = ANY (app_company_ids());
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found.'; END IF;
END $$;

/** Forgotten password (nobody signed in): a one-hour link for an active person who has a password. Returns who, or nothing. */
CREATE FUNCTION start_password_reset(p_email text, p_token_hash text) RETURNS TABLE (user_id uuid, full_name text, email text, firm_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Sign out first.'; END IF;
  RETURN QUERY UPDATE users u SET invite_token_hash = p_token_hash, invite_expires_at = now() + interval '1 hour'
    WHERE lower(u.email) = lower(btrim(p_email)) AND u.status = 'active' AND u.password_hash IS NOT NULL
    RETURNING u.id, u.full_name, u.email, u.firm_id;
END $$;

/** The people who may approve in a company (not the caller), for telling them something waits. Members only. */
CREATE FUNCTION company_approvers(p_company uuid) RETURNS TABLE (name text, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT u.full_name, u.email FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN client_roles r ON r.id = m.client_role_id
  WHERE m.company_id = p_company AND p_company = ANY (app_company_ids()) AND u.status = 'active' AND u.id <> app_user_id()
    AND (m.role IN ('partner', 'reviewer') OR coalesce(r.can_approve, false))
$$;
REVOKE ALL ON FUNCTION company_approvers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION company_approvers(uuid) TO nusuh_app;

-- ---------------------------------------------------------------------------
-- Document links
-- ---------------------------------------------------------------------------
CREATE TABLE document_links (
  token_hash   text PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id),
  document_id  uuid NOT NULL REFERENCES documents(id),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '180 days',
  revoked_at   timestamptz,
  last_seen_at timestamptz
);
CREATE INDEX document_links_document ON document_links (document_id);
ALTER TABLE document_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_links_read ON document_links FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY document_links_insert ON document_links FOR INSERT WITH CHECK (company_id = ANY (app_company_ids())
  AND EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.company_id = company_id AND d.status <> 'draft' AND d.type IN ('invoice', 'credit_note', 'quotation')));
CREATE POLICY document_links_update ON document_links FOR UPDATE USING (company_id = ANY (app_company_ids())) WITH CHECK (company_id = ANY (app_company_ids()));
GRANT SELECT, INSERT, UPDATE ON document_links TO nusuh_app;
CREATE TRIGGER document_links_audit AFTER INSERT OR UPDATE OR DELETE ON document_links FOR EACH ROW EXECUTE FUNCTION audit_row();

/** Opening a link (nobody signed in): the company and document behind a live link, and the visit is noted. */
CREATE FUNCTION document_link_open(p_token_hash text) RETURNS TABLE (company_id uuid, document_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY UPDATE document_links l SET last_seen_at = now()
    WHERE l.token_hash = p_token_hash AND l.revoked_at IS NULL AND l.expires_at > now()
    RETURNING l.company_id, l.document_id;
END $$;

/** What a customer sees behind a live link: the document, its lines, the seller and buyer, the e-invoice QR and what is still due. */
CREATE FUNCTION document_public(p_token_hash text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', d.id, 'type', d.type, 'status', d.status, 'issuedAt', d.issued_at, 'number', d.number, 'issueDate', d.issue_date, 'dueDate', d.due_date, 'reference', d.reference, 'notes', d.notes,
    'netTotal', d.net_total::text, 'vatTotal', d.vat_total::text, 'grossTotal', d.gross_total::text, 'amountDue', document_amount_due(d.id)::numeric(18,2)::text,
    'seller', jsonb_build_object('name', co.name, 'nameAr', co.name_ar, 'vatNumber', co.vat_number, 'crNumber', co.cr_number, 'address', co.address, 'city', co.city,
       'country', co.country, 'currency', co.currency),
    'buyer', jsonb_build_object('name', c.name, 'nameAr', c.name_ar, 'vatNumber', c.vat_number, 'address', c.address, 'city', c.city),
    'qr', (SELECT e.qr FROM einvoices e WHERE e.document_id = d.id ORDER BY e.created_at DESC LIMIT 1),
    'lines', (SELECT jsonb_agg(jsonb_build_object('description', l.description, 'quantity', l.quantity::text, 'unitPrice', l.unit_price::text, 'vatRate', l.vat_rate::text,
       'netAmount', l.net_amount::text, 'vatAmount', l.vat_amount::text) ORDER BY l.line_no) FROM document_lines l WHERE l.document_id = d.id))
  FROM document_links k JOIN documents d ON d.id = k.document_id JOIN companies co ON co.id = d.company_id JOIN contacts c ON c.id = d.contact_id
  WHERE k.token_hash = p_token_hash AND k.revoked_at IS NULL AND k.expires_at > now()
$$;

REVOKE ALL ON FUNCTION queue_email(jsonb), email_take(int), email_done(uuid, boolean, text, text, boolean), email_retry(uuid), start_password_reset(text, text), document_link_open(text), document_public(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queue_email(jsonb), email_take(int), email_done(uuid, boolean, text, text, boolean), email_retry(uuid), start_password_reset(text, text), document_link_open(text), document_public(text) TO nusuh_app;
