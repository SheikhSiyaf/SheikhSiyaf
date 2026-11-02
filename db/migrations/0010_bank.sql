-- 0010: Bank accounts, statement import, matching and rules.
--   * Every bank or cash ledger account (accounts.is_bank) has one bank_accounts row with the bank's details
--     (bank name, account number, IBAN). Adding a bank account creates its ledger account.
--   * Statement lines are the bank's own record. Once imported, their date, text and amount never change;
--     only their match status does. The same line is never imported twice (fingerprint per bank account).
--   * A statement line is matched to exactly one journal line on that bank's ledger account, for the same
--     amount in the same direction (money in = debit, money out = credit). That is what reconciliation is.
--   * Rules remember how a kind of line was booked ("always do this") and are offered as suggestions.

-- ---------------------------------------------------------------------------
-- IBAN check (ISO 13616 mod 97); Saudi IBANs have 24 characters, UAE 23.
-- ---------------------------------------------------------------------------
CREATE FUNCTION iban_valid(p text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE s text; r int := 0; ch text; i int;
BEGIN
  IF p IS NULL OR p !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' THEN RETURN false; END IF;
  IF (left(p, 2) = 'SA' AND length(p) <> 24) OR (left(p, 2) = 'AE' AND length(p) <> 23) THEN RETURN false; END IF;
  s := substr(p, 5) || substr(p, 1, 4);
  FOR i IN 1..length(s) LOOP
    ch := substr(s, i, 1);
    r := ((r::text || CASE WHEN ch ~ '[0-9]' THEN ch ELSE (ascii(ch) - 55)::text END)::bigint % 97)::int;
  END LOOP;
  RETURN r = 1;
END $$;

-- ---------------------------------------------------------------------------
-- Bank accounts
-- ---------------------------------------------------------------------------
CREATE TABLE bank_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  account_id     uuid NOT NULL UNIQUE REFERENCES accounts(id),
  kind           text NOT NULL DEFAULT 'bank' CHECK (kind IN ('bank', 'cash', 'card')),
  bank_name      text,
  account_number text,
  iban           text CHECK (iban IS NULL OR iban_valid(iban)),
  import_layout  jsonb,           -- the statement file layout remembered for this account
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);
CREATE UNIQUE INDEX bank_accounts_iban ON bank_accounts (company_id, iban) WHERE iban IS NOT NULL;
CREATE UNIQUE INDEX bank_accounts_number ON bank_accounts (company_id, account_number) WHERE account_number IS NOT NULL;

CREATE FUNCTION before_bank_account_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now();
  ELSIF NEW.company_id <> OLD.company_id OR NEW.account_id <> OLD.account_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'A bank account stays with its company and ledger account.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND company_id = NEW.company_id AND is_bank AND type = 'asset') THEN
    RAISE EXCEPTION 'A bank account needs a bank or cash ledger account of the same company.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_accounts_before_change BEFORE INSERT OR UPDATE ON bank_accounts
  FOR EACH ROW EXECUTE FUNCTION before_bank_account_change();
CREATE TRIGGER bank_accounts_no_delete BEFORE DELETE ON bank_accounts FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Every bank or cash ledger account gets its bank_accounts row, however it was created.
CREATE FUNCTION after_account_insert_bank() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.is_bank AND NOT EXISTS (SELECT 1 FROM bank_accounts WHERE account_id = NEW.id) THEN
    INSERT INTO bank_accounts (company_id, account_id, kind)
    VALUES (NEW.company_id, NEW.id, CASE WHEN NEW.code = '1010' OR NEW.name ILIKE '%cash%' THEN 'cash' ELSE 'bank' END);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER accounts_bank_row AFTER INSERT OR UPDATE OF is_bank ON accounts
  FOR EACH ROW EXECUTE FUNCTION after_account_insert_bank();

INSERT INTO bank_accounts (company_id, account_id, kind)
SELECT company_id, id, CASE WHEN code = '1010' THEN 'cash' ELSE 'bank' END FROM accounts WHERE is_bank;

-- ---------------------------------------------------------------------------
-- Statement imports and lines
-- ---------------------------------------------------------------------------
CREATE TABLE bank_imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  file_name       text NOT NULL,
  line_count      int NOT NULL CHECK (line_count >= 0),
  skipped         int NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  date_from       date,
  date_to         date,
  imported_by     uuid NOT NULL REFERENCES users(id),
  imported_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bank_statement_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  import_id       uuid NOT NULL REFERENCES bank_imports(id),
  txn_date        date NOT NULL,
  description     text NOT NULL CHECK (btrim(description) <> ''),
  reference       text,
  amount          numeric(18,2) NOT NULL CHECK (amount <> 0),   -- money in is positive, money out negative
  balance         numeric(18,2),                                 -- running balance, when the bank gives one
  fingerprint     text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'ignored')),
  journal_line_id uuid UNIQUE REFERENCES journal_lines(id),
  matched_by      uuid REFERENCES users(id),
  matched_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_account_id, fingerprint),
  CHECK ((status = 'matched') = (journal_line_id IS NOT NULL))
);
CREATE INDEX bank_statement_lines_account ON bank_statement_lines (bank_account_id, txn_date);

CREATE FUNCTION before_bank_import_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL THEN NEW.imported_by := app_user_id(); END IF;
  NEW.imported_at := now();
  IF NOT EXISTS (SELECT 1 FROM bank_accounts WHERE id = NEW.bank_account_id AND company_id = NEW.company_id AND status = 'active') THEN
    RAISE EXCEPTION 'Choose an open bank account of this company.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_imports_before_insert BEFORE INSERT ON bank_imports FOR EACH ROW EXECUTE FUNCTION before_bank_import_insert();
CREATE TRIGGER bank_imports_immutable BEFORE UPDATE ON bank_imports FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION before_statement_line_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE jl journal_lines%ROWTYPE; je journal_entries%ROWTYPE; ledger uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'matched' THEN
      RAISE EXCEPTION 'A matched statement line cannot be removed. Unmatch it first.';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM bank_imports WHERE id = NEW.import_id AND company_id = NEW.company_id AND bank_account_id = NEW.bank_account_id) THEN
      RAISE EXCEPTION 'Statement lines belong to an import of the same bank account.';
    END IF;
    IF NEW.status <> 'open' THEN RAISE EXCEPTION 'Imported lines start unmatched.'; END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  -- UPDATE: the bank's record never changes; only the match does.
  IF (to_jsonb(NEW) - 'status' - 'journal_line_id' - 'matched_by' - 'matched_at')
     <> (to_jsonb(OLD) - 'status' - 'journal_line_id' - 'matched_by' - 'matched_at') THEN
    RAISE EXCEPTION 'Imported statement lines are never changed.';
  END IF;
  IF NEW.status = 'matched' AND NEW.journal_line_id IS DISTINCT FROM OLD.journal_line_id THEN
    SELECT account_id INTO ledger FROM bank_accounts WHERE id = NEW.bank_account_id;
    SELECT * INTO jl FROM journal_lines WHERE id = NEW.journal_line_id;
    SELECT * INTO je FROM journal_entries WHERE id = jl.entry_id;
    IF jl.account_id IS DISTINCT FROM ledger OR je.company_id <> NEW.company_id THEN
      RAISE EXCEPTION 'A statement line can only be matched to an entry on the same bank account.';
    END IF;
    IF (NEW.amount > 0 AND jl.debit <> NEW.amount) OR (NEW.amount < 0 AND jl.credit <> -NEW.amount) THEN
      RAISE EXCEPTION 'The amount in the books (%) is not the amount on the statement (%).',
        CASE WHEN jl.debit > 0 THEN jl.debit ELSE -jl.credit END, NEW.amount;
    END IF;
  END IF;
  IF NEW.status = 'matched' THEN
    NEW.matched_by := coalesce(app_user_id(), NEW.matched_by); NEW.matched_at := coalesce(NEW.matched_at, now());
  ELSE
    NEW.journal_line_id := NULL; NEW.matched_by := NULL; NEW.matched_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_statement_lines_before_change BEFORE INSERT OR UPDATE OR DELETE ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION before_statement_line_change();

-- ---------------------------------------------------------------------------
-- Rules ("always do this")
-- ---------------------------------------------------------------------------
CREATE TABLE bank_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  bank_account_id uuid REFERENCES bank_accounts(id),    -- NULL = every bank account
  match_text      text NOT NULL CHECK (length(btrim(match_text)) >= 3),
  direction       text NOT NULL CHECK (direction IN ('in', 'out')),
  account_id      uuid NOT NULL REFERENCES accounts(id),
  cost_centre_id  uuid REFERENCES cost_centres(id),
  vat_code        text NOT NULL DEFAULT 'out_of_scope' CHECK (vat_code IN ('standard', 'zero', 'exempt', 'out_of_scope')),
  label           text,
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION before_bank_rule_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  IF TG_OP = 'UPDATE' AND (NEW.company_id <> OLD.company_id OR NEW.created_by <> OLD.created_by) THEN
    RAISE EXCEPTION 'A rule stays with its company.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND company_id = NEW.company_id)
     OR (NEW.cost_centre_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cost_centres WHERE id = NEW.cost_centre_id AND company_id = NEW.company_id))
     OR (NEW.bank_account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bank_accounts WHERE id = NEW.bank_account_id AND company_id = NEW.company_id)) THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_rules_before_change BEFORE INSERT OR UPDATE ON bank_rules FOR EACH ROW EXECUTE FUNCTION before_bank_rule_change();

-- ---------------------------------------------------------------------------
-- Audit and row-level security
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['bank_accounts', 'bank_imports', 'bank_statement_lines', 'bank_rules'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_update', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nusuh_app', t);
  END LOOP;
END $$;
CREATE POLICY bank_statement_lines_delete ON bank_statement_lines FOR DELETE USING (app_has_role(company_id, posting_roles()));
CREATE POLICY bank_rules_delete ON bank_rules FOR DELETE USING (app_has_role(company_id, posting_roles()));
GRANT DELETE ON bank_statement_lines, bank_rules TO nusuh_app;
