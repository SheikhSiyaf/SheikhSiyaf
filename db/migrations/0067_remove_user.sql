-- 0067 Removing a user (an Administrator removes their own people; Nusuh Books can also remove an Administrator).
-- A person's name stays on every entry, invoice and log line they ever made (posted entries and the audit log are never
-- deleted, so the person row cannot be deleted either). "Remove" therefore means: they cannot sign in, any sign-in link they
-- were given stops working, and they disappear from the lists; "Restore" lets them in again. The same lock as Suspend, plus a
-- date, so the lists can hide removed people.

ALTER TABLE users ADD COLUMN removed_at timestamptz;

CREATE FUNCTION admin_remove_user(p_user uuid, p_removed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u users%ROWTYPE;
BEGIN
  IF NOT app_is_admin() THEN RAISE EXCEPTION 'Only the Administrator can do this.'; END IF;
  SELECT * INTO u FROM users WHERE id = p_user AND firm_id = app_firm_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found.'; END IF;
  IF u.id = app_user_id() THEN RAISE EXCEPTION 'You cannot remove yourself.'; END IF;
  IF u.kind = 'owner' THEN RAISE EXCEPTION 'Not found.'; END IF;
  IF u.kind = 'admin' THEN
    IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only Nusuh Books can remove an Administrator.'; END IF;
    IF p_removed AND NOT EXISTS (SELECT 1 FROM users a WHERE a.firm_id = u.firm_id AND a.kind = 'admin' AND a.status = 'active' AND a.id <> u.id) THEN
      RAISE EXCEPTION 'Keep at least one Administrator: add another before removing this one.';
    END IF;
  END IF;
  UPDATE users SET status = CASE WHEN p_removed THEN 'suspended' ELSE 'active' END,
                   removed_at = CASE WHEN p_removed THEN coalesce(removed_at, now()) ELSE NULL END,
                   invite_token_hash = CASE WHEN p_removed THEN NULL ELSE invite_token_hash END,
                   invite_expires_at = CASE WHEN p_removed THEN NULL ELSE invite_expires_at END
  WHERE id = p_user;
END $$;
REVOKE EXECUTE ON FUNCTION admin_remove_user(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_remove_user(uuid, boolean) TO nusuh_app;
