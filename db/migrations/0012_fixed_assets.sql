-- 0012: Fixed asset register with monthly straight-line depreciation (PRODUCT_SPEC) and disposals.
--   * The register is a sub-ledger: the purchase is recorded as usual (bill, expense or journal) on the asset's
--     cost account; the register then depreciates it and records its disposal.
--   * Depreciation is calculated, not typed: by the end of month n of its life an asset has been depreciated
--     round((cost - residual value) x n / life in months, 2), and all of it from the last month of its life.
--     A month's depreciation is that target minus what was already booked (including any opening amount
--     from before Nusuh Books), so a missed month is caught up and the total never exceeds cost - residual.
--   * Depreciation runs month by month, in order, one run per month per company, each with one journal entry:
--     Dr depreciation expense (with the asset's cost centre) / Cr 1590 Accumulated depreciation.
--   * Disposal: Dr 1590 (all accumulated), Dr bank (proceeds), Cr cost account (cost), gain or loss to 4900.
--     Depreciation must be up to date to the month before the disposal. A disposed asset never changes.

INSERT INTO accounts (company_id, code, name, name_ar, type)
SELECT c.id, v.code, v.name, v.name_ar, v.type::account_type
FROM companies c CROSS JOIN (VALUES
  ('1510', 'Vehicles', 'المركبات', 'asset'),
  ('1520', 'Furniture and fixtures', 'الأثاث والتجهيزات', 'asset'),
  ('1530', 'Computers and IT equipment', 'أجهزة الحاسب وتقنية المعلومات', 'asset'),
  ('1590', 'Accumulated depreciation', 'مجمع الإهلاك', 'asset'),
  ('4900', 'Gain or loss on sale of assets', 'أرباح أو خسائر بيع الأصول', 'income'),
  ('5050', 'Depreciation', 'مصروف الإهلاك', 'expense')) v(code, name, name_ar, type)
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id)
ON CONFLICT (company_id, code) DO NOTHING;

CREATE TABLE fixed_assets (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id),
  number                 text NOT NULL,
  name                   text NOT NULL CHECK (btrim(name) <> ''),
  name_ar                text,
  asset_account_id       uuid NOT NULL REFERENCES accounts(id),
  expense_account_id     uuid NOT NULL REFERENCES accounts(id),
  cost_centre_id         uuid REFERENCES cost_centres(id),
  contact_id             uuid REFERENCES contacts(id),
  purchase_date          date NOT NULL,
  depreciation_start     date NOT NULL CHECK (extract(day FROM depreciation_start) = 1),
  cost                   numeric(18,2) NOT NULL CHECK (cost > 0),
  residual_value         numeric(18,2) NOT NULL DEFAULT 0 CHECK (residual_value >= 0),
  useful_life_months     int NOT NULL CHECK (useful_life_months BETWEEN 1 AND 1200),
  opening_depreciation   numeric(18,2) NOT NULL DEFAULT 0 CHECK (opening_depreciation >= 0),
  serial_no              text,
  location               text,
  reference              text,
  notes                  text,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed')),
  disposed_on            date,
  disposal_proceeds      numeric(18,2) CHECK (disposal_proceeds IS NULL OR disposal_proceeds >= 0),
  disposal_entry_id      uuid UNIQUE REFERENCES journal_entries(id),
  created_by             uuid NOT NULL REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number),
  CHECK (residual_value < cost),
  CHECK (opening_depreciation <= cost - residual_value),
  CHECK (depreciation_start >= date_trunc('month', purchase_date)),
  CHECK ((status = 'disposed') = (disposed_on IS NOT NULL) AND (status = 'disposed') = (disposal_entry_id IS NOT NULL))
);

CREATE TABLE depreciation_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  period_end       date NOT NULL CHECK (period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date),
  total            numeric(18,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  journal_entry_id uuid UNIQUE REFERENCES journal_entries(id),
  run_by           uuid NOT NULL REFERENCES users(id),
  run_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, period_end)
);

CREATE TABLE depreciation_lines (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  run_id     uuid NOT NULL REFERENCES depreciation_runs(id),
  asset_id   uuid NOT NULL REFERENCES fixed_assets(id),
  amount     numeric(18,2) NOT NULL CHECK (amount > 0),
  UNIQUE (run_id, asset_id)
);

-- What an asset still needs to be depreciated by the end of a month. Runs before that month count as booked;
-- with p_including, the run for that month itself counts too ("is depreciation up to date by then?").
CREATE FUNCTION depreciation_due(p_asset uuid, p_period_end date, p_including boolean DEFAULT false) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a fixed_assets%ROWTYPE; n int; depreciable numeric; target numeric; booked numeric;
BEGIN
  SELECT * INTO a FROM fixed_assets WHERE id = p_asset;
  IF a.id IS NULL OR (app_user_id() IS NOT NULL AND NOT (a.company_id = ANY (app_company_ids()))) THEN RETURN 0; END IF;   -- other companies see nothing
  IF a.disposed_on IS NOT NULL AND a.disposed_on <= p_period_end THEN RETURN 0; END IF;
  n := (extract(year FROM p_period_end) * 12 + extract(month FROM p_period_end))
     - (extract(year FROM a.depreciation_start) * 12 + extract(month FROM a.depreciation_start)) + 1;
  IF n <= 0 THEN RETURN 0; END IF;
  depreciable := a.cost - a.residual_value;
  target := CASE WHEN n >= a.useful_life_months THEN depreciable ELSE round(depreciable * n / a.useful_life_months, 2) END;
  SELECT coalesce(sum(l.amount), 0) INTO booked FROM depreciation_lines l JOIN depreciation_runs r ON r.id = l.run_id
  WHERE l.asset_id = p_asset AND (r.period_end < p_period_end OR (p_including AND r.period_end = p_period_end));
  RETURN greatest(target - a.opening_depreciation - booked, 0);
END $$;
GRANT EXECUTE ON FUNCTION depreciation_due(uuid, date, boolean) TO nusuh_app;

CREATE FUNCTION before_fixed_asset_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE acc accounts%ROWTYPE; exp accounts%ROWTYPE; booked numeric; e journal_entries%ROWTYPE; cost_cr numeric; prev_end date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now();
    IF NEW.status <> 'active' OR NEW.disposed_on IS NOT NULL THEN RAISE EXCEPTION 'A new asset starts in use.'; END IF;
  ELSE
    IF OLD.status = 'disposed' THEN RAISE EXCEPTION 'A disposed asset never changes.'; END IF;
    IF NEW.company_id <> OLD.company_id OR NEW.number <> OLD.number OR NEW.created_by <> OLD.created_by THEN
      RAISE EXCEPTION 'An asset keeps its company and number.';
    END IF;
    SELECT coalesce(sum(amount), 0) INTO booked FROM depreciation_lines WHERE asset_id = OLD.id;
    IF booked > 0 AND (NEW.cost, NEW.residual_value, NEW.useful_life_months, NEW.depreciation_start, NEW.opening_depreciation,
                       NEW.asset_account_id, NEW.expense_account_id, NEW.purchase_date)
                IS DISTINCT FROM (OLD.cost, OLD.residual_value, OLD.useful_life_months, OLD.depreciation_start, OLD.opening_depreciation,
                       OLD.asset_account_id, OLD.expense_account_id, OLD.purchase_date) THEN
      RAISE EXCEPTION 'Depreciation has been booked on this asset, so its cost, life and accounts can no longer change.';
    END IF;
    IF NEW.status = 'disposed' THEN
      prev_end := (date_trunc('month', NEW.disposed_on) - interval '1 day')::date;
      IF depreciation_due(NEW.id, prev_end, true) > 0 THEN
        RAISE EXCEPTION 'Run depreciation up to % before disposing of this asset.', prev_end;
      END IF;
      IF EXISTS (SELECT 1 FROM depreciation_lines l JOIN depreciation_runs r ON r.id = l.run_id
                 WHERE l.asset_id = NEW.id AND r.period_end > (date_trunc('month', NEW.disposed_on) + interval '1 month - 1 day')::date) THEN
        RAISE EXCEPTION 'Depreciation was already booked for months after this date. Use a later disposal date.';
      END IF;
      SELECT * INTO e FROM journal_entries WHERE id = NEW.disposal_entry_id;
      SELECT coalesce(sum(credit - debit), 0) INTO cost_cr FROM journal_lines WHERE entry_id = e.id AND account_id = NEW.asset_account_id;
      IF e.id IS NULL OR e.source_id IS DISTINCT FROM NEW.id OR e.entry_date <> NEW.disposed_on OR cost_cr <> NEW.cost THEN
        RAISE EXCEPTION 'A disposal needs its own journal entry that removes the asset''s cost.';
      END IF;
      IF NEW.disposed_on < NEW.purchase_date THEN RAISE EXCEPTION 'An asset cannot be disposed of before it was bought.'; END IF;
    END IF;
  END IF;
  SELECT * INTO acc FROM accounts WHERE id = NEW.asset_account_id;
  SELECT * INTO exp FROM accounts WHERE id = NEW.expense_account_id;
  IF acc.company_id IS DISTINCT FROM NEW.company_id OR acc.type <> 'asset' OR acc.is_bank OR acc.code IN ('1100', '1200', '1300', '1590') THEN
    RAISE EXCEPTION 'Choose the fixed asset account the asset was bought into (for example 1500 Equipment).';
  END IF;
  IF exp.company_id IS DISTINCT FROM NEW.company_id OR exp.type <> 'expense' THEN
    RAISE EXCEPTION 'Choose an expense account for depreciation.';
  END IF;
  IF (NEW.cost_centre_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cost_centres WHERE id = NEW.cost_centre_id AND company_id = NEW.company_id))
     OR (NEW.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts WHERE id = NEW.contact_id AND company_id = NEW.company_id AND is_supplier)) THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fixed_assets_before_change BEFORE INSERT OR UPDATE ON fixed_assets FOR EACH ROW EXECUTE FUNCTION before_fixed_asset_change();
CREATE TRIGGER fixed_assets_no_delete BEFORE DELETE ON fixed_assets FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION before_depreciation_run_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE last date; acc uuid; credited numeric; e journal_entries%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.run_by := app_user_id(); END IF;
    NEW.run_at := now(); NEW.total := 0; NEW.journal_entry_id := NULL;
    SELECT max(period_end) INTO last FROM depreciation_runs WHERE company_id = NEW.company_id;
    IF last IS NOT NULL AND NEW.period_end <> (date_trunc('month', last) + interval '2 month - 1 day')::date THEN
      RAISE EXCEPTION 'Depreciation runs one month at a time. The next month to run ends on %.',
        (date_trunc('month', last) + interval '2 month - 1 day')::date;
    END IF;
    IF NEW.period_end > (date_trunc('month', current_date) + interval '1 month - 1 day')::date THEN
      RAISE EXCEPTION 'Depreciation cannot be run for a future month.';
    END IF;
    RETURN NEW;
  END IF;
  -- The only change: the run's total and its journal entry, once, right after its lines.
  IF OLD.journal_entry_id IS NOT NULL OR OLD.total <> 0
     OR (to_jsonb(NEW) - 'total' - 'journal_entry_id') <> (to_jsonb(OLD) - 'total' - 'journal_entry_id') THEN
    RAISE EXCEPTION 'A depreciation run is never changed. Post a reversal instead.';
  END IF;
  IF NEW.total <> (SELECT coalesce(sum(amount), 0) FROM depreciation_lines WHERE run_id = NEW.id) THEN
    RAISE EXCEPTION 'The run total must equal its lines.';
  END IF;
  IF NEW.total > 0 THEN
    SELECT id INTO acc FROM accounts WHERE company_id = NEW.company_id AND code = '1590';
    SELECT * INTO e FROM journal_entries WHERE id = NEW.journal_entry_id;
    SELECT coalesce(sum(credit - debit), 0) INTO credited FROM journal_lines WHERE entry_id = e.id AND account_id = acc;
    IF e.id IS NULL OR e.source_id IS DISTINCT FROM NEW.id OR e.entry_date <> NEW.period_end OR credited <> NEW.total THEN
      RAISE EXCEPTION 'A depreciation run needs its own journal entry crediting 1590 Accumulated depreciation.';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER depreciation_runs_before_change BEFORE INSERT OR UPDATE ON depreciation_runs
  FOR EACH ROW EXECUTE FUNCTION before_depreciation_run_change();
CREATE TRIGGER depreciation_runs_no_delete BEFORE DELETE ON depreciation_runs FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION before_depreciation_line_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r depreciation_runs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM depreciation_runs WHERE id = NEW.run_id;
  IF r.company_id <> NEW.company_id OR r.journal_entry_id IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM fixed_assets WHERE id = NEW.asset_id AND company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'Depreciation lines are added to an open run of the same company.';
  END IF;
  IF NEW.amount <> depreciation_due(NEW.asset_id, r.period_end) THEN
    RAISE EXCEPTION 'This month''s depreciation for the asset is %, not %.', depreciation_due(NEW.asset_id, r.period_end), NEW.amount;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER depreciation_lines_before_insert BEFORE INSERT ON depreciation_lines FOR EACH ROW EXECUTE FUNCTION before_depreciation_line_insert();
CREATE TRIGGER depreciation_lines_immutable BEFORE UPDATE OR DELETE ON depreciation_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- At commit, a run with lines must carry their total and its journal entry.
CREATE FUNCTION check_depreciation_run_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r depreciation_runs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM depreciation_runs WHERE id = NEW.run_id;
  IF r.journal_entry_id IS NULL OR r.total <> (SELECT sum(amount) FROM depreciation_lines WHERE run_id = r.id) THEN
    RAISE EXCEPTION 'A depreciation run must be posted with its journal entry.';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER depreciation_lines_run_posted AFTER INSERT ON depreciation_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_depreciation_run_complete();

-- ---------------------------------------------------------------------------
-- Audit and row-level security
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['fixed_assets', 'depreciation_runs', 'depreciation_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_update', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nusuh_app', t);
  END LOOP;
END $$;
