-- Nusuh Books foundation schema (PostgreSQL 14+). Untested draft: run it and the rule tests first.
CREATE TYPE account_type AS ENUM ('asset','liability','equity','income','expense');
CREATE TYPE user_role AS ENUM ('partner','reviewer','client_accountant','client_viewer');
CREATE TYPE cc_kind AS ENUM ('company','branch','department','project');

CREATE TABLE firms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  name text NOT NULL,
  country char(2) NOT NULL CHECK (country IN ('SA','AE','OM')),
  currency char(3) NOT NULL,
  vat_rate numeric(5,2) NOT NULL,
  compliance_notes text
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  totp_secret_enc text            -- two-factor login
);

-- partner/reviewer: company_id NULL = all firm companies; client roles are per company
CREATE TABLE memberships (
  user_id uuid NOT NULL REFERENCES users(id),
  company_id uuid REFERENCES companies(id),
  role user_role NOT NULL
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  code text NOT NULL, name text NOT NULL, type account_type NOT NULL,
  parent_id uuid REFERENCES accounts(id),
  cost_centre_required boolean NOT NULL DEFAULT false,
  UNIQUE (company_id, code)
);

CREATE TABLE cost_centres (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  parent_id uuid REFERENCES cost_centres(id),
  kind cc_kind NOT NULL, name text NOT NULL
);

CREATE TABLE periods (
  company_id uuid NOT NULL REFERENCES companies(id),
  start_date date NOT NULL, end_date date NOT NULL,
  locked_at timestamptz,
  PRIMARY KEY (company_id, start_date)
);

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  entry_date date NOT NULL,
  memo text,
  reverses_entry_id uuid UNIQUE REFERENCES journal_entries(id),
  source_type text, source_id uuid,         -- invoice, bill, bank, manual...
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES journal_entries(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  cost_centre_id uuid REFERENCES cost_centres(id),
  debit numeric(18,2) NOT NULL DEFAULT 0,
  credit numeric(18,2) NOT NULL DEFAULT 0,
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0))
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid, company_id uuid,
  table_name text NOT NULL, row_id text, action text NOT NULL, detail jsonb
);

-- Rule 2: posted entries and lines are immutable; audit log is append-only
CREATE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Posted records cannot be changed or deleted. Post a reversal instead.'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER entries_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER lines_immutable BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Rule 3: locked periods reject posting
CREATE FUNCTION check_period_open() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM periods p WHERE p.company_id = NEW.company_id
             AND NEW.entry_date BETWEEN p.start_date AND p.end_date AND p.locked_at IS NOT NULL)
  THEN RAISE EXCEPTION 'This period is locked. Choose a date in an open period.'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER entries_period_open BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION check_period_open();

-- Rule 1 and 4: balanced, 2+ lines, cost centre where required (checked at commit)
CREATE FUNCTION check_entry_valid() RETURNS trigger AS $$
DECLARE d numeric; c numeric; n int;
BEGIN
  SELECT sum(debit), sum(credit), count(*) INTO d, c, n FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF n < 2 OR d <> c THEN RAISE EXCEPTION 'Entry does not balance (debit %, credit %).', d, c; END IF;
  IF EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id
             WHERE l.entry_id = NEW.entry_id AND a.cost_centre_required AND l.cost_centre_id IS NULL)
  THEN RAISE EXCEPTION 'A cost centre is required for one of the accounts used.'; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER lines_valid AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_valid();

-- Rule 6: data separation. App sets: SET app.company_ids = 'uuid1,uuid2' per request.
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY entries_by_company ON journal_entries
  USING (company_id::text = ANY (string_to_array(current_setting('app.company_ids', true), ',')));
-- TODO: same policy for accounts, cost_centres, periods and later tables; journal_lines via entry join.
