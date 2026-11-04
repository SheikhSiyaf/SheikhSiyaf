-- 0029 Multi-currency ledger accounts, exchange rates and the month-end revaluation (IAS 21).
--
-- * An asset or liability account can be kept in another currency (accounts.currency; empty = the company's).
--   Every line on it carries the foreign amount and the rate, and the amount in the company's currency must equal
--   foreign amount x rate, rounded to 2 decimals. Only the revaluation (and its reversal) posts company-currency
--   differences with no foreign amount.
-- * Exchange rates: shared rates synced daily (company_id empty; written only by the server's daily job) and a
--   company's own rates (typed by its accountants). A company's own rate wins on the same date.
-- * fx_revaluations: one posted restatement per company and month end, with the figures it used; reversible.
-- * fx_settings: the automatic month-end revaluation, run as the person who turned it on.
-- Foreign accounts are not bank accounts yet: invoices, payments and bank statements in other currencies come later.

ALTER TABLE accounts
  ADD COLUMN currency char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN revalue boolean NOT NULL DEFAULT true;

CREATE FUNCTION before_account_currency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.currency = (SELECT currency FROM companies WHERE id = NEW.company_id) THEN NEW.currency := NULL; END IF;
  IF NEW.currency IS NOT NULL THEN
    IF NEW.type NOT IN ('asset', 'liability') THEN
      RAISE EXCEPTION 'Only asset and liability accounts are kept in another currency.';
    END IF;
    IF NEW.is_bank THEN
      RAISE EXCEPTION 'A bank account in another currency is not supported yet: keep it as an ordinary account in that currency.';
    END IF;
    IF NEW.code IN ('1000', '1010', '1100', '1150', '1200', '1300', '1590', '2000', '2050', '2100', '2200', '2210', '2220', '2230') THEN
      RAISE EXCEPTION 'This account is used by the sales, purchases, inventory or payroll screens and stays in the company''s currency. Add a new account for the other currency.';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.currency IS DISTINCT FROM OLD.currency AND EXISTS (SELECT 1 FROM journal_lines WHERE account_id = NEW.id) THEN
    RAISE EXCEPTION 'This account has postings, so its currency no longer changes.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_currency BEFORE INSERT OR UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION before_account_currency();

-- ---------------------------------------------------------------------------
-- Journal lines in a foreign currency
-- ---------------------------------------------------------------------------
ALTER TABLE journal_lines
  ADD COLUMN fx_amount numeric(18,2) CHECK (fx_amount >= 0),
  ADD COLUMN fx_rate numeric(18,8) CHECK (fx_rate > 0);

CREATE FUNCTION before_line_fx() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cur char(3); src text;
BEGIN
  SELECT currency INTO cur FROM accounts WHERE id = NEW.account_id;
  IF cur IS NULL THEN
    IF NEW.fx_amount IS NOT NULL OR NEW.fx_rate IS NOT NULL THEN RAISE EXCEPTION 'This account is in the company''s currency: no foreign amount.'; END IF;
    RETURN NEW;
  END IF;
  SELECT source_type INTO src FROM journal_entries WHERE id = NEW.entry_id;
  IF src = 'fx_revaluation' AND coalesce(NEW.fx_amount, 0) = 0 THEN
    NEW.fx_amount := 0; NEW.fx_rate := NULL;
    RETURN NEW;
  END IF;
  IF NEW.fx_amount IS NULL OR NEW.fx_amount = 0 OR NEW.fx_rate IS NULL THEN
    RAISE EXCEPTION 'This account is kept in %: give the % amount and the rate.', cur, cur;
  END IF;
  IF NEW.debit + NEW.credit <> round(NEW.fx_amount * NEW.fx_rate, 2) THEN
    RAISE EXCEPTION 'The amount must be the % amount times the rate (% x % = %).', cur, NEW.fx_amount, NEW.fx_rate, round(NEW.fx_amount * NEW.fx_rate, 2);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lines_fx BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION before_line_fx();

-- A reversal copies the foreign amounts too.
CREATE OR REPLACE FUNCTION reverse_entry(p_entry_id uuid, p_date date, p_memo text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE e journal_entries%ROWTYPE; new_id uuid;
BEGIN
  SELECT * INTO e FROM journal_entries WHERE id = p_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entry not found.';
  END IF;
  IF e.reverses_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'This entry is itself a reversal. Post a new entry instead.';
  END IF;
  IF EXISTS (SELECT 1 FROM journal_entries WHERE reverses_entry_id = p_entry_id) THEN
    RAISE EXCEPTION 'This entry has already been reversed.';
  END IF;

  INSERT INTO journal_entries (company_id, entry_date, memo, reverses_entry_id, source_type, source_id, created_by)
  VALUES (e.company_id, p_date, coalesce(p_memo, 'Reversal of ' || coalesce(e.memo, e.id::text)),
          e.id, e.source_type, e.source_id, coalesce(app_user_id(), e.created_by))
  RETURNING id INTO new_id;

  INSERT INTO journal_lines (entry_id, account_id, cost_centre_id, debit, credit, fx_amount, fx_rate)
  SELECT new_id, account_id, cost_centre_id, credit, debit, fx_amount, fx_rate FROM journal_lines WHERE entry_id = e.id;

  RETURN new_id;
END $$;

-- ---------------------------------------------------------------------------
-- Exchange rates
-- ---------------------------------------------------------------------------
CREATE TABLE exchange_rates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies(id),            -- empty: shared rate from the daily sync
  rate_date   date NOT NULL,
  currency    char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  base        char(3) NOT NULL CHECK (base ~ '^[A-Z]{3}$'),
  rate        numeric(18,8) NOT NULL CHECK (rate > 0),  -- 1 currency = rate base
  source      text NOT NULL,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (currency <> base)
);
CREATE UNIQUE INDEX exchange_rates_key ON exchange_rates (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), rate_date, currency, base);
CREATE INDEX exchange_rates_lookup ON exchange_rates (base, currency, rate_date DESC);

CREATE FUNCTION before_rate_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.company_id IS NULL AND app_user_id() IS NOT NULL THEN
    RAISE EXCEPTION 'Shared rates come only from the daily sync.';
  END IF;
  IF NEW.company_id IS NOT NULL THEN
    NEW.base := (SELECT currency FROM companies WHERE id = NEW.company_id);
    IF NEW.currency = NEW.base THEN RAISE EXCEPTION 'Choose a currency other than the company''s.'; END IF;
    NEW.created_by := app_user_id();
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.rate_date <> OLD.rate_date OR NEW.currency <> OLD.currency) THEN
    RAISE EXCEPTION 'Enter a new rate instead.';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER exchange_rates_before_change BEFORE INSERT OR UPDATE ON exchange_rates FOR EACH ROW EXECUTE FUNCTION before_rate_change();
CREATE TRIGGER exchange_rates_no_delete BEFORE DELETE ON exchange_rates FOR EACH ROW EXECUTE FUNCTION forbid_change();

/** The rate for a company on a date: the latest on or before it; the company's own rate wins on the same date. */
CREATE FUNCTION fx_rate_for(p_company uuid, p_currency text, p_date date)
RETURNS TABLE (rate numeric, rate_date date, source text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.rate, r.rate_date, CASE WHEN r.company_id IS NULL THEN r.source ELSE 'company' END
  FROM exchange_rates r JOIN companies c ON c.id = p_company
  WHERE r.currency = p_currency AND r.base = c.currency AND r.rate_date <= p_date AND (r.company_id IS NULL OR r.company_id = p_company)
    AND p_company = ANY (app_company_ids())
  ORDER BY r.rate_date DESC, (r.company_id IS NULL) ASC
  LIMIT 1
$$;

/** For the daily job (no person signed in): store shared rates, replacing those of the same day. */
CREATE FUNCTION store_shared_rates(p_rows jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF app_user_id() IS NOT NULL THEN RAISE EXCEPTION 'Shared rates come only from the daily sync.'; END IF;
  INSERT INTO exchange_rates (company_id, rate_date, currency, base, rate, source)
  SELECT NULL, x.rate_date, x.currency, x.base, x.rate, x.source FROM jsonb_to_recordset(p_rows) AS x(rate_date date, currency text, base text, rate numeric, source text)
  ON CONFLICT (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), rate_date, currency, base) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

/** For the daily job: the company currencies, the foreign currencies in use, and whether today's rates are there. */
CREATE FUNCTION fx_sync_needs(p_day date) RETURNS TABLE (base text, currencies text[], have int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  -- Only for the server's job: nothing for a signed-in person.
  SELECT c.currency::text,
         array(SELECT DISTINCT a.currency::text FROM accounts a JOIN companies x ON x.id = a.company_id WHERE x.currency = c.currency AND a.currency IS NOT NULL),
         (SELECT count(*)::int FROM exchange_rates r WHERE r.company_id IS NULL AND r.base = c.currency AND r.rate_date = p_day)
  FROM (SELECT DISTINCT currency FROM companies WHERE status = 'active') c
  WHERE app_user_id() IS NULL
$$;

-- ---------------------------------------------------------------------------
-- Revaluations and settings
-- ---------------------------------------------------------------------------
CREATE TABLE fx_settings (
  company_id   uuid PRIMARY KEY REFERENCES companies(id),
  auto_revalue boolean NOT NULL DEFAULT false,
  enabled_by   uuid REFERENCES users(id),
  enabled_at   timestamptz,
  last_run     timestamptz,
  last_problem text
);

CREATE TABLE fx_revaluations (
  id                 uuid PRIMARY KEY,
  company_id         uuid NOT NULL REFERENCES companies(id),
  period_end         date NOT NULL,
  entry_id           uuid REFERENCES journal_entries(id),     -- empty when nothing needed restating
  status             text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  automatic          boolean NOT NULL DEFAULT false,
  lines              jsonb NOT NULL,                          -- what was used: accounts, balances, rates, adjustments
  unrealised         numeric(18,2) NOT NULL,
  realised           numeric(18,2) NOT NULL,
  reversal_entry_id  uuid REFERENCES journal_entries(id),
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date)
);
CREATE UNIQUE INDEX fx_revaluations_one_per_month ON fx_revaluations (company_id, period_end) WHERE status = 'posted';

CREATE FUNCTION before_fx_revaluation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now(); NEW.status := 'posted'; NEW.reversal_entry_id := NULL;
    IF NEW.entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = NEW.entry_id AND e.company_id = NEW.company_id
         AND e.source_type = 'fx_revaluation' AND e.source_id = NEW.id AND e.entry_date = NEW.period_end) THEN
      RAISE EXCEPTION 'A revaluation needs its own entry on the month end.';
    END IF;
    IF EXISTS (SELECT 1 FROM fx_revaluations r WHERE r.company_id = NEW.company_id AND r.status = 'posted' AND r.period_end > NEW.period_end) THEN
      RAISE EXCEPTION 'A later month is already revalued. Reverse it first.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.period_end <> OLD.period_end OR NEW.entry_id IS DISTINCT FROM OLD.entry_id OR NEW.lines <> OLD.lines OR OLD.status <> 'posted' OR NEW.status <> 'reversed' THEN
    RAISE EXCEPTION 'A revaluation is not changed; it can only be reversed.';
  END IF;
  IF NEW.reversal_entry_id IS NULL AND OLD.entry_id IS NOT NULL THEN RAISE EXCEPTION 'Reverse its entry first.'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fx_revaluations_before_change BEFORE INSERT OR UPDATE ON fx_revaluations FOR EACH ROW EXECUTE FUNCTION before_fx_revaluation();
CREATE TRIGGER fx_revaluations_no_delete BEFORE DELETE ON fx_revaluations FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION before_fx_settings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.auto_revalue IS DISTINCT FROM OLD.auto_revalue) THEN
    NEW.enabled_by := CASE WHEN NEW.auto_revalue THEN app_user_id() END;
    NEW.enabled_at := CASE WHEN NEW.auto_revalue THEN now() END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fx_settings_before_change BEFORE INSERT OR UPDATE ON fx_settings FOR EACH ROW EXECUTE FUNCTION before_fx_settings();

/** For the daily job: companies with the automatic revaluation on, whose last month end is not revalued and not locked. */
CREATE FUNCTION fx_auto_due(p_period_end date) RETURNS TABLE (company_id uuid, enabled_by uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.company_id, s.enabled_by FROM fx_settings s JOIN companies c ON c.id = s.company_id
  WHERE s.auto_revalue AND s.enabled_by IS NOT NULL AND c.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM fx_revaluations r WHERE r.company_id = s.company_id AND r.period_end >= p_period_end AND r.status = 'posted')
    AND NOT EXISTS (SELECT 1 FROM periods p WHERE p.company_id = s.company_id AND p.locked_at IS NOT NULL AND p_period_end BETWEEN p.start_date AND p.end_date)
    AND EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = s.company_id AND a.currency IS NOT NULL AND a.revalue)
    AND app_user_id() IS NULL
$$;
/** For the daily job: what happened on the last automatic run. */
CREATE FUNCTION fx_auto_note(p_company uuid, p_problem text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE fx_settings SET last_run = now(), last_problem = p_problem WHERE company_id = p_company AND app_user_id() IS NULL
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['exchange_rates', 'fx_revaluations', 'fx_settings'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
CREATE POLICY exchange_rates_read ON exchange_rates FOR SELECT USING (company_id IS NULL OR company_id = ANY (app_company_ids()));
CREATE POLICY exchange_rates_insert ON exchange_rates FOR INSERT WITH CHECK (company_id IS NOT NULL AND app_has_role(company_id, posting_roles()));
CREATE POLICY exchange_rates_update ON exchange_rates FOR UPDATE USING (company_id IS NOT NULL AND app_has_role(company_id, posting_roles()))
  WITH CHECK (company_id IS NOT NULL AND app_has_role(company_id, posting_roles()));
CREATE POLICY fx_revaluations_read ON fx_revaluations FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY fx_revaluations_insert ON fx_revaluations FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY fx_revaluations_update ON fx_revaluations FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY fx_settings_read ON fx_settings FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY fx_settings_insert ON fx_settings FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY fx_settings_update ON fx_settings FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));
GRANT SELECT, INSERT, UPDATE ON exchange_rates, fx_revaluations, fx_settings TO nusuh_app;
GRANT EXECUTE ON FUNCTION fx_rate_for(uuid, text, date), store_shared_rates(jsonb), fx_sync_needs(date), fx_auto_due(date), fx_auto_note(uuid, text) TO nusuh_app;
