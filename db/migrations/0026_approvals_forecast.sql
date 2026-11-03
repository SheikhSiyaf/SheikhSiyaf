-- 0026: Approvals (beyond employee claims) and the cash flow forecast.
--   Approvals: per company, bills, supplier payments and customer credit notes at or above an amount need
--   approval before they are issued or paid. A request locks the draft; someone other than the requester with
--   the right to approve (firm partner or reviewer, or a client role with "approve") approves or rejects it; the
--   database refuses to issue or pay without an approved request. Expenses are recorded after the money is spent
--   and are not part of this (claims keep their own approval).
--   Forecast: the books give most of it (src/books/forecast.ts); people add the items the books cannot know.

CREATE FUNCTION app_can_approve(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_has_role(p_company, ARRAY['partner', 'reviewer']::user_role[]) OR EXISTS (
    SELECT 1 FROM memberships m JOIN client_roles r ON r.id = m.client_role_id
    WHERE m.user_id = app_user_id() AND m.company_id = p_company AND r.can_approve AND r.status = 'active')
$$;
GRANT EXECUTE ON FUNCTION app_can_approve(uuid) TO nusuh_app;

CREATE TABLE approval_rules (
  company_id uuid NOT NULL REFERENCES companies(id),
  kind       text NOT NULL CHECK (kind IN ('bill', 'payment', 'credit_note')),
  threshold  numeric(18,2) NOT NULL CHECK (threshold >= 0),
  active     boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, kind)
);

CREATE TABLE approval_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  kind         text NOT NULL CHECK (kind IN ('bill', 'payment', 'credit_note')),
  document_id  uuid REFERENCES documents(id) ON DELETE CASCADE,   -- a draft deleted after a rejected or withdrawn request
  payment      jsonb,      -- a supplier payment waiting for approval: what will be recorded once approved
  contact_id   uuid NOT NULL REFERENCES contacts(id),
  amount       numeric(18,2) NOT NULL CHECK (amount > 0),
  note         text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'done')),
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by   uuid REFERENCES users(id),
  decided_at   timestamptz,
  reason       text,
  payment_id   uuid REFERENCES payments(id),
  done_at      timestamptz,
  CHECK ((kind = 'payment') = (payment IS NOT NULL AND document_id IS NULL)),
  CHECK (status <> 'rejected' OR btrim(coalesce(reason, '')) <> '')
);
CREATE UNIQUE INDEX approval_requests_open_document ON approval_requests (document_id) WHERE status IN ('pending', 'approved');
CREATE INDEX approval_requests_company ON approval_requests (company_id, status, requested_at);

ALTER TABLE payments ADD COLUMN approval_request_id uuid REFERENCES approval_requests(id);

/** Does this amount of this kind need approval in the company? */
CREATE FUNCTION approval_needed(p_company uuid, p_kind text, p_amount numeric) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM approval_rules WHERE company_id = p_company AND kind = p_kind AND active AND p_amount >= threshold)
$$;
GRANT EXECUTE ON FUNCTION approval_needed(uuid, text, numeric) TO nusuh_app;

CREATE FUNCTION before_approval_request_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d documents%ROWTYPE; who uuid := app_user_id();
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only when its draft is deleted (the audit log keeps the history), and never while it is open.
    IF pg_trigger_depth() > 1 AND OLD.status IN ('withdrawn', 'rejected') THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'An approval request is never deleted. Withdraw it instead.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.requested_by := coalesce(who, NEW.requested_by); NEW.requested_at := now();
    NEW.status := 'pending'; NEW.decided_by := NULL; NEW.decided_at := NULL; NEW.reason := NULL; NEW.payment_id := NULL; NEW.done_at := NULL;
    IF NEW.document_id IS NOT NULL THEN
      SELECT * INTO d FROM documents WHERE id = NEW.document_id;
      IF d.id IS NULL OR d.company_id <> NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
      IF d.status <> 'draft' OR d.type::text <> NEW.kind THEN RAISE EXCEPTION 'Only drafts are sent for approval.'; END IF;
      NEW.amount := d.gross_total; NEW.contact_id := d.contact_id;
    ELSIF NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND company_id = NEW.company_id) THEN
      RAISE EXCEPTION 'That belongs to a different company.';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.company_id, NEW.kind, NEW.document_id, NEW.payment, NEW.contact_id, NEW.amount, NEW.requested_by, NEW.requested_at)
     IS DISTINCT FROM (OLD.company_id, OLD.kind, OLD.document_id, OLD.payment, OLD.contact_id, OLD.amount, OLD.requested_by, OLD.requested_at) THEN
    RAISE EXCEPTION 'An approval request is not changed. Withdraw it and send a new one.';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') THEN
    IF who IS NOT NULL AND who = OLD.requested_by THEN RAISE EXCEPTION 'You sent this for approval, so someone else must approve or reject it.'; END IF;
    IF who IS NOT NULL AND NOT app_can_approve(NEW.company_id) THEN RAISE EXCEPTION 'Your role does not allow approving.'; END IF;
    IF NEW.status = 'rejected' AND btrim(coalesce(NEW.reason, '')) = '' THEN RAISE EXCEPTION 'Give a reason for rejecting.'; END IF;
    NEW.decided_by := who; NEW.decided_at := now();
  ELSIF OLD.status IN ('pending', 'approved') AND NEW.status = 'withdrawn' THEN
    IF who IS NOT NULL AND who <> OLD.requested_by AND NOT app_can_approve(NEW.company_id) THEN RAISE EXCEPTION 'Only the person who sent it, or an approver, withdraws it.'; END IF;
  ELSIF OLD.status = 'approved' AND NEW.status = 'done' AND pg_trigger_depth() > 1 THEN
    NEW.done_at := now();   -- set when the document is issued or the payment recorded (below)
  ELSE
    RAISE EXCEPTION 'An approval request cannot move from % to %.', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_requests_before_change BEFORE INSERT OR UPDATE OR DELETE ON approval_requests FOR EACH ROW EXECUTE FUNCTION before_approval_request_change();

-- A document waiting for approval (or approved, not yet issued) is locked; issuing needs the approval when the rule asks.
CREATE FUNCTION approval_guard_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r approval_requests%ROWTYPE; d documents%ROWTYPE;
BEGIN
  d := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  SELECT * INTO r FROM approval_requests WHERE document_id = d.id AND status IN ('pending', 'approved');
  IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'issued' THEN
    IF NEW.type::text IN ('bill', 'credit_note') AND approval_needed(NEW.company_id, NEW.type::text, NEW.gross_total) AND r.status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'This needs approval before it is issued.';
    END IF;
    IF r.status = 'pending' THEN RAISE EXCEPTION 'This is waiting for approval.'; END IF;
    RETURN NEW;
  END IF;
  IF r.id IS NOT NULL THEN RAISE EXCEPTION 'This is waiting for approval. Withdraw the request to change it.'; END IF;
  RETURN d;
END $$;
CREATE TRIGGER documents_approval_guard BEFORE UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION approval_guard_document();

CREATE FUNCTION approval_guard_lines() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE doc uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
BEGIN
  IF EXISTS (SELECT 1 FROM approval_requests WHERE document_id = doc AND status IN ('pending', 'approved')) THEN
    RAISE EXCEPTION 'This is waiting for approval. Withdraw the request to change it.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER document_lines_approval_guard BEFORE INSERT OR UPDATE OR DELETE ON document_lines FOR EACH ROW EXECUTE FUNCTION approval_guard_lines();

CREATE FUNCTION after_document_issued_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'issued' THEN
    UPDATE approval_requests SET status = 'done' WHERE document_id = NEW.id AND status = 'approved';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER documents_approval_done AFTER UPDATE OF status ON documents FOR EACH ROW EXECUTE FUNCTION after_document_issued_approval();

-- Supplier payments at or above the threshold need an approved request for the same supplier and amount.
CREATE FUNCTION approval_guard_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r approval_requests%ROWTYPE;
BEGIN
  IF NEW.direction <> 'made' THEN NEW.approval_request_id := NULL; RETURN NEW; END IF;
  IF NEW.approval_request_id IS NOT NULL THEN
    SELECT * INTO r FROM approval_requests WHERE id = NEW.approval_request_id FOR UPDATE;
    IF r.id IS NULL OR r.company_id <> NEW.company_id OR r.kind <> 'payment' THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
    IF r.status <> 'approved' THEN RAISE EXCEPTION 'This payment is not approved.'; END IF;
    IF r.contact_id <> NEW.contact_id OR r.amount <> NEW.amount THEN RAISE EXCEPTION 'The payment is not the one that was approved (supplier or amount).'; END IF;
  ELSIF approval_needed(NEW.company_id, 'payment', NEW.amount) THEN
    RAISE EXCEPTION 'This payment needs approval before it is made.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_approval_guard BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION approval_guard_payment();

CREATE FUNCTION after_payment_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.approval_request_id IS NOT NULL THEN
    UPDATE approval_requests SET status = 'done', payment_id = NEW.id WHERE id = NEW.approval_request_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER payments_approval_done AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION after_payment_approval();

CREATE FUNCTION before_approval_rule_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.updated_by := coalesce(app_user_id(), NEW.updated_by); NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER approval_rules_before_change BEFORE INSERT OR UPDATE ON approval_rules FOR EACH ROW EXECUTE FUNCTION before_approval_rule_change();

-- ---------------------------------------------------------------------------
-- Cash flow forecast: items the books cannot know, and the cash the company wants to keep.
-- ---------------------------------------------------------------------------
CREATE TABLE forecast_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  description text NOT NULL CHECK (btrim(description) <> '' AND length(description) <= 160),
  direction   text NOT NULL CHECK (direction IN ('in', 'out')),
  amount      numeric(18,2) NOT NULL CHECK (amount > 0),
  first_date  date NOT NULL,
  repeat      text NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'weekly', 'monthly', 'quarterly', 'yearly')),
  end_date    date,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= first_date)
);
CREATE INDEX forecast_items_company ON forecast_items (company_id);

CREATE TABLE forecast_settings (
  company_id   uuid PRIMARY KEY REFERENCES companies(id),
  minimum_cash numeric(18,2) NOT NULL DEFAULT 0 CHECK (minimum_cash >= 0),
  updated_by   uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION before_forecast_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.company_id <> OLD.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF TG_TABLE_NAME = 'forecast_items' THEN
    IF TG_OP = 'INSERT' THEN NEW.created_by := coalesce(app_user_id(), NEW.created_by); NEW.created_at := now();
    ELSIF NEW.created_by <> OLD.created_by THEN RAISE EXCEPTION 'Who added an item is kept.'; END IF;
  ELSE
    NEW.updated_by := coalesce(app_user_id(), NEW.updated_by); NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER forecast_items_before_change BEFORE INSERT OR UPDATE ON forecast_items FOR EACH ROW EXECUTE FUNCTION before_forecast_change();
CREATE TRIGGER forecast_items_no_delete BEFORE DELETE ON forecast_items FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER forecast_settings_before_change BEFORE INSERT OR UPDATE ON forecast_settings FOR EACH ROW EXECUTE FUNCTION before_forecast_change();

-- ---------------------------------------------------------------------------
-- Audit and row-level security
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['approval_rules', 'approval_requests', 'forecast_items', 'forecast_settings'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nusuh_app', t);
  END LOOP;
END $$;
-- Rules: the firm's partner or reviewer, or an approver (they decide what needs approval).
CREATE POLICY approval_rules_insert ON approval_rules FOR INSERT WITH CHECK (app_can_approve(company_id));
CREATE POLICY approval_rules_update ON approval_rules FOR UPDATE USING (app_can_approve(company_id)) WITH CHECK (app_can_approve(company_id));
-- Requests: those who post send them; approvers decide; the sender or an approver withdraws (checked in the trigger).
CREATE POLICY approval_requests_insert ON approval_requests FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY approval_requests_update ON approval_requests FOR UPDATE USING (app_has_role(company_id, posting_roles()) OR app_can_approve(company_id))
  WITH CHECK (company_id = ANY (app_company_ids()));
-- Forecast: those who post keep it.
CREATE POLICY forecast_items_insert ON forecast_items FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY forecast_items_update ON forecast_items FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY forecast_settings_insert ON forecast_settings FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY forecast_settings_update ON forecast_settings FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));
