-- 0085 Erasing a removed customer for good (platform owner only).
-- "Remove" (0066) only hides a customer; its books stay and it can be restored. This adds the permanent version, for customers that
-- NEVER USED the books: no entry was ever posted, no document was ever issued, no payment, e-invoice, payroll or month sign-off exists,
-- Nusuh Books never invoiced it and nothing was paid. A customer that has any of those can only be removed (hidden), because posted
-- entries, issued invoices and the audit trail are never deleted.
--
-- What the erase does, in ONE transaction (all or nothing): takes locks on every table that guards its rows, checks again that the customer
-- never used the books, deletes the customer's companies, people and firm with everything that hangs off them (found from the foreign keys,
-- so a table added later is covered too; a row of ANOTHER customer that still points at it stops the whole erase), then leaves one permanent
-- line in erasure_log and in the audit log. The record of who had a free trial (trial_fingerprints) and the owner's sign-up log stay, so the
-- same company number or mailbox cannot be used for a second free trial.

CREATE TABLE erasure_log (
  id            bigserial PRIMARY KEY,
  erased_at     timestamptz NOT NULL DEFAULT now(),
  erased_by     uuid,
  firm_id       uuid NOT NULL,
  firm_name     text NOT NULL,
  firm_kind     text NOT NULL,
  companies     int NOT NULL,
  users         int NOT NULL,
  rows_deleted  bigint NOT NULL
);
ALTER TABLE erasure_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY erasure_log_owner ON erasure_log FOR SELECT USING (app_is_owner());
GRANT SELECT ON erasure_log TO nusuh_app;   -- read only: rows are added by owner_erase_tenant() alone
CREATE TRIGGER erasure_log_immutable BEFORE UPDATE OR DELETE ON erasure_log FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Why a customer cannot be erased: a list of short keys, empty when it can. The owner screen turns them into plain words.
CREATE FUNCTION erase_blockers(p_firm uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b text[] := ARRAY[]::text[];
BEGIN
  IF NOT (app_is_owner() OR app_user_id() IS NULL) THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF EXISTS (SELECT 1 FROM journal_entries e JOIN companies c ON c.id = e.company_id WHERE c.firm_id = p_firm) THEN b := array_append(b, 'entries'); END IF;
  IF EXISTS (SELECT 1 FROM documents d JOIN companies c ON c.id = d.company_id WHERE c.firm_id = p_firm AND d.status <> 'draft') THEN b := array_append(b, 'documents'); END IF;
  IF EXISTS (SELECT 1 FROM payments p JOIN companies c ON c.id = p.company_id WHERE c.firm_id = p_firm) THEN b := array_append(b, 'payments'); END IF;
  IF EXISTS (SELECT 1 FROM einvoices e JOIN companies c ON c.id = e.company_id WHERE c.firm_id = p_firm)
     OR EXISTS (SELECT 1 FROM einvoice_devices e JOIN companies c ON c.id = e.company_id WHERE c.firm_id = p_firm) THEN b := array_append(b, 'einvoices'); END IF;
  IF EXISTS (SELECT 1 FROM payroll_runs r JOIN companies c ON c.id = r.company_id WHERE c.firm_id = p_firm)
     OR EXISTS (SELECT 1 FROM eos_settlements r JOIN companies c ON c.id = r.company_id WHERE c.firm_id = p_firm) THEN b := array_append(b, 'payroll'); END IF;
  IF EXISTS (SELECT 1 FROM review_signoffs r JOIN companies c ON c.id = r.company_id WHERE c.firm_id = p_firm) THEN b := array_append(b, 'signoffs'); END IF;
  IF EXISTS (SELECT 1 FROM billing_invoices WHERE firm_id = p_firm) THEN b := array_append(b, 'billing'); END IF;
  IF EXISTS (SELECT 1 FROM trial_orders WHERE firm_id = p_firm AND status = 'paid')
     OR EXISTS (SELECT 1 FROM online_payments o JOIN companies c ON c.id = o.company_id WHERE c.firm_id = p_firm AND o.status = 'paid') THEN b := array_append(b, 'paid'); END IF;
  RETURN b;
END $$;

-- The engine: deletes the rows of p_tbl that match p_where, after the rows in other tables that point at them (found from the foreign keys).
-- A row that points at one being deleted is only deleted too when it belongs to the same customer (company or firm column); a row of anyone
-- else is left alone, so the foreign key refuses the delete and the whole erase is undone. Returns how many rows went.
CREATE FUNCTION erase_rows(p_tbl regclass, p_where text, p_path oid[], p_firm uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE fk record; n bigint := 0; k bigint; guard text;
BEGIN
  IF NOT (app_is_owner() OR app_user_id() IS NULL) THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  FOR fk IN
    SELECT c.conrelid, ac.attname AS child_col, ap.attname AS parent_col
    FROM pg_constraint c
    JOIN pg_attribute ac ON ac.attrelid = c.conrelid AND ac.attnum = c.conkey[1]
    JOIN pg_attribute ap ON ap.attrelid = c.confrelid AND ap.attnum = c.confkey[1]
    WHERE c.contype = 'f' AND c.confrelid = p_tbl AND c.conrelid <> p_tbl AND NOT (c.conrelid = ANY (p_path))
  LOOP
    guard := '';
    -- An e-mail a person of this customer wrote (a support notice to the platform owner is filed under the platform's own firm) is that person's, wherever it is filed.
    IF fk.conrelid = 'email_outbox'::regclass AND fk.child_col = 'created_by' THEN
      n := n + erase_rows(fk.conrelid, format('%I IN (SELECT %I FROM %s WHERE %s)', fk.child_col, fk.parent_col, p_tbl, p_where), p_path || p_tbl::oid, p_firm);
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = fk.conrelid AND attname = 'company_id' AND NOT attisdropped) THEN
      guard := guard || format(' AND (company_id IS NULL OR company_id IN (SELECT id FROM companies WHERE firm_id = %L))', p_firm);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = fk.conrelid AND attname = 'firm_id' AND NOT attisdropped) THEN
      guard := guard || format(' AND (firm_id IS NULL OR firm_id = %L)', p_firm);
    END IF;
    n := n + erase_rows(fk.conrelid, format('%I IN (SELECT %I FROM %s WHERE %s)%s', fk.child_col, fk.parent_col, p_tbl, p_where, guard), p_path || p_tbl::oid, p_firm);
  END LOOP;
  EXECUTE format('DELETE FROM %s WHERE %s', p_tbl, p_where);
  GET DIAGNOSTICS k = ROW_COUNT;
  RETURN n + k;
END $$;

CREATE FUNCTION erase_firm_data(p_firm uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t regclass; locked regclass[] := ARRAY[]::regclass[]; total bigint := 0;
BEGIN
  IF NOT (app_is_owner() OR app_user_id() IS NULL) THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  PERFORM set_config('lock_timeout', '10s', true);   -- give up cleanly rather than wait for ever behind somebody else
  -- The rules that stop a posted record being deleted are triggers. For the length of this one transaction they are switched off on the
  -- tables that have them, under an exclusive lock (nobody else can read or write those tables meanwhile). The database's own foreign key
  -- checks stay on. Everything is switched back on before the transaction ends, and undone with it if anything fails.
  FOR t IN SELECT DISTINCT c.oid::regclass FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
           WHERE NOT g.tgisinternal AND (g.tgtype & 8) = 8 AND c.relnamespace = 'public'::regnamespace AND c.relname NOT IN ('audit_log', 'erasure_log') LOOP
    EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', t);
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER', t);
    locked := locked || t;
  END LOOP;
  -- checked again now that nobody can add a row behind our back
  IF cardinality(erase_blockers(p_firm)) > 0 THEN RAISE EXCEPTION 'This customer has used the books and cannot be erased.'; END IF;
  total := total + erase_rows('companies'::regclass, format('firm_id = %L', p_firm), ARRAY[]::oid[], p_firm);
  total := total + erase_rows('users'::regclass, format('firm_id = %L', p_firm), ARRAY[]::oid[], p_firm);
  total := total + erase_rows('firms'::regclass, format('id = %L', p_firm), ARRAY[]::oid[], p_firm);
  FOREACH t IN ARRAY locked LOOP EXECUTE format('ALTER TABLE %s ENABLE TRIGGER USER', t); END LOOP;
  RETURN total;
END $$;

-- The owner's action. p_confirm must be the customer's exact name. Returns what was erased.
CREATE FUNCTION owner_erase_tenant(p_firm uuid, p_confirm text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f firms%ROWTYPE; nco int; nus int; total bigint;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  SELECT * INTO f FROM firms WHERE id = p_firm AND kind <> 'platform' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found.'; END IF;
  IF f.removed_at IS NULL THEN RAISE EXCEPTION 'Remove the customer first.'; END IF;
  IF btrim(coalesce(p_confirm, '')) <> f.name THEN RAISE EXCEPTION 'Type the customer''s name exactly to confirm.'; END IF;
  SELECT count(*) INTO nco FROM companies WHERE firm_id = p_firm;
  SELECT count(*) INTO nus FROM users WHERE firm_id = p_firm;
  total := erase_firm_data(p_firm);
  INSERT INTO erasure_log (erased_by, firm_id, firm_name, firm_kind, companies, users, rows_deleted) VALUES (app_user_id(), p_firm, f.name, f.kind, nco, nus, total);
  INSERT INTO audit_log (user_id, company_id, table_name, row_id, action, detail)
    VALUES (app_user_id(), NULL, 'firms', p_firm::text, 'erase', jsonb_build_object('name', f.name, 'kind', f.kind, 'companies', nco, 'users', nus, 'rows', total));
  RETURN jsonb_build_object('name', f.name, 'companies', nco, 'users', nus, 'rows', total);
END $$;

-- The owner's list says whether each removed customer can be erased.
DROP FUNCTION owner_tenants();
CREATE FUNCTION owner_tenants() RETURNS TABLE (id uuid, name text, kind text, status text, created_at timestamptz, companies int, users int, admins text, removed_at timestamptz, erase_blockers text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  RETURN QUERY
  SELECT f.id, f.name, f.kind, f.status, f.created_at,
         (SELECT count(*) FROM companies c WHERE c.firm_id = f.id)::int,
         (SELECT count(*) FROM users u WHERE u.firm_id = f.id AND u.status = 'active')::int,
         (SELECT string_agg(u.full_name, ', ' ORDER BY u.full_name) FROM users u WHERE u.firm_id = f.id AND u.kind = 'admin'),
         f.removed_at,
         CASE WHEN f.removed_at IS NULL THEN NULL ELSE erase_blockers(f.id) END
  FROM firms f WHERE f.kind <> 'platform' ORDER BY f.name;
END $$;
GRANT EXECUTE ON FUNCTION owner_tenants() TO nusuh_app;

REVOKE ALL ON FUNCTION erase_blockers(uuid), erase_rows(regclass, text, oid[], uuid), erase_firm_data(uuid), owner_erase_tenant(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_blockers(uuid), owner_erase_tenant(uuid, text) TO nusuh_app;   -- the engine itself is not callable by the app
