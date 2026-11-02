-- 0003: set up a new client's books. The Administrator registers clients but has no posting role
-- (and never sees the books), so copying the chart of accounts template runs as a checked,
-- SECURITY DEFINER function instead of through the posting policies.

CREATE FUNCTION setup_company_books(p_company uuid, p_accounts jsonb, p_year int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE m int;
BEGIN
  IF NOT app_is_admin() OR NOT EXISTS (SELECT 1 FROM companies WHERE id = p_company AND firm_id = app_firm_id()) THEN
    RAISE EXCEPTION 'Only the Administrator can set up a client''s books.';
  END IF;
  IF EXISTS (SELECT 1 FROM accounts WHERE company_id = p_company) THEN
    RAISE EXCEPTION 'This client''s books are already set up.';
  END IF;

  INSERT INTO accounts (company_id, code, name, name_ar, type, cost_centre_required)
  SELECT p_company, a->>'code', a->>'name', a->>'nameAr', (a->>'type')::account_type,
         coalesce((a->>'costCentreRequired')::boolean, false)
  FROM jsonb_array_elements(p_accounts) a;

  INSERT INTO cost_centres (company_id, kind, name, name_ar) VALUES (p_company, 'branch', 'Head office', 'المكتب الرئيسي');

  FOR m IN 1..12 LOOP
    INSERT INTO periods (company_id, start_date, end_date)
    VALUES (p_company, make_date(p_year, m, 1), (make_date(p_year, m, 1) + interval '1 month - 1 day')::date);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION setup_company_books(uuid, jsonb, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION setup_company_books(uuid, jsonb, int) TO nusuh_app;
