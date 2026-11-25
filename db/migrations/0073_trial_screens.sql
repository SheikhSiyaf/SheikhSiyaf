-- 0073 What the "your trial has ended" screen needs: which optional modules the customer has switched on.
-- The screen tells the customer plainly which optional modules stay on only if bought. Any person of the customer may ask (it is
-- their own customer's module names, nothing about anyone's books); the platform owner and nobody-signed-in get nothing.

CREATE FUNCTION my_trial_modules() RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(DISTINCT m ORDER BY m), ARRAY[]::text[])
  FROM companies c, unnest(c.modules) m
  WHERE app_user_id() IS NOT NULL AND NOT app_is_owner() AND c.firm_id = app_firm_id() AND c.status = 'active'
    AND m IN ('Inventory', 'Restaurant', 'Rooms', 'Assets', 'Rentals', 'Projects', 'HRM', 'CRM')
$$;
REVOKE ALL ON FUNCTION my_trial_modules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_trial_modules() TO nusuh_app;
