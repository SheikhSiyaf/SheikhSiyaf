-- 0066 Removing a customer (platform owner only).
-- A customer's books and the audit log can never be deleted (posted entries are permanent), so "remove" means: the customer
-- disappears from the owner's list, nobody in it can sign in, its subscription is cancelled, and everything stays on file so it
-- can be restored. It is the same lock as Suspend (status 'suspended') plus a date the customer was removed.

ALTER TABLE firms ADD COLUMN removed_at timestamptz;

-- The list now says when a customer was removed.
DROP FUNCTION owner_tenants();
CREATE FUNCTION owner_tenants() RETURNS TABLE (id uuid, name text, kind text, status text, created_at timestamptz, companies int, users int, admins text, removed_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  RETURN QUERY
  SELECT f.id, f.name, f.kind, f.status, f.created_at,
         (SELECT count(*) FROM companies c WHERE c.firm_id = f.id)::int,
         (SELECT count(*) FROM users u WHERE u.firm_id = f.id AND u.status = 'active')::int,
         (SELECT string_agg(u.full_name, ', ' ORDER BY u.full_name) FROM users u WHERE u.firm_id = f.id AND u.kind = 'admin'),
         f.removed_at
  FROM firms f WHERE f.kind <> 'platform' ORDER BY f.name;
END $$;
GRANT EXECUTE ON FUNCTION owner_tenants() TO nusuh_app;

-- Reactivating a customer in the old way also ends its "removed" state, so the two never disagree.
CREATE OR REPLACE FUNCTION owner_update_tenant(p_id uuid, p_name text, p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF p_status NOT IN ('active', 'suspended') OR btrim(coalesce(p_name, '')) = '' THEN RAISE EXCEPTION 'Enter the name and status.'; END IF;
  UPDATE firms SET name = btrim(p_name), status = p_status, removed_at = CASE WHEN p_status = 'active' THEN NULL ELSE removed_at END
  WHERE id = p_id AND kind <> 'platform';
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found.'; END IF;
END $$;

-- Remove (p_removed true) or restore (false). Removing also cancels the subscription so nothing more is billed; the invoices
-- already made stay, and restoring does not bring the subscription back (the owner starts a new one).
CREATE FUNCTION owner_remove_tenant(p_id uuid, p_removed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  UPDATE firms SET status = CASE WHEN p_removed THEN 'suspended' ELSE 'active' END,
                   removed_at = CASE WHEN p_removed THEN coalesce(removed_at, now()) ELSE NULL END
  WHERE id = p_id AND kind <> 'platform';
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found.'; END IF;
  IF p_removed THEN UPDATE subscriptions SET status = 'cancelled' WHERE firm_id = p_id AND status <> 'cancelled'; END IF;
END $$;
REVOKE EXECUTE ON FUNCTION owner_remove_tenant(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION owner_remove_tenant(uuid, boolean) TO nusuh_app;
