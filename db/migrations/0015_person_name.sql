-- 0015: Names of the people who did something (submitted, approved, imported, uploaded) for the people who
-- share a client with them. Row-level security keeps the users table private, so a firm partner cannot read a
-- client accountant's user record; this function returns only the name, and only to someone with a client in common.
CREATE FUNCTION person_name(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.full_name FROM users u
  WHERE u.id = p_user
    AND (u.id = app_user_id() OR EXISTS (
          SELECT 1 FROM memberships a JOIN memberships b ON b.company_id = a.company_id
          WHERE a.user_id = p_user AND b.user_id = app_user_id()))
$$;
GRANT EXECUTE ON FUNCTION person_name(uuid) TO nusuh_app;
