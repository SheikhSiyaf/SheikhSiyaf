-- 0080: the checklist beside the bell (it used to sit on the home page).
-- checklist_items: the company's own changes to the list. A row for a built-in item only holds what the company's Administrator
--   changed (hidden, order, wording); a custom row is an item the Administrator added.
-- checklist_ticks: what has been ticked by hand. user_id NULL = ticked for the whole company; otherwise only that person's tick.
--   period '' = once for ever, 'YYYY-MM-DD' = a daily item that day, 'YYYY-MM' = a month-end item for that month.
--   Un-ticking deletes the row; the audit log keeps who ticked and who un-ticked, and when.
-- checklist_hidden: items a person has hidden for themselves (nobody else sees this).
-- Items that tick themselves (bank account added, first invoice issued...) are worked out live from the books and need no row.
CREATE TABLE checklist_items (
  id          uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  company_id  uuid NOT NULL REFERENCES companies(id),
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  is_custom   boolean NOT NULL DEFAULT false,
  area        text CHECK (area IN ('setup', 'daily', 'month_end')),
  scope       text NOT NULL DEFAULT 'company' CHECK (scope IN ('company', 'user')),
  title       text CHECK (title IS NULL OR (btrim(title) <> '' AND length(title) <= 120)),
  title_ar    text CHECK (title_ar IS NULL OR (btrim(title_ar) <> '' AND length(title_ar) <= 120)),
  help        text CHECK (help IS NULL OR (btrim(help) <> '' AND length(help) <= 300)),
  help_ar     text CHECK (help_ar IS NULL OR (btrim(help_ar) <> '' AND length(help_ar) <= 300)),
  go_module   text CHECK (go_module IS NULL OR length(go_module) <= 30),
  go_sub      text CHECK (go_sub IS NULL OR length(go_sub) <= 60),
  sort        integer CHECK (sort IS NULL OR sort BETWEEN 0 AND 100000),
  hidden      boolean NOT NULL DEFAULT false,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key),
  CHECK (NOT is_custom OR (area IS NOT NULL AND title IS NOT NULL))
);

CREATE TABLE checklist_ticks (
  id         uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  company_id uuid NOT NULL REFERENCES companies(id),
  item_key   text NOT NULL CHECK (item_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  user_id    uuid REFERENCES users(id),
  period     text NOT NULL DEFAULT '' CHECK (period ~ '^([0-9]{4}-[0-9]{2}(-[0-9]{2})?)?$'),
  done_by    uuid NOT NULL REFERENCES users(id),
  done_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX checklist_ticks_one ON checklist_ticks (company_id, item_key, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), period);

CREATE TABLE checklist_hidden (
  company_id uuid NOT NULL REFERENCES companies(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  item_key   text NOT NULL CHECK (item_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  hidden_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id, item_key)
);

-- A company may add at most 30 items of its own, and an item stays with its company and its kind.
CREATE FUNCTION before_checklist_item() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id <> OLD.company_id OR NEW.key <> OLD.key OR NEW.is_custom <> OLD.is_custom THEN
      RAISE EXCEPTION 'A checklist item keeps its company, key and kind.';
    END IF;
  ELSIF NEW.is_custom THEN
    -- one at a time per company, so many requests at once cannot all pass the count
    PERFORM pg_advisory_xact_lock(hashtextextended('checklist_items:' || NEW.company_id::text, 0));
    IF (SELECT count(*) FROM checklist_items WHERE company_id = NEW.company_id AND is_custom) >= 30 THEN
      RAISE EXCEPTION 'A company can add at most 30 checklist items of its own.';
    END IF;
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := app_user_id();
  RETURN NEW;
END $$;
CREATE TRIGGER checklist_items_before BEFORE INSERT OR UPDATE ON checklist_items FOR EACH ROW EXECUTE FUNCTION before_checklist_item();

-- Ticks cannot be edited (a tick is added or removed), and a tick carries the person who made it.
CREATE FUNCTION before_checklist_tick() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'A tick is added or removed, never changed.'; END IF;
  NEW.done_by := app_user_id();
  NEW.done_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER checklist_ticks_before BEFORE INSERT OR UPDATE ON checklist_ticks FOR EACH ROW EXECUTE FUNCTION before_checklist_tick();

-- Row-level security. The company's Administrator may not be a member of the company (an Administrator manages people and never sees the books),
-- so "Administrator of this company" means: an Administrator who is a member, or one in the company's own firm.
CREATE FUNCTION checklist_admin_of(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_is_admin() AND (p_company = ANY (app_company_ids())
                             OR EXISTS (SELECT 1 FROM companies WHERE id = p_company AND firm_id = app_firm_id()))
$$;
GRANT EXECUTE ON FUNCTION checklist_admin_of(uuid) TO nusuh_app;

ALTER TABLE checklist_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_ticks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_hidden ENABLE ROW LEVEL SECURITY;
CREATE POLICY checklist_items_read   ON checklist_items FOR SELECT USING (company_id = ANY (app_company_ids()) OR checklist_admin_of(company_id));
CREATE POLICY checklist_items_insert ON checklist_items FOR INSERT WITH CHECK (checklist_admin_of(company_id));
CREATE POLICY checklist_items_update ON checklist_items FOR UPDATE USING (checklist_admin_of(company_id)) WITH CHECK (checklist_admin_of(company_id));
CREATE POLICY checklist_items_delete ON checklist_items FOR DELETE USING (checklist_admin_of(company_id) AND is_custom);

-- A company-wide tick is seen by every member; a personal tick only by its owner. Company-wide ticks are made by people who post or by the Administrator.
CREATE POLICY checklist_ticks_read ON checklist_ticks FOR SELECT
  USING (company_id = ANY (app_company_ids()) AND (user_id IS NULL OR user_id = app_user_id()));
CREATE POLICY checklist_ticks_insert ON checklist_ticks FOR INSERT
  WITH CHECK (company_id = ANY (app_company_ids()) AND (user_id = app_user_id()
              OR (user_id IS NULL AND (app_has_role(company_id, posting_roles()) OR app_is_admin() OR EXISTS (SELECT 1 FROM app_client_role(company_id))))));
CREATE POLICY checklist_ticks_delete ON checklist_ticks FOR DELETE
  USING (company_id = ANY (app_company_ids()) AND (user_id = app_user_id()
        OR (user_id IS NULL AND (app_has_role(company_id, posting_roles()) OR app_is_admin() OR EXISTS (SELECT 1 FROM app_client_role(company_id))))));

CREATE POLICY checklist_hidden_own ON checklist_hidden USING (user_id = app_user_id() AND company_id = ANY (app_company_ids()))
  WITH CHECK (user_id = app_user_id() AND company_id = ANY (app_company_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON checklist_items TO nusuh_app;
GRANT SELECT, INSERT, DELETE ON checklist_ticks TO nusuh_app;
GRANT SELECT, INSERT, DELETE ON checklist_hidden TO nusuh_app;

-- Who is in the company (people who use its books, and for a company that keeps its own books also its Administrator) and whether the caller
-- has two-factor sign-in, without opening the people tables to every role.
CREATE FUNCTION checklist_people(p_company uuid) RETURNS TABLE (members integer, twofa boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (SELECT count(*)::integer FROM (
            SELECT user_id AS id FROM memberships WHERE company_id = p_company
            UNION
            SELECT u.id FROM users u JOIN companies c ON c.firm_id = u.firm_id JOIN firms f ON f.id = c.firm_id AND f.kind = 'company'
             WHERE c.id = p_company AND u.status = 'active') p),
         coalesce((SELECT totp_secret_enc IS NOT NULL FROM users WHERE id = app_user_id()), false)
  WHERE p_company = ANY (app_company_ids())
$$;
GRANT EXECUTE ON FUNCTION checklist_people(uuid) TO nusuh_app;

-- Every change to the list and every tick is audited.
CREATE TRIGGER checklist_items_audit AFTER INSERT OR UPDATE OR DELETE ON checklist_items FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER checklist_ticks_audit AFTER INSERT OR DELETE ON checklist_ticks FOR EACH ROW EXECUTE FUNCTION audit_row();
