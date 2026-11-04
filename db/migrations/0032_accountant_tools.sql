-- 0032 Tools accountants ask for: recurring sales invoices, payment reminders, budgets, notifications read marks.
--
-- recurring_invoices: a customer invoice template (rent, retainers, subscriptions) that makes the next invoice on its
-- date, as a draft or issued and emailed (the server's daily job runs it as the person who set it up).
-- reminder_settings / reminder_log: polite reminders for overdue invoices, by email, at chosen days after the due
-- date; each invoice gets each reminder once.
-- budgets / budget_lines: budget per account (and cost centre) per month, compared with actual.
-- notification_reads: which in-app notifications a person has seen (the notifications themselves are worked out live).

CREATE TABLE recurring_invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  name          text NOT NULL CHECK (btrim(name) <> ''),
  contact_id    uuid NOT NULL REFERENCES contacts(id),
  frequency     text NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  next_date     date NOT NULL,
  anchor_day    smallint NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
  end_date      date,
  terms_days    int NOT NULL DEFAULT 30 CHECK (terms_days BETWEEN 0 AND 365),
  active        boolean NOT NULL DEFAULT true,
  mode          text NOT NULL DEFAULT 'draft' CHECK (mode IN ('draft', 'issue', 'issue_and_email')),
  lines         jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) > 0),
  reference     text,
  notes         text,
  last_problem  text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= next_date OR NOT active)
);
CREATE INDEX recurring_invoices_company ON recurring_invoices (company_id, next_date);
ALTER TABLE documents ADD COLUMN recurring_invoice_id uuid REFERENCES recurring_invoices(id);

CREATE FUNCTION before_recurring_invoice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now();
  ELSIF NEW.company_id <> OLD.company_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'A recurring invoice stays with its company.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND company_id = NEW.company_id AND is_customer) THEN
    RAISE EXCEPTION 'Choose a customer of this company.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recurring_invoices_before_change BEFORE INSERT OR UPDATE ON recurring_invoices FOR EACH ROW EXECUTE FUNCTION before_recurring_invoice();
CREATE TRIGGER recurring_invoices_no_delete BEFORE DELETE ON recurring_invoices FOR EACH ROW EXECUTE FUNCTION forbid_change();

/** For the daily job (nobody signed in): templates due on or before the day, with the person they run as. */
CREATE FUNCTION recurring_invoices_due(p_day date) RETURNS TABLE (id uuid, company_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.company_id, r.created_by FROM recurring_invoices r JOIN companies c ON c.id = r.company_id JOIN users u ON u.id = r.created_by
  WHERE r.active AND r.next_date <= p_day AND (r.end_date IS NULL OR r.next_date <= r.end_date) AND c.status = 'active' AND u.status = 'active'
    AND app_user_id() IS NULL
$$;
CREATE FUNCTION recurring_invoice_note(p_id uuid, p_problem text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE recurring_invoices SET last_problem = p_problem WHERE id = p_id AND app_user_id() IS NULL
$$;

-- ---------------------------------------------------------------------------
-- Payment reminders
-- ---------------------------------------------------------------------------
CREATE TABLE reminder_settings (
  company_id  uuid PRIMARY KEY REFERENCES companies(id),
  auto        boolean NOT NULL DEFAULT false,
  days        int[] NOT NULL DEFAULT '{7,14,30}' CHECK (array_length(days, 1) BETWEEN 1 AND 6),
  message     text,
  enabled_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION before_reminder_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.auto IS DISTINCT FROM OLD.auto) THEN
    NEW.enabled_by := CASE WHEN NEW.auto THEN app_user_id() END;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER reminder_settings_before_change BEFORE INSERT OR UPDATE ON reminder_settings FOR EACH ROW EXECUTE FUNCTION before_reminder_settings();

CREATE TABLE reminder_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  document_id  uuid NOT NULL REFERENCES documents(id),
  level_days   int NOT NULL,                 -- the reminder for N days overdue; 0 = sent by hand
  email_id     uuid REFERENCES email_outbox(id),
  sent_by      uuid REFERENCES users(id),
  sent_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reminder_log_once ON reminder_log (document_id, level_days) WHERE level_days > 0;

/** For the daily job: companies with automatic reminders, and who turned them on. */
CREATE FUNCTION reminders_auto() RETURNS TABLE (company_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.company_id, s.enabled_by FROM reminder_settings s JOIN companies c ON c.id = s.company_id JOIN users u ON u.id = s.enabled_by
  WHERE s.auto AND c.status = 'active' AND u.status = 'active' AND app_user_id() IS NULL
$$;

-- ---------------------------------------------------------------------------
-- Budgets
-- ---------------------------------------------------------------------------
CREATE TABLE budgets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  start_date  date NOT NULL CHECK (extract(day FROM start_date) = 1),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);
CREATE TABLE budget_lines (
  budget_id       uuid NOT NULL REFERENCES budgets(id),
  company_id      uuid NOT NULL REFERENCES companies(id),
  account_id      uuid NOT NULL REFERENCES accounts(id),
  cost_centre_id  uuid REFERENCES cost_centres(id),
  month           smallint NOT NULL CHECK (month BETWEEN 1 AND 12),   -- 1 = the budget's first month
  amount          numeric(18,2) NOT NULL CHECK (amount >= 0)
);
CREATE UNIQUE INDEX budget_lines_key ON budget_lines (budget_id, account_id, coalesce(cost_centre_id, '00000000-0000-0000-0000-000000000000'::uuid), month);

CREATE FUNCTION before_budget_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM budgets WHERE id = NEW.budget_id AND company_id = NEW.company_id)
     OR NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND company_id = NEW.company_id AND type IN ('income', 'expense'))
     OR (NEW.cost_centre_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cost_centres WHERE id = NEW.cost_centre_id AND company_id = NEW.company_id)) THEN
    RAISE EXCEPTION 'A budget line is for an income or expense account of the same company.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER budget_lines_before_change BEFORE INSERT OR UPDATE ON budget_lines FOR EACH ROW EXECUTE FUNCTION before_budget_line();
CREATE FUNCTION before_budget() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  IF TG_OP = 'UPDATE' AND NEW.company_id <> OLD.company_id THEN RAISE EXCEPTION 'A budget stays with its company.'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER budgets_before_change BEFORE INSERT OR UPDATE ON budgets FOR EACH ROW EXECUTE FUNCTION before_budget();

-- ---------------------------------------------------------------------------
-- Notifications read
-- ---------------------------------------------------------------------------
CREATE TABLE notification_reads (
  user_id   uuid NOT NULL REFERENCES users(id),
  key       text NOT NULL,
  read_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_reads_own ON notification_reads USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_reads TO nusuh_app;

-- ---------------------------------------------------------------------------
-- Access and audit
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['recurring_invoices', 'reminder_settings', 'reminder_log', 'budgets', 'budget_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_update', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nusuh_app', t);
  END LOOP;
END $$;
CREATE POLICY budget_lines_delete ON budget_lines FOR DELETE USING (app_has_role(company_id, posting_roles()));
GRANT DELETE ON budget_lines TO nusuh_app;
REVOKE ALL ON FUNCTION recurring_invoices_due(date), recurring_invoice_note(uuid, text), reminders_auto() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recurring_invoices_due(date), recurring_invoice_note(uuid, text), reminders_auto() TO nusuh_app;
