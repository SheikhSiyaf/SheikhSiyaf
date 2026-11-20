-- A host that puts a public web API in front of the database (Supabase: the roles anon, authenticated and service_role)
-- gives those roles every new table, sequence and function in the public schema, where all of Nusuh Books lives. The
-- program talks to the database only as nusuh_app and never through such an API, so those grants are pure exposure:
-- any table without row-level security would be readable and writable from outside, and the helper functions that run
-- with the owner's rights would be callable. This takes the grants back and closes the default, so objects made later
-- stay closed. On a server without those roles it does nothing at all.
DO $$
DECLARE
  r text;
  hosted boolean := false;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    hosted := true;
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
  END LOOP;

  IF hosted THEN
    -- Every function is also executable by PUBLIC unless that is withdrawn, and those roles are members of PUBLIC.
    -- Take it away, give the program's own login what it needs, and make that the default for functions made later.
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO nusuh_app;
    -- Without IN SCHEMA on purpose: PostgreSQL's built-in "PUBLIC may execute new functions" is a global default, and a
    -- schema-only revoke does not remove it (found by the test that makes a function afterwards).
    ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO nusuh_app;
  END IF;
END $$;
