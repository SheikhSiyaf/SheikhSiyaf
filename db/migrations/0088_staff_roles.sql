-- 0088 Platform staff: roles, and what each role may open in the owner workspace.
--
-- Until now every person on the platform was "the owner" with full rights. This adds the staff of Nusuh Books itself (not customers):
--   * staff_permissions: the fixed list of things a role can be allowed to do, grouped in workspaces (customers, billing, payments, ...).
--   * staff_roles: named sets of permissions. Built-in roles (Owner, Accountant, Reviewer, HR, Support, Viewer) plus roles the owner creates.
--   * users.staff_role_id: every platform person (kind 'owner') has exactly one role.
--
-- Safe by default: app_is_owner() (used by the ~80 existing owner-only functions) is now true ONLY for a person whose role has full access.
-- A person with any other role passes none of those old checks; they can only do what a function checks with app_staff_can('code').
-- The two existing owners are given the Owner role, so nothing changes for them.
-- Guards (enforced here, not only in the screen): the last active full-access person can never be demoted, suspended or removed; nobody
-- changes their own role or status; only full-access people manage staff; built-in roles are never edited or deleted.

CREATE TABLE staff_permissions (
  code      text PRIMARY KEY CHECK (code ~ '^[a-z]+\.[a-z]+$'),
  workspace text NOT NULL,
  label_en  text NOT NULL,
  label_ar  text NOT NULL,
  sort      int  NOT NULL
);
INSERT INTO staff_permissions (code, workspace, label_en, label_ar, sort) VALUES
  ('customers.view',   'customers', 'See customers and trials',               'عرض العملاء والتجارب', 10),
  ('customers.manage', 'customers', 'Change customers and trials',            'تعديل العملاء والتجارب', 11),
  ('billing.view',     'billing',   'See plans, subscriptions and invoices',  'عرض الباقات والاشتراكات والفواتير', 20),
  ('billing.manage',   'billing',   'Change plans, prices and invoices',      'تعديل الباقات والأسعار والفواتير', 21),
  ('payments.view',    'payments',  'See payments and the review queue',      'عرض المدفوعات وقائمة المراجعة', 30),
  ('payments.review',  'payments',  'Approve or reject payments',             'اعتماد المدفوعات أو رفضها', 31),
  ('payments.settings','payments',  'Change bank details and payment rules',  'تعديل البيانات البنكية وقواعد الدفع', 32),
  ('support.view',     'support',   'Read customer support chats',            'قراءة محادثات الدعم', 40),
  ('support.manage',   'support',   'Answer customer support chats',          'الرد على محادثات الدعم', 41),
  ('website.manage',   'website',   'Change website prices and testimonials', 'تعديل أسعار الموقع وآراء العملاء', 50),
  ('reports.view',     'reports',   'See platform summaries',                 'عرض ملخصات المنصة', 60);

CREATE TABLE staff_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 60),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  is_full     boolean NOT NULL DEFAULT false,   -- the Owner role: passes every owner-only check
  built_in    boolean NOT NULL DEFAULT false,
  archived    boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_full OR built_in)               -- only the built-in Owner role has full access
);
CREATE UNIQUE INDEX staff_roles_name_unique ON staff_roles (lower(btrim(name)));
CREATE UNIQUE INDEX staff_roles_one_full ON staff_roles (is_full) WHERE is_full;

CREATE TABLE staff_role_grants (
  role_id    uuid NOT NULL REFERENCES staff_roles(id) ON DELETE CASCADE,
  permission text NOT NULL REFERENCES staff_permissions(code),
  PRIMARY KEY (role_id, permission)
);

INSERT INTO staff_roles (name, description, is_full, built_in) VALUES
  ('Owner',      'Full access, including staff and settings.', true, true),
  ('Accountant', 'Billing and payments: sees and changes invoices, reviews payments.', false, true),
  ('Reviewer',   'Reviews and approves payments. Cannot change settings.', false, true),
  ('HR',         'Sees customers; manages nothing else.', false, true),
  ('Support',    'Answers customer chats and sees customers.', false, true),
  ('Viewer',     'Read-only view of customers, billing, payments and summaries.', false, true);
INSERT INTO staff_role_grants (role_id, permission)
SELECT r.id, p FROM staff_roles r, unnest(CASE r.name
  WHEN 'Accountant' THEN ARRAY['customers.view','billing.view','billing.manage','payments.view','payments.review','reports.view']
  WHEN 'Reviewer'   THEN ARRAY['payments.view','payments.review']
  WHEN 'HR'         THEN ARRAY['customers.view']
  WHEN 'Support'    THEN ARRAY['customers.view','support.view','support.manage']
  WHEN 'Viewer'     THEN ARRAY['customers.view','billing.view','payments.view','reports.view']
  ELSE ARRAY[]::text[] END) p
WHERE r.built_in AND NOT r.is_full;

ALTER TABLE users ADD COLUMN staff_role_id uuid REFERENCES staff_roles(id);
UPDATE users SET staff_role_id = (SELECT id FROM staff_roles WHERE is_full) WHERE kind = 'owner';

-- Only platform people have a role; a platform person with none (a new row made outside the app, such as test set-up) is given the Owner role,
-- exactly as before this migration. The app itself always names the role (staff_member_add).
CREATE FUNCTION before_user_staff_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.kind = 'owner' AND NEW.staff_role_id IS NULL THEN NEW.staff_role_id := (SELECT id FROM staff_roles WHERE is_full); END IF;
  IF NEW.kind <> 'owner' AND NEW.staff_role_id IS NOT NULL THEN RAISE EXCEPTION 'Only platform staff have a staff role.'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_staff_role BEFORE INSERT OR UPDATE OF kind, staff_role_id ON users FOR EACH ROW EXECUTE FUNCTION before_user_staff_role();

-- A person's role (and their kind) can be changed only by the staff functions below, never by a direct UPDATE from the app. This trigger runs as the
-- caller (it is not SECURITY DEFINER), so current_user is nusuh_app for a direct statement and the function owner inside the staff functions.
CREATE FUNCTION guard_user_staff_role() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'nusuh_app' AND NEW.staff_role_id IS DISTINCT FROM OLD.staff_role_id THEN RAISE EXCEPTION 'A staff role is changed only through the staff screen.'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_staff_role_guard BEFORE UPDATE OF staff_role_id ON users FOR EACH ROW EXECUTE FUNCTION guard_user_staff_role();

-- Full access now means: an active platform person whose role is the Owner role.
CREATE OR REPLACE FUNCTION app_is_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM users u JOIN staff_roles r ON r.id = u.staff_role_id
                  WHERE u.id = app_user_id() AND u.kind = 'owner' AND u.status = 'active' AND u.removed_at IS NULL AND r.is_full)
$$;

/** Is this person an active member of the platform staff whose role includes this permission (or is the Owner role)? */
CREATE FUNCTION app_staff_can(p_code text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM users u JOIN staff_roles r ON r.id = u.staff_role_id
                  WHERE u.id = app_user_id() AND u.kind = 'owner' AND u.status = 'active' AND u.removed_at IS NULL AND NOT r.archived
                    AND (r.is_full OR EXISTS (SELECT 1 FROM staff_role_grants g WHERE g.role_id = r.id AND g.permission = p_code)))
$$;

/** The signed-in staff person's own role and permissions (what the screen shows). Anyone else gets nothing. */
CREATE FUNCTION my_staff_access() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('role', r.name, 'full', r.is_full,
    'permissions', CASE WHEN r.is_full THEN (SELECT coalesce(jsonb_agg(code ORDER BY sort), '[]') FROM staff_permissions)
                        ELSE (SELECT coalesce(jsonb_agg(g.permission ORDER BY p.sort), '[]') FROM staff_role_grants g JOIN staff_permissions p ON p.code = g.permission WHERE g.role_id = r.id) END)
    FROM users u JOIN staff_roles r ON r.id = u.staff_role_id
   WHERE u.id = app_user_id() AND u.kind = 'owner' AND u.status = 'active' AND u.removed_at IS NULL
$$;

/** Roles with their permissions and how many active people hold each (full-access people only). */
CREATE FUNCTION staff_roles_list() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  RETURN jsonb_build_object(
    'permissions', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', code, 'workspace', workspace, 'labelEn', label_en, 'labelAr', label_ar) ORDER BY sort), '[]') FROM staff_permissions),
    'roles', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'description', r.description, 'full', r.is_full, 'builtIn', r.built_in, 'archived', r.archived,
      'people', (SELECT count(*) FROM users u WHERE u.staff_role_id = r.id AND u.removed_at IS NULL),
      'permissions', (SELECT coalesce(jsonb_agg(g.permission ORDER BY g.permission), '[]') FROM staff_role_grants g WHERE g.role_id = r.id)) ORDER BY r.is_full DESC, r.built_in DESC, r.name), '[]') FROM staff_roles r));
END $$;

/** Create (p_id null) or change a role the owner made. Built-in roles and the Owner role are never changed here. */
CREATE FUNCTION staff_role_save(p_id uuid, p_name text, p_description text, p_permissions text[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE rid uuid; perms text[]; r staff_roles;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF char_length(btrim(coalesce(p_name, ''))) < 2 OR char_length(btrim(p_name)) > 60 THEN RAISE EXCEPTION 'Give the role a name (2 to 60 letters).'; END IF;
  perms := coalesce(ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_permissions, ARRAY[]::text[])) x ORDER BY x), ARRAY[]::text[]);
  IF EXISTS (SELECT 1 FROM unnest(perms) x WHERE x NOT IN (SELECT code FROM staff_permissions)) THEN RAISE EXCEPTION 'Choose permissions from the list.'; END IF;
  -- a role that can change things also needs to see them
  IF ('customers.manage' = ANY (perms) AND NOT 'customers.view' = ANY (perms)) OR ('billing.manage' = ANY (perms) AND NOT 'billing.view' = ANY (perms))
     OR (('payments.review' = ANY (perms) OR 'payments.settings' = ANY (perms)) AND NOT 'payments.view' = ANY (perms))
     OR ('support.manage' = ANY (perms) AND NOT 'support.view' = ANY (perms)) THEN
    RAISE EXCEPTION 'A role that can change something must also be able to see it.';
  END IF;
  IF p_id IS NULL THEN
    BEGIN
      INSERT INTO staff_roles (name, description, created_by) VALUES (btrim(p_name), left(coalesce(p_description, ''), 300), app_user_id()) RETURNING id INTO rid;
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'A role with this name exists already.'; END;
  ELSE
    SELECT * INTO r FROM staff_roles WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Role not found.'; END IF;
    IF r.built_in THEN RAISE EXCEPTION 'Built-in roles cannot be changed. Make a new role instead.'; END IF;
    BEGIN
      UPDATE staff_roles SET name = btrim(p_name), description = left(coalesce(p_description, ''), 300) WHERE id = p_id;
    EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'A role with this name exists already.'; END;
    DELETE FROM staff_role_grants WHERE role_id = p_id;
    rid := p_id;
  END IF;
  INSERT INTO staff_role_grants (role_id, permission) SELECT rid, x FROM unnest(perms) x;
  RETURN rid;
END $$;

/** Retire a role the owner made. Refused while anyone still holds it. */
CREATE FUNCTION staff_role_archive(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r staff_roles;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  SELECT * INTO r FROM staff_roles WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Role not found.'; END IF;
  IF r.built_in THEN RAISE EXCEPTION 'Built-in roles cannot be removed.'; END IF;
  IF EXISTS (SELECT 1 FROM users WHERE staff_role_id = p_id AND removed_at IS NULL) THEN RAISE EXCEPTION 'Move the people in this role to another role first.'; END IF;
  UPDATE staff_roles SET archived = true WHERE id = p_id;
END $$;

/** All staff people with their role and status. */
CREATE FUNCTION staff_members() RETURNS TABLE (id uuid, full_name text, email text, status text, role_id uuid, role_name text, is_full boolean, is_me boolean, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  RETURN QUERY SELECT u.id, u.full_name, u.email, u.status, r.id, r.name, r.is_full, u.id = app_user_id(), u.created_at
    FROM users u JOIN staff_roles r ON r.id = u.staff_role_id WHERE u.kind = 'owner' AND u.removed_at IS NULL ORDER BY r.is_full DESC, lower(u.full_name);
END $$;

-- The platform must never be left without an active full-access person (counted AFTER the change, with the rows locked).
CREATE FUNCTION staff_keep_one_owner(p_except uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM users u JOIN staff_roles r ON r.id = u.staff_role_id WHERE u.kind = 'owner' AND r.is_full FOR UPDATE OF u;
  IF NOT EXISTS (SELECT 1 FROM users u JOIN staff_roles r ON r.id = u.staff_role_id
                  WHERE u.kind = 'owner' AND r.is_full AND u.status = 'active' AND u.removed_at IS NULL AND u.id <> p_except) THEN
    RAISE EXCEPTION 'There must always be at least one active person with the Owner role.';
  END IF;
END $$;

/** Add a staff person. The caller sends the sign-in invitation. */
CREATE FUNCTION staff_member_add(p_name text, p_email text, p_role uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE uid uuid; r staff_roles;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF btrim(coalesce(p_name, '')) = '' OR p_email IS NULL OR p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'Enter the name and email.'; END IF;
  SELECT * INTO r FROM staff_roles WHERE id = p_role AND NOT archived;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose a role.'; END IF;
  IF EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(btrim(p_email))) THEN RAISE EXCEPTION 'This email is already used.'; END IF;
  INSERT INTO users (firm_id, kind, full_name, email, staff_role_id)
  VALUES ((SELECT id FROM firms WHERE kind = 'platform'), 'owner', left(btrim(p_name), 120), btrim(p_email), r.id) RETURNING id INTO uid;
  RETURN uid;
END $$;

/** Change a person's name or email. Not your own role or status; an email change signs the person out everywhere (new session version). */
CREATE FUNCTION staff_member_update(p_user uuid, p_name text, p_email text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u users;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  SELECT * INTO u FROM users WHERE id = p_user AND kind = 'owner' AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Person not found.'; END IF;
  IF btrim(coalesce(p_name, '')) = '' OR p_email IS NULL OR p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'Enter the name and email.'; END IF;
  IF lower(btrim(p_email)) <> lower(u.email) AND EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(btrim(p_email))) THEN RAISE EXCEPTION 'This email is already used.'; END IF;
  UPDATE users SET full_name = left(btrim(p_name), 120), email = btrim(p_email),
         session_version = CASE WHEN lower(btrim(p_email)) <> lower(u.email) THEN session_version + 1 ELSE session_version END
   WHERE id = p_user;
END $$;

/** Give a person another role. Never your own; never leaves the platform without an Owner. Signs the person out everywhere. */
CREATE FUNCTION staff_member_set_role(p_user uuid, p_role uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u users; cur staff_roles; nxt staff_roles;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF p_user = app_user_id() THEN RAISE EXCEPTION 'You cannot change your own role. Ask another owner.'; END IF;
  SELECT * INTO u FROM users WHERE id = p_user AND kind = 'owner' AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Person not found.'; END IF;
  SELECT * INTO nxt FROM staff_roles WHERE id = p_role AND NOT archived;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose a role.'; END IF;
  SELECT * INTO cur FROM staff_roles WHERE id = u.staff_role_id;
  IF cur.is_full AND NOT nxt.is_full THEN PERFORM staff_keep_one_owner(p_user); END IF;
  UPDATE users SET staff_role_id = nxt.id, session_version = session_version + 1 WHERE id = p_user;
END $$;

/** Suspend or restore a person. Never yourself; never the last Owner. A suspended person is signed out everywhere. */
CREATE FUNCTION staff_member_set_status(p_user uuid, p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u users;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF p_status NOT IN ('active', 'suspended') THEN RAISE EXCEPTION 'Choose active or suspended.'; END IF;
  IF p_user = app_user_id() THEN RAISE EXCEPTION 'You cannot change your own access. Ask another owner.'; END IF;
  SELECT * INTO u FROM users WHERE id = p_user AND kind = 'owner' AND removed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Person not found.'; END IF;
  IF p_status = 'suspended' AND (SELECT is_full FROM staff_roles WHERE id = u.staff_role_id) THEN PERFORM staff_keep_one_owner(p_user); END IF;
  UPDATE users SET status = p_status, session_version = session_version + 1 WHERE id = p_user;
END $$;

/** Store a one-time sign-in invitation for a staff person who has not set a password yet (only the hash of the token is kept). */
CREATE FUNCTION staff_member_invite(p_user uuid, p_hash text, p_days int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF p_hash IS NULL OR char_length(p_hash) < 20 OR p_days NOT BETWEEN 1 AND 14 THEN RAISE EXCEPTION 'Not valid.'; END IF;
  UPDATE users SET invite_token_hash = p_hash, invite_expires_at = now() + make_interval(days => p_days)
   WHERE id = p_user AND kind = 'owner' AND removed_at IS NULL AND password_hash IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'This person has signed in already.'; END IF;
END $$;

ALTER TABLE staff_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_roles       ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_role_grants ENABLE ROW LEVEL SECURITY;
-- no policy and no table grant: the app reaches these only through the functions above
CREATE TRIGGER staff_roles_audit  AFTER INSERT OR UPDATE OR DELETE ON staff_roles FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER staff_grants_audit AFTER INSERT OR UPDATE OR DELETE ON staff_role_grants FOR EACH ROW EXECUTE FUNCTION audit_row();

REVOKE ALL ON FUNCTION app_staff_can(text), my_staff_access(), staff_roles_list(), staff_role_save(uuid, text, text, text[]), staff_role_archive(uuid), staff_members(),
  staff_keep_one_owner(uuid), staff_member_add(text, text, uuid), staff_member_update(uuid, text, text), staff_member_set_role(uuid, uuid), staff_member_set_status(uuid, text), staff_member_invite(uuid, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_staff_can(text), my_staff_access(), staff_roles_list(), staff_role_save(uuid, text, text, text[]), staff_role_archive(uuid), staff_members(),
  staff_member_add(text, text, uuid), staff_member_update(uuid, text, text), staff_member_set_role(uuid, uuid), staff_member_set_status(uuid, text), staff_member_invite(uuid, text, int) TO nusuh_app;
