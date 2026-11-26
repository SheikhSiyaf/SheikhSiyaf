-- 0085's erase took an ACCESS EXCLUSIVE lock on every table that guards its rows before switching the guarding triggers off. That blocks even plain
-- reads, and two ordinary requests that read tables in a different order could deadlock with it ("deadlock detected" in the test suite). Switching
-- triggers off needs only SHARE ROW EXCLUSIVE, which the ALTER TABLE itself takes: readers carry on, writers to those tables wait until the
-- erase finishes (so nothing can be written behind its back), and the tables are taken in one fixed order so two erases cannot deadlock each other.
CREATE OR REPLACE FUNCTION erase_firm_data(p_firm uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t regclass; locked regclass[] := ARRAY[]::regclass[]; total bigint := 0;
BEGIN
  IF NOT (app_is_owner() OR app_user_id() IS NULL) THEN RAISE EXCEPTION 'Only the server does this.'; END IF;
  PERFORM set_config('lock_timeout', '10s', true);   -- give up cleanly rather than wait for ever behind somebody else
  FOR t IN SELECT c.oid::regclass FROM pg_class c
           WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname NOT IN ('audit_log', 'erasure_log')
             AND EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND NOT g.tgisinternal AND (g.tgtype & 8) = 8)
           ORDER BY c.oid LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER', t);   -- SHARE ROW EXCLUSIVE: reads go on, writes wait for this transaction
    locked := locked || t;
  END LOOP;
  -- checked again now that nobody can write behind our back
  IF cardinality(erase_blockers(p_firm)) > 0 THEN RAISE EXCEPTION 'This customer has used the books and cannot be erased.'; END IF;
  total := total + erase_rows('companies'::regclass, format('firm_id = %L', p_firm), ARRAY[]::oid[], p_firm);
  total := total + erase_rows('users'::regclass, format('firm_id = %L', p_firm), ARRAY[]::oid[], p_firm);
  total := total + erase_rows('firms'::regclass, format('id = %L', p_firm), ARRAY[]::oid[], p_firm);
  FOREACH t IN ARRAY locked LOOP EXECUTE format('ALTER TABLE %s ENABLE TRIGGER USER', t); END LOOP;
  RETURN total;
END $$;
