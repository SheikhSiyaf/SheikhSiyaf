-- Nusuh Books 0001: foundation (firms, companies, users, roles, accounts, cost centres,
-- periods, ledger, audit log, row-level security, trial balance and P&L functions).
-- Derived from the starter-kit draft db/schema.sql. See docs/SCHEMA_CHANGES.md for what changed and why.
--
-- Identity: the app opens a transaction and runs
--   SELECT set_config('app.user_id', '<user uuid>', true);
-- Everything else (which companies, which role) is derived in the database from memberships.
-- The app connects as role nusuh_app, which owns nothing, is not superuser and cannot bypass RLS.

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- for the non-overlapping periods constraint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nusuh_app') THEN
    CREATE ROLE nusuh_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
CREATE TYPE account_type AS ENUM ('asset','liability','equity','income','expense');
CREATE TYPE user_kind    AS ENUM ('admin','firm_staff','client');
CREATE TYPE user_role    AS ENUM ('partner','reviewer','staff_accountant','client_accountant','client_viewer');
CREATE TYPE cc_kind      AS ENUM ('company','branch','department','project');
CREATE TYPE vat_status   AS ENUM ('registered','unregistered');

-- ---------------------------------------------------------------------------
-- Firms, companies (client registration), users, memberships
-- ---------------------------------------------------------------------------
CREATE TABLE firms (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE TABLE companies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               uuid NOT NULL REFERENCES firms(id),
  -- required at registration
  name                  text NOT NULL CHECK (btrim(name) <> ''),
  country               char(2) NOT NULL CHECK (country IN ('SA','AE','OM')),
  currency              char(3) NOT NULL,
  cr_number             text NOT NULL,           -- CR (SA, OM) or trade licence (AE)
  legal_form            text NOT NULL CHECK (btrim(legal_form) <> ''),
  vat_status            vat_status NOT NULL,
  vat_number            text,                    -- required only if VAT registered
  vat_rate              numeric(5,2) NOT NULL CHECK (vat_rate >= 0 AND vat_rate <= 100),
  address               text NOT NULL CHECK (btrim(address) <> ''),
  city                  text NOT NULL CHECK (btrim(city) <> ''),
  fy_end_month          smallint NOT NULL CHECK (fy_end_month BETWEEN 1 AND 12),
  fy_end_day            smallint NOT NULL CHECK (fy_end_day BETWEEN 1 AND 31),
  -- optional
  name_ar               text,
  trade_name            text,
  cr_expiry             date,
  vat_registration_date date,
  phone                 text,
  email                 text,
  website               text,
  logo_path             text,
  compliance_notes      text,
  -- entry settings
  invoice_prefix        text NOT NULL DEFAULT 'INV-',
  payment_terms_days    integer NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT currency_matches_country CHECK (
    (country = 'SA' AND currency = 'SAR') OR (country = 'AE' AND currency = 'AED') OR (country = 'OM' AND currency = 'OMR')),
  CONSTRAINT vat_number_when_registered CHECK (
    (vat_status = 'registered'   AND vat_number IS NOT NULL) OR
    (vat_status = 'unregistered' AND vat_number IS NULL AND vat_rate = 0)),
  CONSTRAINT sa_cr_format  CHECK (country <> 'SA' OR cr_number ~ '^[0-9]{10}$'),
  CONSTRAINT sa_vat_format CHECK (country <> 'SA' OR vat_number IS NULL OR vat_number ~ '^3[0-9]{13}3$'),
  CONSTRAINT ae_trn_format CHECK (country <> 'AE' OR vat_number IS NULL OR vat_number ~ '^[0-9]{15}$'),
  CONSTRAINT cr_number_unique  UNIQUE (cr_number),
  CONSTRAINT vat_number_unique UNIQUE (vat_number)
);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id         uuid NOT NULL REFERENCES firms(id),
  kind            user_kind NOT NULL,
  full_name       text NOT NULL CHECK (btrim(full_name) <> ''),
  email           text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  password_hash   text,          -- NULL until the invited user sets a password
  totp_secret_enc text,          -- two-factor login (encrypted by the app)
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

-- One row per (user, company). Firm staff see only companies assigned to them.
-- Administrators have no memberships: they run the admin console and never see books.
CREATE TABLE memberships (
  user_id    uuid NOT NULL REFERENCES users(id),
  company_id uuid NOT NULL REFERENCES companies(id),
  role       user_role NOT NULL,
  PRIMARY KEY (user_id, company_id)
);
CREATE INDEX memberships_company ON memberships (company_id);

-- ---------------------------------------------------------------------------
-- Chart of accounts, cost centres, periods
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  code                 text NOT NULL,
  name                 text NOT NULL,
  name_ar              text,
  type                 account_type NOT NULL,
  parent_id            uuid REFERENCES accounts(id),
  cost_centre_required boolean NOT NULL DEFAULT false,
  UNIQUE (company_id, code),
  UNIQUE (company_id, id)
);

CREATE TABLE cost_centres (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  parent_id  uuid REFERENCES cost_centres(id),
  kind       cc_kind NOT NULL,
  name       text NOT NULL,
  name_ar    text,
  UNIQUE (company_id, id)
);

CREATE TABLE periods (
  company_id uuid NOT NULL REFERENCES companies(id),
  start_date date NOT NULL,
  end_date   date NOT NULL,
  locked_at  timestamptz,
  PRIMARY KEY (company_id, start_date),
  CHECK (end_date >= start_date),
  EXCLUDE USING gist (company_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
);

-- ---------------------------------------------------------------------------
-- Ledger
-- ---------------------------------------------------------------------------
CREATE TABLE journal_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id),
  entry_date        date NOT NULL,
  memo              text,
  reverses_entry_id uuid UNIQUE REFERENCES journal_entries(id),
  source_type       text,            -- invoice, bill, bank, manual...
  source_id         uuid,
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_xact      xid8 NOT NULL DEFAULT pg_current_xact_id()  -- lines may only be added in this transaction
);
CREATE INDEX journal_entries_company_date ON journal_entries (company_id, entry_date);

CREATE TABLE journal_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id       uuid NOT NULL REFERENCES journal_entries(id),
  account_id     uuid NOT NULL REFERENCES accounts(id),
  cost_centre_id uuid REFERENCES cost_centres(id),
  debit          numeric(18,2) NOT NULL DEFAULT 0,
  credit         numeric(18,2) NOT NULL DEFAULT 0,
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0)),
  CHECK (debit > 0 OR credit > 0)
);
CREATE INDEX journal_lines_entry ON journal_lines (entry_id);
CREATE INDEX journal_lines_account ON journal_lines (account_id);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    uuid,
  company_id uuid,
  table_name text NOT NULL,
  row_id     text,
  action     text NOT NULL,
  detail     jsonb
);
CREATE INDEX audit_log_company ON audit_log (company_id, at);

-- ---------------------------------------------------------------------------
-- Session helpers (SECURITY DEFINER so they can read memberships regardless of RLS)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app_company_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(company_id), '{}') FROM memberships WHERE user_id = app_user_id()
$$;

CREATE FUNCTION app_has_role(p_company uuid, p_roles user_role[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM memberships
                 WHERE user_id = app_user_id() AND company_id = p_company AND role = ANY (p_roles))
$$;

CREATE FUNCTION app_is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE id = app_user_id() AND kind = 'admin')
$$;

CREATE FUNCTION app_firm_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT firm_id FROM users WHERE id = app_user_id()
$$;

-- Roles that may post entries.
CREATE FUNCTION posting_roles() RETURNS user_role[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['partner','staff_accountant','client_accountant']::user_role[]
$$;

-- Login lookup, used before app.user_id is known.
CREATE FUNCTION auth_user_by_email(p_email text)
RETURNS TABLE (id uuid, kind user_kind, password_hash text, totp_secret_enc text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.kind, u.password_hash, u.totp_secret_enc FROM users u WHERE lower(u.email) = lower(p_email)
$$;

-- ---------------------------------------------------------------------------
-- Membership rules: role must match the kind of user; client users belong to one company;
-- users and companies must be in the same firm; admins have no memberships.
-- ---------------------------------------------------------------------------
CREATE FUNCTION check_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u users%ROWTYPE; c_firm uuid;
BEGIN
  SELECT * INTO u FROM users WHERE id = NEW.user_id;
  SELECT firm_id INTO c_firm FROM companies WHERE id = NEW.company_id;
  IF u.firm_id IS DISTINCT FROM c_firm THEN
    RAISE EXCEPTION 'This user belongs to a different firm.';
  END IF;
  IF u.kind = 'admin' THEN
    RAISE EXCEPTION 'Administrators cannot be assigned to client books.';
  ELSIF u.kind = 'firm_staff' AND NEW.role NOT IN ('partner','reviewer','staff_accountant') THEN
    RAISE EXCEPTION 'Firm staff can only be Firm partner, Reviewer or Staff accountant.';
  ELSIF u.kind = 'client' AND NEW.role NOT IN ('client_accountant','client_viewer') THEN
    RAISE EXCEPTION 'Client users can only be Client accountant or Client management.';
  END IF;
  IF u.kind = 'client' AND EXISTS (SELECT 1 FROM memberships m
                                   WHERE m.user_id = NEW.user_id AND m.company_id <> NEW.company_id) THEN
    RAISE EXCEPTION 'A client user can only belong to their own company.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_check BEFORE INSERT OR UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION check_membership();

-- A registered client must have its first client user by the end of the transaction.
CREATE FUNCTION check_company_has_client_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memberships
                 WHERE company_id = NEW.id AND role IN ('client_accountant','client_viewer')) THEN
    RAISE EXCEPTION 'Add the first client user (name and email) when registering a client.';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER companies_first_client_user AFTER INSERT ON companies
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_company_has_client_user();

-- ---------------------------------------------------------------------------
-- Rule 2: posted entries and lines are immutable; audit log is append-only
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'audit_log' THEN
    RAISE EXCEPTION 'The audit log cannot be changed.';
  END IF;
  RAISE EXCEPTION 'Posted records cannot be changed or deleted. Post a reversal instead.';
END $$;
CREATE TRIGGER entries_immutable  BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER lines_immutable    BEFORE UPDATE OR DELETE ON journal_lines   FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_immutable    BEFORE UPDATE OR DELETE ON audit_log       FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON journal_entries FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER lines_no_truncate   BEFORE TRUNCATE ON journal_lines   FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_no_truncate   BEFORE TRUNCATE ON audit_log       FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Rule 3: locked periods reject posting. Also stamps who/when/which transaction.
-- ---------------------------------------------------------------------------
CREATE FUNCTION before_entry_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.created_at   := now();
  NEW.created_xact := pg_current_xact_id();
  IF app_user_id() IS NOT NULL THEN
    NEW.created_by := app_user_id();
    IF NOT app_has_role(NEW.company_id, posting_roles()) THEN
      RETURN NEW;   -- RLS rejects it; do not reveal the other company's period locks
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM periods p WHERE p.company_id = NEW.company_id
             AND NEW.entry_date BETWEEN p.start_date AND p.end_date AND p.locked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'This period is locked. Choose a date in an open period.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entries_before_insert BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION before_entry_insert();

-- Lines: same transaction as their entry, accounts and cost centres from the same company.
CREATE FUNCTION before_line_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e journal_entries%ROWTYPE;
BEGIN
  SELECT * INTO e FROM journal_entries WHERE id = NEW.entry_id;
  -- Unknown entry, or a caller who may not post to it: let the foreign key / RLS reject it,
  -- without revealing anything about another company's entry.
  IF NOT FOUND OR (app_user_id() IS NOT NULL AND NOT app_has_role(e.company_id, posting_roles())) THEN
    RETURN NEW;
  END IF;
  IF e.created_xact <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'Posted records cannot be changed or deleted. Post a reversal instead.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND company_id = e.company_id) THEN
    RAISE EXCEPTION 'This account belongs to a different company.';
  END IF;
  IF NEW.cost_centre_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM cost_centres WHERE id = NEW.cost_centre_id AND company_id = e.company_id) THEN
    RAISE EXCEPTION 'This cost centre belongs to a different company.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lines_before_insert BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION before_line_insert();

-- ---------------------------------------------------------------------------
-- Rules 1 and 4: balanced, 2+ lines, cost centre where required (checked at commit).
-- Fires for the entry itself too, so an entry with no lines cannot be committed.
-- ---------------------------------------------------------------------------
CREATE FUNCTION check_entry_valid() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE eid uuid; d numeric; c numeric; n int;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN eid := NEW.id; ELSE eid := NEW.entry_id; END IF;
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) INTO d, c, n
    FROM journal_lines WHERE entry_id = eid;
  IF n < 2 THEN
    RAISE EXCEPTION 'An entry needs at least two lines.';
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'Entry does not balance (debit %, credit %).', d, c;
  END IF;
  IF EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id
             WHERE l.entry_id = eid AND a.cost_centre_required AND l.cost_centre_id IS NULL) THEN
    RAISE EXCEPTION 'A cost centre is required for one of the accounts used.';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER entries_valid AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_valid();
CREATE CONSTRAINT TRIGGER lines_valid AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_valid();

-- ---------------------------------------------------------------------------
-- Periods: only locked_at may change after creation.
-- ---------------------------------------------------------------------------
CREATE FUNCTION before_period_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.start_date <> OLD.start_date OR NEW.end_date <> OLD.end_date THEN
    RAISE EXCEPTION 'Period dates cannot be changed. Only lock or unlock the period.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER periods_before_update BEFORE UPDATE ON periods
  FOR EACH ROW EXECUTE FUNCTION before_period_update();
CREATE TRIGGER periods_no_delete BEFORE DELETE ON periods
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------
-- Rule 5: every change is written to the audit log.
-- ---------------------------------------------------------------------------
CREATE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb; o jsonb; act text; cid uuid; rid text;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  o := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
  IF TG_TABLE_NAME = 'users' THEN   -- never copy secrets into the log
    r := r - 'password_hash' - 'totp_secret_enc';
    o := o - 'password_hash' - 'totp_secret_enc';
  END IF;

  act := lower(TG_OP);
  IF TG_TABLE_NAME = 'journal_entries' AND (r->>'reverses_entry_id') IS NOT NULL THEN
    act := 'reverse';
  ELSIF TG_TABLE_NAME = 'periods' AND TG_OP = 'UPDATE' THEN
    act := CASE WHEN (r->>'locked_at') IS NOT NULL AND (o->>'locked_at') IS NULL THEN 'lock'
                WHEN (r->>'locked_at') IS NULL AND (o->>'locked_at') IS NOT NULL THEN 'unlock'
                ELSE 'update' END;
  END IF;

  cid := CASE TG_TABLE_NAME
           WHEN 'companies' THEN (r->>'id')::uuid
           WHEN 'users' THEN NULL
           WHEN 'journal_lines' THEN (SELECT company_id FROM journal_entries WHERE id = (r->>'entry_id')::uuid)
           ELSE (r->>'company_id')::uuid END;
  rid := coalesce(r->>'id',
                  CASE TG_TABLE_NAME
                    WHEN 'periods' THEN (r->>'company_id') || ':' || (r->>'start_date')
                    WHEN 'memberships' THEN (r->>'user_id') || ':' || (r->>'company_id') END);

  INSERT INTO audit_log (user_id, company_id, table_name, row_id, action, detail)
  VALUES (app_user_id(), cid, TG_TABLE_NAME, rid, act,
          CASE WHEN o IS NULL THEN jsonb_build_object('row', r)
               ELSE jsonb_build_object('before', o, 'after', r) END);
  RETURN NULL;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['companies','users','memberships','accounts','cost_centres','periods','journal_entries','journal_lines'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()',
                   t || '_audit', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Reversal (runs with the caller's rights, so role and company rules apply)
-- ---------------------------------------------------------------------------
CREATE FUNCTION reverse_entry(p_entry_id uuid, p_date date, p_memo text DEFAULT NULL) RETURNS uuid
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

  INSERT INTO journal_lines (entry_id, account_id, cost_centre_id, debit, credit)
  SELECT new_id, account_id, cost_centre_id, credit, debit FROM journal_lines WHERE entry_id = e.id;

  RETURN new_id;
END $$;

-- ---------------------------------------------------------------------------
-- Reports (caller's rights: only companies the user can see)
-- ---------------------------------------------------------------------------
CREATE FUNCTION trial_balance(p_company uuid, p_as_of date)
RETURNS TABLE (account_id uuid, code text, name text, type account_type, debit numeric(18,2), credit numeric(18,2))
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT a.id, a.code, a.name, a.type,
         greatest(sum(l.debit) - sum(l.credit), 0)::numeric(18,2),
         greatest(sum(l.credit) - sum(l.debit), 0)::numeric(18,2)
  FROM journal_lines l
  JOIN journal_entries e ON e.id = l.entry_id
  JOIN accounts a ON a.id = l.account_id
  WHERE e.company_id = p_company AND e.entry_date <= p_as_of
  GROUP BY a.id, a.code, a.name, a.type
  HAVING sum(l.debit) <> sum(l.credit)
  ORDER BY a.code
$$;

CREATE FUNCTION profit_and_loss(p_company uuid, p_from date, p_to date)
RETURNS TABLE (income numeric(18,2), expense numeric(18,2), profit numeric(18,2))
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(l.credit - l.debit) FILTER (WHERE a.type = 'income'), 0),
         coalesce(sum(l.debit - l.credit) FILTER (WHERE a.type = 'expense'), 0),
         coalesce(sum(l.credit - l.debit) FILTER (WHERE a.type IN ('income','expense')), 0)
  FROM journal_lines l
  JOIN journal_entries e ON e.id = l.entry_id
  JOIN accounts a ON a.id = l.account_id
  WHERE e.company_id = p_company AND e.entry_date BETWEEN p_from AND p_to
$$;

-- One row per cost centre used, plus a row with NULL cost_centre_id for untagged lines,
-- so the rows always sum to profit_and_loss().
CREATE FUNCTION profit_and_loss_by_cost_centre(p_company uuid, p_from date, p_to date)
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
    AND a.type IN ('income','expense')
  GROUP BY l.cost_centre_id, cc.name
  ORDER BY cc.name NULLS LAST
$$;

-- ---------------------------------------------------------------------------
-- Rule 6: row-level security on every table, enforced for nusuh_app.
-- ---------------------------------------------------------------------------
ALTER TABLE firms           ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies       ENABLE ROW LEVEL SECURITY;
ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships     ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_centres    ENABLE ROW LEVEL SECURITY;
ALTER TABLE periods         ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines   ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log       ENABLE ROW LEVEL SECURITY;

CREATE POLICY firms_read ON firms FOR SELECT USING (id = app_firm_id());

-- Companies: members see their companies; the Administrator sees the firm's client list (not the books).
CREATE POLICY companies_read ON companies FOR SELECT
  USING (id = ANY (app_company_ids()) OR (app_is_admin() AND firm_id = app_firm_id()));
CREATE POLICY companies_admin_insert ON companies FOR INSERT
  WITH CHECK (app_is_admin() AND firm_id = app_firm_id());
CREATE POLICY companies_admin_update ON companies FOR UPDATE
  USING (app_is_admin() AND firm_id = app_firm_id()) WITH CHECK (firm_id = app_firm_id());

-- Users: everyone sees themselves; the Administrator manages the firm's users.
CREATE POLICY users_read ON users FOR SELECT
  USING (id = app_user_id() OR (app_is_admin() AND firm_id = app_firm_id()));
CREATE POLICY users_admin_insert ON users FOR INSERT
  WITH CHECK (app_is_admin() AND firm_id = app_firm_id());
CREATE POLICY users_admin_update ON users FOR UPDATE
  USING (app_is_admin() AND firm_id = app_firm_id()) WITH CHECK (firm_id = app_firm_id());

CREATE POLICY memberships_read ON memberships FOR SELECT
  USING (user_id = app_user_id() OR (app_is_admin()
         AND company_id IN (SELECT id FROM companies WHERE firm_id = app_firm_id())));
CREATE POLICY memberships_admin_insert ON memberships FOR INSERT
  WITH CHECK (app_is_admin() AND company_id IN (SELECT id FROM companies WHERE firm_id = app_firm_id()));
CREATE POLICY memberships_admin_delete ON memberships FOR DELETE
  USING (app_is_admin() AND company_id IN (SELECT id FROM companies WHERE firm_id = app_firm_id()));

-- Chart of accounts and cost centres: members read; posting roles maintain.
CREATE POLICY accounts_read   ON accounts FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY accounts_insert ON accounts FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY accounts_update ON accounts FOR UPDATE
  USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));

CREATE POLICY cost_centres_read   ON cost_centres FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY cost_centres_insert ON cost_centres FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY cost_centres_update ON cost_centres FOR UPDATE
  USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));

-- Periods: posting roles may open (unlocked) periods; only the Firm partner locks or unlocks.
CREATE POLICY periods_read ON periods FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY periods_insert ON periods FOR INSERT WITH CHECK (
  app_has_role(company_id, ARRAY['partner']::user_role[])
  OR (locked_at IS NULL AND app_has_role(company_id, posting_roles())));
CREATE POLICY periods_partner_update ON periods FOR UPDATE
  USING (app_has_role(company_id, ARRAY['partner']::user_role[]))
  WITH CHECK (app_has_role(company_id, ARRAY['partner']::user_role[]));

-- Ledger: members read; posting roles insert. No UPDATE/DELETE policies exist.
CREATE POLICY entries_read   ON journal_entries FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY entries_insert ON journal_entries FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));

CREATE POLICY lines_read ON journal_lines FOR SELECT
  USING (EXISTS (SELECT 1 FROM journal_entries e WHERE e.id = entry_id));   -- entry is itself RLS-filtered
CREATE POLICY lines_insert ON journal_lines FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM journal_entries e
                      WHERE e.id = entry_id AND app_has_role(e.company_id, posting_roles())));

CREATE POLICY audit_read ON audit_log FOR SELECT USING (company_id = ANY (app_company_ids()));

-- ---------------------------------------------------------------------------
-- Grants for the application role (no UPDATE/DELETE on ledger or audit log, no TRUNCATE anywhere)
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO nusuh_app;
GRANT SELECT                 ON firms                      TO nusuh_app;
GRANT SELECT, INSERT, UPDATE ON companies, users           TO nusuh_app;
GRANT SELECT, INSERT, DELETE ON memberships                TO nusuh_app;
GRANT SELECT, INSERT, UPDATE ON accounts, cost_centres     TO nusuh_app;
GRANT SELECT, INSERT, UPDATE ON periods                    TO nusuh_app;
GRANT SELECT, INSERT         ON journal_entries, journal_lines TO nusuh_app;
GRANT SELECT                 ON audit_log                  TO nusuh_app;
