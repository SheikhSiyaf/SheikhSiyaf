-- 0020: Light CRM: leads, deals (pipeline), activities and campaigns. Nothing here posts to the ledger.
--   * A lead is a possible customer. Converting it creates (or links) a customer contact.
--   * A deal moves through stages new -> qualified -> proposal -> negotiation -> won / lost. It can link one Sales
--     quotation: when that quotation is invoiced the deal is won; when it is declined the deal is lost.
--   * Activities (calls, meetings, tasks, emails, notes) belong to a lead, a deal or a customer, with a due date.
--   * Campaigns group leads by where they came from; their results are counted from those leads and deals.
--   * Everything carries company_id, is audited and separated by row-level security; only people who can
--     post may change it. People assigned (owners) must be members of the company.

CREATE TABLE crm_campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  channel     text NOT NULL DEFAULT 'other' CHECK (channel IN ('email', 'sms', 'whatsapp', 'social', 'event', 'print', 'other')),
  start_date  date,
  end_date    date,
  budget      numeric(18,2) NOT NULL DEFAULT 0 CHECK (budget >= 0),
  status      text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'running', 'done')),
  audience    text,
  notes       text,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE UNIQUE INDEX crm_campaigns_name ON crm_campaigns (company_id, lower(btrim(name)));

CREATE TABLE crm_leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  name            text NOT NULL CHECK (btrim(name) <> ''),
  name_ar         text,
  contact_person  text,
  phone           text,
  email           text,
  source          text NOT NULL DEFAULT 'other' CHECK (source IN ('referral', 'website', 'walk_in', 'phone', 'social', 'exhibition', 'campaign', 'other')),
  campaign_id     uuid REFERENCES crm_campaigns(id),
  owner_id        uuid REFERENCES users(id),
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'lost')),
  estimated_value numeric(18,2) NOT NULL DEFAULT 0 CHECK (estimated_value >= 0),
  notes           text,
  lost_reason     text,
  contact_id      uuid REFERENCES contacts(id),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'converted') = (contact_id IS NOT NULL)),
  CHECK (status <> 'lost' OR btrim(coalesce(lost_reason, '')) <> '')
);
CREATE INDEX crm_leads_company ON crm_leads (company_id, status);

CREATE TABLE crm_deals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  title          text NOT NULL CHECK (btrim(title) <> ''),
  contact_id     uuid REFERENCES contacts(id),
  lead_id        uuid REFERENCES crm_leads(id),
  stage          text NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
  value          numeric(18,2) NOT NULL DEFAULT 0 CHECK (value >= 0),
  expected_close date,
  owner_id       uuid REFERENCES users(id),
  quotation_id   uuid UNIQUE REFERENCES documents(id),
  lost_reason    text,
  closed_at      date,
  notes          text,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (contact_id IS NOT NULL OR lead_id IS NOT NULL),
  CHECK ((stage IN ('won', 'lost')) = (closed_at IS NOT NULL)),
  CHECK (stage <> 'lost' OR btrim(coalesce(lost_reason, '')) <> '')
);
CREATE INDEX crm_deals_company ON crm_deals (company_id, stage);

CREATE TABLE crm_activities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  kind        text NOT NULL CHECK (kind IN ('call', 'meeting', 'task', 'email', 'note')),
  subject     text NOT NULL CHECK (btrim(subject) <> ''),
  notes       text,
  due_date    date,
  due_time    text CHECK (due_time IS NULL OR due_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  done_at     timestamptz,
  lead_id     uuid REFERENCES crm_leads(id),
  deal_id     uuid REFERENCES crm_deals(id),
  contact_id  uuid REFERENCES contacts(id),
  owner_id    uuid REFERENCES users(id),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(lead_id, deal_id, contact_id) <= 1)
);
CREATE INDEX crm_activities_due ON crm_activities (company_id, done_at, due_date);

-- ---------------------------------------------------------------------------
-- Rules: everything linked belongs to the same company; owners are members of it.
-- ---------------------------------------------------------------------------
CREATE FUNCTION crm_member(p_company uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_user IS NULL OR EXISTS (SELECT 1 FROM memberships WHERE company_id = p_company AND user_id = p_user)
$$;

/** The people of a company who can be given CRM work: its members (firm staff assigned and client users). Members only. */
CREATE FUNCTION crm_people(p_company uuid) RETURNS TABLE (id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.full_name FROM memberships m JOIN users u ON u.id = m.user_id
  WHERE m.company_id = p_company AND u.status = 'active' AND p_company = ANY (app_company_ids())
  ORDER BY u.full_name
$$;
GRANT EXECUTE ON FUNCTION crm_people(uuid) TO nusuh_app;

CREATE FUNCTION before_crm_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j jsonb := to_jsonb(NEW); c uuid := NEW.company_id;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now();
  ELSIF NEW.company_id <> OLD.company_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  IF (j ? 'owner_id' AND NOT crm_member(c, (j->>'owner_id')::uuid))
     OR (j->>'contact_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts WHERE id = (j->>'contact_id')::uuid AND company_id = c
                                                      AND (TG_TABLE_NAME = 'crm_activities' OR is_customer)))
     OR (j->>'campaign_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm_campaigns WHERE id = (j->>'campaign_id')::uuid AND company_id = c))
     OR (j->>'lead_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm_leads WHERE id = (j->>'lead_id')::uuid AND company_id = c))
     OR (j->>'deal_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm_deals WHERE id = (j->>'deal_id')::uuid AND company_id = c))
     OR (j->>'quotation_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents WHERE id = (j->>'quotation_id')::uuid AND company_id = c AND type = 'quotation'
                                                        AND contact_id IS NOT DISTINCT FROM (j->>'contact_id')::uuid)) THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['crm_campaigns', 'crm_leads', 'crm_deals', 'crm_activities'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION before_crm_change()', t || '_before_change', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_update', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nusuh_app', t);
  END LOOP;
END $$;
-- Leads, deals and campaigns are kept (closed as lost or done); activities can be removed.
CREATE TRIGGER crm_leads_no_delete BEFORE DELETE ON crm_leads FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER crm_deals_no_delete BEFORE DELETE ON crm_deals FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER crm_campaigns_no_delete BEFORE DELETE ON crm_campaigns FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE POLICY crm_activities_delete ON crm_activities FOR DELETE USING (app_has_role(company_id, posting_roles()));
GRANT DELETE ON crm_activities TO nusuh_app;

-- A deal follows its quotation: invoiced = won, declined = lost.
CREATE FUNCTION after_quotation_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.type = 'quotation' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'invoiced' THEN
      UPDATE crm_deals SET stage = 'won', closed_at = current_date, lost_reason = NULL WHERE quotation_id = NEW.id AND stage NOT IN ('won', 'lost');
    ELSIF NEW.status = 'declined' THEN
      UPDATE crm_deals SET stage = 'lost', closed_at = current_date, lost_reason = 'Quotation declined' WHERE quotation_id = NEW.id AND stage NOT IN ('won', 'lost');
    ELSIF NEW.status IN ('sent', 'accepted') THEN
      UPDATE crm_deals SET stage = CASE WHEN NEW.status = 'accepted' THEN 'negotiation' ELSE 'proposal' END
      WHERE quotation_id = NEW.id AND stage IN ('new', 'qualified', 'proposal');
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER documents_quotation_crm AFTER UPDATE OF status ON documents FOR EACH ROW EXECUTE FUNCTION after_quotation_status();
