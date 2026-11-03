-- 0023: Tenants and the platform owner.
--   * A tenant (row in firms) is either an accounting firm, which keeps books for its clients, or a company that runs
--     its own books. A third kind, the platform, holds the owner (the seller of Nusuh Books) and nobody else.
--   * Only the owner creates tenants, their first Administrator, and every company. The owner opens a tenant's
--     Administrator console by naming the tenant on each request (app.acting_firm); like an Administrator, the owner
--     never sees books (no memberships).
--   * A tenant's Administrator sees and manages only that tenant. A company tenant's Administrator manages users,
--     roles and access, not company details, and has no firm staff: its people are company users with roles.
--   * A suspended tenant cannot sign in.
--   * Client roles can carry review rights (run the review, raise queries, tick the checklist) and the right to sign
--     off a month, so a company can review its own books without an accounting firm.

ALTER TABLE firms
  ADD COLUMN kind text NOT NULL DEFAULT 'firm' CHECK (kind IN ('platform', 'firm', 'company')),
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX firms_one_platform ON firms (kind) WHERE kind = 'platform';
INSERT INTO firms (name, kind) VALUES ('Nusuh Books', 'platform');

CREATE FUNCTION app_is_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE id = app_user_id() AND kind = 'owner' AND status = 'active')
$$;
/** The tenant the owner is working in on this request, if any (and only for the owner). */
CREATE FUNCTION app_acting_firm() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v text := nullif(current_setting('app.acting_firm', true), ''); f uuid;
BEGIN
  IF v IS NULL OR v !~ '^[0-9a-fA-F-]{36}$' OR NOT app_is_owner() THEN RETURN NULL; END IF;
  SELECT id INTO f FROM firms WHERE id = v::uuid AND kind <> 'platform';
  RETURN f;
END $$;

CREATE OR REPLACE FUNCTION app_firm_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(CASE WHEN u.kind = 'owner' THEN app_acting_firm() END, u.firm_id) FROM users u WHERE u.id = app_user_id()
$$;
CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM users u JOIN firms f ON f.id = u.firm_id
                 WHERE u.id = app_user_id() AND u.kind = 'admin' AND u.status = 'active' AND f.status = 'active')
      OR app_acting_firm() IS NOT NULL
$$;
CREATE FUNCTION app_firm_kind() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT kind FROM firms WHERE id = app_firm_id()
$$;
GRANT EXECUTE ON FUNCTION app_is_owner(), app_acting_firm(), app_firm_kind() TO nusuh_app;

-- Owners live on the platform and only there; company tenants have no firm staff.
CREATE FUNCTION before_user_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE k text;
BEGIN
  SELECT kind INTO k FROM firms WHERE id = NEW.firm_id;
  IF (NEW.kind = 'owner') <> (k = 'platform') THEN RAISE EXCEPTION 'The platform owner and the platform go together.'; END IF;
  IF NEW.kind = 'firm_staff' AND k = 'company' THEN
    RAISE EXCEPTION 'A company runs its own books: add its people as company users with a role.';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.firm_id <> OLD.firm_id OR NEW.kind <> OLD.kind) THEN RAISE EXCEPTION 'A person keeps their organisation and kind.'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_tenant BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION before_user_tenant();

-- Only the owner creates companies. A company tenant's details are changed by the owner only.
DROP POLICY companies_admin_insert ON companies;
CREATE POLICY companies_owner_insert ON companies FOR INSERT WITH CHECK (app_is_owner() AND firm_id = app_firm_id());
DROP POLICY companies_admin_update ON companies;
CREATE POLICY companies_admin_update ON companies FOR UPDATE
  USING (app_is_admin() AND firm_id = app_firm_id() AND (app_is_owner() OR app_firm_kind() = 'firm'))
  WITH CHECK (firm_id = app_firm_id());
-- Firm name and status: the owner (a tenant's Administrator may rename an accounting firm, as before).
DROP POLICY firms_admin_update ON firms;
CREATE POLICY firms_admin_update ON firms FOR UPDATE
  USING (app_is_admin() AND id = app_firm_id() AND (app_is_owner() OR kind = 'firm')) WITH CHECK (id = app_firm_id());

-- ---------------------------------------------------------------------------
-- The owner's view of tenants (never their books)
-- ---------------------------------------------------------------------------
CREATE FUNCTION owner_tenants() RETURNS TABLE (id uuid, name text, kind text, status text, created_at timestamptz, companies int, users int, admins text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  RETURN QUERY
  SELECT f.id, f.name, f.kind, f.status, f.created_at,
         (SELECT count(*) FROM companies c WHERE c.firm_id = f.id)::int,
         (SELECT count(*) FROM users u WHERE u.firm_id = f.id AND u.status = 'active')::int,
         (SELECT string_agg(u.full_name, ', ' ORDER BY u.full_name) FROM users u WHERE u.firm_id = f.id AND u.kind = 'admin')
  FROM firms f WHERE f.kind <> 'platform' ORDER BY f.name;
END $$;
CREATE FUNCTION owner_create_tenant(p_name text, p_kind text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF p_kind NOT IN ('firm', 'company') THEN RAISE EXCEPTION 'Choose an accounting firm or a company.'; END IF;
  IF btrim(coalesce(p_name, '')) = '' THEN RAISE EXCEPTION 'Enter the customer''s name.'; END IF;
  INSERT INTO firms (name, kind) VALUES (btrim(p_name), p_kind) RETURNING id INTO f;
  RETURN f;
END $$;
CREATE FUNCTION owner_update_tenant(p_id uuid, p_name text, p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF p_status NOT IN ('active', 'suspended') OR btrim(coalesce(p_name, '')) = '' THEN RAISE EXCEPTION 'Enter the name and status.'; END IF;
  UPDATE firms SET name = btrim(p_name), status = p_status WHERE id = p_id AND kind <> 'platform';
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found.'; END IF;
END $$;
GRANT EXECUTE ON FUNCTION owner_tenants(), owner_create_tenant(text, text), owner_update_tenant(uuid, text, text) TO nusuh_app;

-- Sign-in also says whether the person's organisation is suspended.
DROP FUNCTION auth_user_by_email(text);
CREATE FUNCTION auth_user_by_email(p_email text)
RETURNS TABLE (id uuid, kind user_kind, status text, password_hash text, totp_secret_enc text, firm_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.kind, u.status, u.password_hash, u.totp_secret_enc, f.status FROM users u JOIN firms f ON f.id = u.firm_id WHERE lower(u.email) = lower(p_email)
$$;
GRANT EXECUTE ON FUNCTION auth_user_by_email(text) TO nusuh_app;

-- ---------------------------------------------------------------------------
-- Review rights in client roles
-- ---------------------------------------------------------------------------
ALTER TABLE client_roles
  ADD COLUMN can_review boolean NOT NULL DEFAULT false,
  ADD COLUMN can_sign_off boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT sign_off_needs_review CHECK (NOT can_sign_off OR can_review);

CREATE FUNCTION app_can_review(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_has_role(p_company, review_roles()) OR EXISTS (SELECT 1 FROM memberships m JOIN client_roles r ON r.id = m.client_role_id
    WHERE m.user_id = app_user_id() AND m.company_id = p_company AND r.can_review AND r.status = 'active')
$$;
CREATE FUNCTION app_can_sign(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_has_role(p_company, signoff_roles()) OR EXISTS (SELECT 1 FROM memberships m JOIN client_roles r ON r.id = m.client_role_id
    WHERE m.user_id = app_user_id() AND m.company_id = p_company AND r.can_sign_off AND r.status = 'active')
$$;
GRANT EXECUTE ON FUNCTION app_can_review(uuid), app_can_sign(uuid) TO nusuh_app;

/** Is this person on the reviewing side for the company (firm staff, or a role with review rights)? */
CREATE OR REPLACE FUNCTION review_from_firm(p_company uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_company = ANY (app_company_ids()) AND EXISTS (SELECT 1 FROM memberships m LEFT JOIN client_roles r ON r.id = m.client_role_id
    WHERE m.company_id = p_company AND m.user_id = p_user AND (m.role = ANY (review_roles()) OR (r.can_review AND r.status = 'active')))
$$;

CREATE OR REPLACE FUNCTION before_review_query_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.raised_by := app_user_id(); END IF;
    NEW.raised_at := now(); NEW.status := 'open'; NEW.closed_by := NULL; NEW.closed_at := NULL;
    RETURN NEW;
  END IF;
  IF (NEW.company_id, NEW.period_end, NEW.subject, NEW.about_type, NEW.about_id, NEW.raised_by, NEW.raised_at)
     IS DISTINCT FROM (OLD.company_id, OLD.period_end, OLD.subject, OLD.about_type, OLD.about_id, OLD.raised_by, OLD.raised_at) THEN
    RAISE EXCEPTION 'A query keeps its subject; reply to it instead.';
  END IF;
  -- Closing or reopening is for the firm; a client reply marks it answered.
  IF (NEW.status = 'closed' OR OLD.status = 'closed') AND NEW.status IS DISTINCT FROM OLD.status AND NOT app_can_review(NEW.company_id) THEN
    RAISE EXCEPTION 'Only the accounting firm closes or reopens a query.';
  END IF;
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN NEW.closed_by := app_user_id(); NEW.closed_at := now(); END IF;
  IF NEW.status <> 'closed' THEN NEW.closed_by := NULL; NEW.closed_at := NULL; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION before_review_message() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE q review_queries%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'A message is never changed. Add another reply.'; END IF;
  SELECT * INTO q FROM review_queries WHERE id = NEW.query_id;
  IF q.id IS NULL OR q.company_id <> NEW.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
  IF q.status = 'closed' THEN RAISE EXCEPTION 'This query is closed. Reopen it to reply.'; END IF;
  IF app_user_id() IS NOT NULL THEN NEW.author := app_user_id(); END IF;
  NEW.created_at := now();
  -- A reply from the client answers the query; a reply from the firm puts it back to open.
  UPDATE review_queries SET status = CASE WHEN app_can_review(q.company_id) THEN 'open' ELSE 'answered' END WHERE id = q.id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION before_review_signoff_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'A sign-off is never deleted. Withdraw it with a reason.'; END IF;
  IF app_user_id() IS NOT NULL AND NOT app_can_sign(NEW.company_id) THEN
    RAISE EXCEPTION 'Only a partner or reviewer signs off a month.';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.signed_by := app_user_id(); END IF;
    NEW.signed_at := now(); NEW.withdrawn_by := NULL; NEW.withdrawn_at := NULL; NEW.withdraw_reason := NULL;
    IF NEW.period_end >= current_date THEN RAISE EXCEPTION 'A month is signed off after it has ended.'; END IF;
    IF EXISTS (SELECT 1 FROM review_queries WHERE company_id = NEW.company_id AND period_end = NEW.period_end AND status <> 'closed') THEN
      RAISE EXCEPTION 'Close this month''s queries before signing it off.';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.withdrawn_at IS NOT NULL OR (to_jsonb(NEW) - 'withdrawn_by' - 'withdrawn_at' - 'withdraw_reason') <> (to_jsonb(OLD) - 'withdrawn_by' - 'withdrawn_at' - 'withdraw_reason') THEN
    RAISE EXCEPTION 'A sign-off is never changed. Withdraw it with a reason.';
  END IF;
  IF app_user_id() IS NOT NULL THEN NEW.withdrawn_by := app_user_id(); END IF;
  NEW.withdrawn_at := now();
  RETURN NEW;
END $$;

DROP POLICY review_queries_insert ON review_queries;
DROP POLICY review_queries_update ON review_queries;
DROP POLICY review_checklist_insert ON review_checklist;
DROP POLICY review_checklist_update ON review_checklist;
DROP POLICY review_explained_insert ON review_explained;
DROP POLICY review_explained_update ON review_explained;
DROP POLICY review_explained_delete ON review_explained;
DROP POLICY review_signoffs_insert ON review_signoffs;
DROP POLICY review_signoffs_update ON review_signoffs;
CREATE POLICY review_queries_insert ON review_queries FOR INSERT WITH CHECK (app_can_review(company_id));
CREATE POLICY review_queries_update ON review_queries FOR UPDATE USING (app_can_review(company_id)) WITH CHECK (app_can_review(company_id));
CREATE POLICY review_checklist_insert ON review_checklist FOR INSERT WITH CHECK (app_can_review(company_id));
CREATE POLICY review_checklist_update ON review_checklist FOR UPDATE USING (app_can_review(company_id)) WITH CHECK (app_can_review(company_id));
CREATE POLICY review_explained_insert ON review_explained FOR INSERT WITH CHECK (app_can_review(company_id));
CREATE POLICY review_explained_update ON review_explained FOR UPDATE USING (app_can_review(company_id)) WITH CHECK (app_can_review(company_id));
CREATE POLICY review_explained_delete ON review_explained FOR DELETE USING (app_can_review(company_id));
CREATE POLICY review_signoffs_insert ON review_signoffs FOR INSERT WITH CHECK (app_can_sign(company_id));
CREATE POLICY review_signoffs_update ON review_signoffs FOR UPDATE USING (app_can_sign(company_id)) WITH CHECK (app_can_sign(company_id));

-- The books know the person's review rights too.
DROP FUNCTION app_client_role(uuid);
CREATE FUNCTION app_client_role(p_company uuid) RETURNS TABLE (permissions jsonb, can_approve boolean, name text, name_ar text, can_review boolean, can_sign_off boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.permissions, r.can_approve, r.name, r.name_ar, r.can_review, r.can_sign_off FROM memberships m JOIN client_roles r ON r.id = m.client_role_id
  WHERE m.user_id = app_user_id() AND m.company_id = p_company
$$;
GRANT EXECUTE ON FUNCTION app_client_role(uuid) TO nusuh_app;
