-- 0004: what the Administrator console needs.
--   * Suspend and reactivate users and clients (never delete: the audit trail must stay whole).
--   * Invitations: a one-time link lets a new user set their own password.
--   * Two-factor sign-in: each user stores their own (encrypted) authenticator secret.
--   * The Administrator can rename the firm and read an activity log of client, user and access
--     changes, without ever seeing the books.

ALTER TABLE users
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  ADD COLUMN invite_token_hash text,
  ADD COLUMN invite_expires_at timestamptz,
  ADD COLUMN password_set_at timestamptz,
  ADD COLUMN totp_enabled_at timestamptz;
UPDATE users SET password_set_at = created_at WHERE password_hash IS NOT NULL;
UPDATE users SET totp_enabled_at = created_at WHERE totp_secret_enc IS NOT NULL;
CREATE UNIQUE INDEX users_invite_token ON users (invite_token_hash) WHERE invite_token_hash IS NOT NULL;

ALTER TABLE companies
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended'));

-- ---------------------------------------------------------------------------
-- Suspended users and suspended clients lose access everywhere, enforced in the database.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_company_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(m.company_id), '{}')
  FROM memberships m
  JOIN users u ON u.id = m.user_id AND u.status = 'active'
  JOIN companies c ON c.id = m.company_id AND c.status = 'active'
  WHERE m.user_id = app_user_id()
$$;

CREATE OR REPLACE FUNCTION app_has_role(p_company uuid, p_roles user_role[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships m
    JOIN users u ON u.id = m.user_id AND u.status = 'active'
    JOIN companies c ON c.id = m.company_id AND c.status = 'active'
    WHERE m.user_id = app_user_id() AND m.company_id = p_company AND m.role = ANY (p_roles))
$$;

CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE id = app_user_id() AND kind = 'admin' AND status = 'active')
$$;

-- Login lookup now also says whether the user is suspended.
DROP FUNCTION auth_user_by_email(text);
CREATE FUNCTION auth_user_by_email(p_email text)
RETURNS TABLE (id uuid, kind user_kind, status text, password_hash text, totp_secret_enc text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.kind, u.status, u.password_hash, u.totp_secret_enc FROM users u WHERE lower(u.email) = lower(p_email)
$$;

-- ---------------------------------------------------------------------------
-- Invitations. The app stores only a SHA-256 hash of the token; the link holds the token itself.
-- ---------------------------------------------------------------------------
CREATE FUNCTION invite_info(p_token_hash text) RETURNS TABLE (full_name text, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.full_name, u.email FROM users u
  WHERE u.invite_token_hash = p_token_hash AND u.invite_expires_at > now() AND u.status = 'active'
$$;

CREATE FUNCTION accept_invite(p_token_hash text, p_password_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE uid uuid;
BEGIN
  SELECT id INTO uid FROM users
  WHERE invite_token_hash = p_token_hash AND invite_expires_at > now() AND status = 'active';
  IF uid IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.user_id', uid::text, true);   -- the audit log records the user themselves
  UPDATE users SET password_hash = p_password_hash, password_set_at = now(),
                   invite_token_hash = NULL, invite_expires_at = NULL
  WHERE id = uid;
  RETURN true;
END $$;

-- Two-factor: a signed-in user turns it on for themselves; only the Administrator can reset it.
CREATE FUNCTION set_own_totp(p_secret_enc text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_secret_enc IS NULL OR p_secret_enc = '' THEN
    RAISE EXCEPTION 'Two-factor sign-in can only be turned off by the Administrator.';
  END IF;
  UPDATE users SET totp_secret_enc = p_secret_enc, totp_enabled_at = now()
  WHERE id = app_user_id() AND status = 'active';
END $$;

-- ---------------------------------------------------------------------------
-- Firm settings and the Administrator's activity log
-- ---------------------------------------------------------------------------
CREATE POLICY firms_admin_update ON firms FOR UPDATE
  USING (app_is_admin() AND id = app_firm_id()) WITH CHECK (id = app_firm_id());
GRANT UPDATE (name) ON firms TO nusuh_app;

-- Audit: also log firm changes, and never copy invitation tokens into the log.
CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb; o jsonb; act text; cid uuid; rid text;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  o := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
  IF TG_TABLE_NAME = 'users' THEN   -- never copy secrets into the log
    r := r - 'password_hash' - 'totp_secret_enc' - 'invite_token_hash';
    o := o - 'password_hash' - 'totp_secret_enc' - 'invite_token_hash';
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
           WHEN 'firms' THEN NULL
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
CREATE TRIGGER firms_audit AFTER INSERT OR UPDATE OR DELETE ON firms FOR EACH ROW EXECUTE FUNCTION audit_row();

-- Client, user, access and firm changes for the Administrator's own firm. Never ledger rows.
CREATE FUNCTION admin_activity(p_limit int DEFAULT 200)
RETURNS TABLE (id bigint, at timestamptz, actor text, table_name text, action text, company text, detail jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid := app_firm_id();
BEGIN
  IF NOT app_is_admin() THEN
    RAISE EXCEPTION 'Only the Administrator can do this.';
  END IF;
  RETURN QUERY
  SELECT a.id, a.at, u.full_name, a.table_name, a.action, c.name, a.detail
  FROM audit_log a
  LEFT JOIN users u ON u.id = a.user_id
  LEFT JOIN companies c ON c.id = coalesce(a.company_id, (coalesce(a.detail->'after', a.detail->'row')->>'company_id')::uuid)
  WHERE a.table_name IN ('companies', 'users', 'memberships', 'firms')
    AND (c.firm_id = f
         OR (coalesce(a.detail->'after', a.detail->'row')->>'firm_id')::uuid = f
         OR (a.table_name = 'firms' AND a.row_id = f::text))
  ORDER BY a.id DESC
  LIMIT least(greatest(p_limit, 1), 500);
END $$;

REVOKE ALL ON FUNCTION invite_info(text), accept_invite(text, text), set_own_totp(text), admin_activity(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invite_info(text), accept_invite(text, text), set_own_totp(text), admin_activity(int) TO nusuh_app;
