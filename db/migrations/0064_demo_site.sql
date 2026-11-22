-- 0064 The demo site's marker and entry list. A demo site is a SEPARATE deployment with its own database that holds
-- only fictional companies (src/api/demo.ts). These objects exist in every database but do nothing outside a demo one:
--   * demo_marker says "this database was made as a demo database" and which firm holds the demo companies.
--   * demo_entries is the list of client types people can enter (one demo user each).
--   * demo_database_ok() is true only when the marker exists AND no customer other than the platform and the demo
--     firm exists. The moment a real customer is added to such a database, every demo function answers "no".
-- The app's own database role cannot read the two tables at all (no grants, row-level security on, no policies): it can
-- only call the three functions below, and they answer nothing unless demo_database_ok() is true.

CREATE TABLE demo_marker (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  firm_id uuid NOT NULL REFERENCES firms(id),
  seeded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE demo_entries (
  key text PRIMARY KEY CHECK (key ~ '^[a-z]{2,20}$'),
  title text NOT NULL, title_ar text, industry text, blurb text, blurb_ar text,
  user_id uuid NOT NULL REFERENCES users(id),
  company_id uuid REFERENCES companies(id),
  sort int NOT NULL DEFAULT 0
);
ALTER TABLE demo_marker ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON demo_marker, demo_entries FROM PUBLIC;

CREATE FUNCTION demo_database_ok() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM demo_marker)
     AND NOT EXISTS (SELECT 1 FROM firms f WHERE f.kind <> 'platform' AND f.id <> (SELECT firm_id FROM demo_marker))
$$;

CREATE FUNCTION demo_entries_list() RETURNS TABLE (key text, title text, "titleAr" text, industry text, blurb text, "blurbAr" text, sort int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.key, e.title, e.title_ar, e.industry, e.blurb, e.blurb_ar, e.sort FROM demo_entries e WHERE demo_database_ok() ORDER BY e.sort, e.key
$$;

CREATE FUNCTION demo_entry_user(p_key text) RETURNS TABLE (user_id uuid, company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.user_id, e.company_id FROM demo_entries e JOIN users u ON u.id = e.user_id AND u.status = 'active'
  WHERE e.key = p_key AND demo_database_ok()
$$;

REVOKE ALL ON FUNCTION demo_database_ok(), demo_entries_list(), demo_entry_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION demo_database_ok(), demo_entries_list(), demo_entry_user(text) TO nusuh_app;
