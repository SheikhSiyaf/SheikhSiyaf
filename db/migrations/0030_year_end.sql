-- 0030 Year-end closing.
--
-- Closing a financial year (partner only): one entry on the year end moves every income and expense balance of the
-- year (per cost centre) to 3100 Retained earnings, and every month of the year is locked. A closed year takes no
-- posting and its months cannot be unlocked. Years close in order; reopening (partner) reverses the closing entry and
-- is possible only while the next year is still open.
-- Closing entries (source_type 'year_end_close') are left out of the profit and loss figures, so the year's P&L
-- still shows its result after closing.

CREATE TABLE fiscal_years (
  id               uuid PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES companies(id),
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  status           text NOT NULL DEFAULT 'closed' CHECK (status IN ('closed', 'reopened')),
  profit           numeric(18,2) NOT NULL,
  entry_id         uuid REFERENCES journal_entries(id),     -- empty when the year had no income or expense
  reopen_entry_id  uuid REFERENCES journal_entries(id),
  closed_by        uuid NOT NULL REFERENCES users(id),
  closed_at        timestamptz NOT NULL DEFAULT now(),
  reopened_by      uuid REFERENCES users(id),
  reopened_at      timestamptz,
  reopen_reason    text,
  CHECK (end_date > start_date)
);
CREATE UNIQUE INDEX fiscal_years_closed_once ON fiscal_years (company_id, end_date) WHERE status = 'closed';

CREATE FUNCTION year_is_closed(p_company uuid, p_date date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM fiscal_years WHERE company_id = p_company AND status = 'closed' AND p_date BETWEEN start_date AND end_date)
$$;
GRANT EXECUTE ON FUNCTION year_is_closed(uuid, date) TO nusuh_app;

CREATE FUNCTION before_fiscal_year() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_has_role(NEW.company_id, ARRAY['partner']::user_role[]) THEN
    RAISE EXCEPTION 'Only the Firm partner closes or reopens a year.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.closed_by := app_user_id(); NEW.closed_at := now(); NEW.status := 'closed';
    NEW.reopened_by := NULL; NEW.reopened_at := NULL; NEW.reopen_entry_id := NULL;
    IF NEW.entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = NEW.entry_id AND e.company_id = NEW.company_id
         AND e.source_type = 'year_end_close' AND e.source_id = NEW.id AND e.entry_date = NEW.end_date) THEN
      RAISE EXCEPTION 'A year is closed by its own closing entry on the year end.';
    END IF;
    IF EXISTS (SELECT 1 FROM fiscal_years f WHERE f.company_id = NEW.company_id AND f.status = 'closed' AND f.start_date <= NEW.end_date AND f.end_date >= NEW.start_date) THEN
      RAISE EXCEPTION 'This year is already closed.';
    END IF;
    RETURN NEW;
  END IF;
  -- The reversal of the closing entry is noted once, after the year is reopened.
  IF OLD.status = 'reopened' AND NEW.status = 'reopened' AND OLD.reopen_entry_id IS NULL AND NEW.reopen_entry_id IS NOT NULL
     AND NEW.entry_id IS NOT DISTINCT FROM OLD.entry_id AND NEW.reopen_reason IS NOT DISTINCT FROM OLD.reopen_reason AND NEW.profit = OLD.profit THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'closed' OR NEW.status <> 'reopened' OR NEW.company_id <> OLD.company_id OR NEW.start_date <> OLD.start_date OR NEW.end_date <> OLD.end_date
     OR NEW.entry_id IS DISTINCT FROM OLD.entry_id OR NEW.profit <> OLD.profit THEN
    RAISE EXCEPTION 'A closed year is only reopened.';
  END IF;
  IF EXISTS (SELECT 1 FROM fiscal_years f WHERE f.company_id = NEW.company_id AND f.status = 'closed' AND f.start_date > NEW.end_date) THEN
    RAISE EXCEPTION 'A later year is closed. Reopen it first.';
  END IF;
  IF coalesce(btrim(NEW.reopen_reason), '') = '' THEN RAISE EXCEPTION 'Say why the year is reopened.'; END IF;
  NEW.reopened_by := app_user_id(); NEW.reopened_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER fiscal_years_before_change BEFORE INSERT OR UPDATE ON fiscal_years FOR EACH ROW EXECUTE FUNCTION before_fiscal_year();
CREATE TRIGGER fiscal_years_no_delete BEFORE DELETE ON fiscal_years FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER fiscal_years_audit AFTER INSERT OR UPDATE OR DELETE ON fiscal_years FOR EACH ROW EXECUTE FUNCTION audit_row();
ALTER TABLE fiscal_years ENABLE ROW LEVEL SECURITY;
CREATE POLICY fiscal_years_read ON fiscal_years FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY fiscal_years_insert ON fiscal_years FOR INSERT WITH CHECK (app_has_role(company_id, ARRAY['partner']::user_role[]));
CREATE POLICY fiscal_years_update ON fiscal_years FOR UPDATE USING (app_has_role(company_id, ARRAY['partner']::user_role[]))
  WITH CHECK (app_has_role(company_id, ARRAY['partner']::user_role[]));
GRANT SELECT, INSERT, UPDATE ON fiscal_years TO nusuh_app;

-- A closed year takes no posting (only the reversal of its closing entry while it is being reopened), and its months stay locked.
CREATE FUNCTION before_entry_closed_year() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF year_is_closed(NEW.company_id, NEW.entry_date) THEN
    RAISE EXCEPTION 'This financial year is closed. Choose a date in an open year.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entries_closed_year BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION before_entry_closed_year();

CREATE FUNCTION before_period_closed_year() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.locked_at IS NULL AND OLD.locked_at IS NOT NULL AND year_is_closed(NEW.company_id, NEW.start_date) THEN
    RAISE EXCEPTION 'This month is in a closed year. Reopen the year first.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER periods_closed_year BEFORE UPDATE ON periods FOR EACH ROW EXECUTE FUNCTION before_period_closed_year();

-- Profit and loss leaves out closing entries.
CREATE OR REPLACE FUNCTION profit_and_loss(p_company uuid, p_from date, p_to date)
RETURNS TABLE (income numeric(18,2), expense numeric(18,2), profit numeric(18,2))
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(l.credit - l.debit) FILTER (WHERE a.type = 'income'), 0),
         coalesce(sum(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0),
         coalesce(sum(l.credit - l.debit) FILTER (WHERE a.type IN ('income','expense')), 0)
  FROM journal_lines l
  JOIN journal_entries e ON e.id = l.entry_id
  JOIN accounts a ON a.id = l.account_id
  WHERE e.company_id = p_company AND e.entry_date BETWEEN p_from AND p_to AND e.source_type IS DISTINCT FROM 'year_end_close'
$$;

CREATE OR REPLACE FUNCTION profit_and_loss_by_cost_centre(p_company uuid, p_from date, p_to date)
RETURNS TABLE (cost_centre_id uuid, cost_centre_name text, income numeric(18,2), expense numeric(18,2), profit numeric(18,2))
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT l.cost_centre_id, cc.name,
         coalesce(sum(l.credit - l.debit) FILTER (WHERE a.type = 'income'), 0),
         coalesce(sum(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0),
         coalesce(sum(l.credit - l.debit), 0)
  FROM journal_lines l
  JOIN journal_entries e ON e.id = l.entry_id
  JOIN accounts a ON a.id = l.account_id
  LEFT JOIN cost_centres cc ON cc.id = l.cost_centre_id
  WHERE e.company_id = p_company AND e.entry_date BETWEEN p_from AND p_to
    AND a.type IN ('income','expense') AND e.source_type IS DISTINCT FROM 'year_end_close'
  GROUP BY l.cost_centre_id, cc.name
  ORDER BY cc.name NULLS LAST
$$;
