-- 0075 The guided first-run setup for a customer in a free trial: what the business is and what it wants from the trial, the
-- chart of accounts and data choices, how far the customer got, and which page guides it has seen. The answers adapt the
-- software (optional modules are switched on, never off, and only while the customer is still in its trial).
-- Only counts about what the customer did are kept for the owner (companies, contacts, documents, people), never the books' contents.

CREATE TABLE trial_setup (
  firm_id       uuid PRIMARY KEY REFERENCES firms(id),
  step          text NOT NULL DEFAULT 'about' CHECK (step IN ('about', 'chart', 'data', 'done')),
  business_type text CHECK (business_type IN ('trading', 'services', 'restaurant', 'rentals', 'contracting', 'other')),
  goals         text[] NOT NULL DEFAULT ARRAY[]::text[]
                CHECK (goals <@ ARRAY['invoicing', 'bookkeeping', 'vat', 'payroll', 'inventory', 'restaurant', 'rentals', 'rooms', 'assets', 'projects', 'crm', 'einvoicing', 'clients']),
  data_choice   text CHECK (data_choice IN ('import', 'fresh')),
  skipped       boolean NOT NULL DEFAULT false,
  tour_seen     text[] NOT NULL DEFAULT ARRAY[]::text[] CHECK (cardinality(tour_seen) <= 80),
  extract_used  int NOT NULL DEFAULT 0 CHECK (extract_used >= 0),
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE trial_setup ENABLE ROW LEVEL SECURITY;
CREATE POLICY trial_setup_owner ON trial_setup FOR SELECT USING (app_is_owner());
GRANT SELECT ON trial_setup TO nusuh_app;   -- written only by the functions below
CREATE TRIGGER trial_setup_audit AFTER INSERT OR UPDATE OR DELETE ON trial_setup FOR EACH ROW EXECUTE FUNCTION audit_row();

/** The signed-in person's customer: where the setup stands, and whether it is shown (an unpaid trial that is still open, not finished or skipped). */
CREATE FUNCTION my_setup() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid := app_firm_id(); s trial_setup; sub subscriptions;
BEGIN
  IF app_user_id() IS NULL OR app_is_owner() OR f IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO s FROM trial_setup WHERE firm_id = f;
  SELECT * INTO sub FROM subscriptions WHERE firm_id = f;
  RETURN jsonb_build_object(
    'step', coalesce(s.step, 'about'), 'businessType', s.business_type, 'goals', coalesce(s.goals, ARRAY[]::text[]), 'dataChoice', s.data_choice,
    'skipped', coalesce(s.skipped, false), 'completed', s.completed_at IS NOT NULL, 'tourSeen', coalesce(s.tour_seen, ARRAY[]::text[]),
    'inTrial', sub.trial_ends_at IS NOT NULL AND sub.converted_at IS NULL,
    'show', sub.trial_ends_at IS NOT NULL AND sub.converted_at IS NULL AND NOT coalesce(s.skipped, false) AND s.completed_at IS NULL,
    'companies', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'modules', c.modules) ORDER BY c.name) FROM companies c WHERE c.firm_id = f AND c.status = 'active' AND c.id = ANY (app_company_ids())), '[]'::jsonb));
END $$;

/** Saves one step of the setup. p_apply_modules switches on the optional modules the goals need, in the customer's single company (trial only, never off). */
CREATE FUNCTION setup_save(p_step text, p_business text, p_goals text[], p_data_choice text, p_skip boolean, p_done boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid := app_firm_id();
BEGIN
  IF app_user_id() IS NULL OR app_is_owner() OR f IS NULL THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  IF p_step NOT IN ('about', 'chart', 'data', 'done') THEN RAISE EXCEPTION 'Unknown step.'; END IF;
  INSERT INTO trial_setup (firm_id, step, business_type, goals, data_choice, skipped, completed_at)
  VALUES (f, p_step, p_business, coalesce(p_goals, ARRAY[]::text[]), p_data_choice, coalesce(p_skip, false), CASE WHEN p_done THEN now() END)
  ON CONFLICT (firm_id) DO UPDATE SET step = excluded.step, business_type = coalesce(excluded.business_type, trial_setup.business_type),
    goals = CASE WHEN cardinality(excluded.goals) > 0 THEN excluded.goals ELSE trial_setup.goals END,
    data_choice = coalesce(excluded.data_choice, trial_setup.data_choice), skipped = excluded.skipped,
    completed_at = coalesce(trial_setup.completed_at, excluded.completed_at), updated_at = now();
END $$;

/** Switches on optional modules for one of the caller's companies, only while the customer is in its unpaid trial. After buying, modules are the owner's to change (they are billed). */
CREATE FUNCTION setup_apply_modules(p_company uuid, p_modules text[]) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid := app_firm_id(); sub subscriptions; res text[];
BEGIN
  IF app_user_id() IS NULL OR app_is_owner() OR f IS NULL THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  IF NOT (p_company = ANY (app_company_ids())) THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  SELECT * INTO sub FROM subscriptions WHERE firm_id = f;
  IF NOT FOUND OR sub.trial_ends_at IS NULL OR sub.converted_at IS NOT NULL THEN RAISE EXCEPTION 'Modules can only be switched on here during the free trial.'; END IF;
  IF NOT (coalesce(p_modules, ARRAY[]::text[]) <@ ARRAY['Inventory', 'Restaurant', 'Rooms', 'Assets', 'Rentals', 'Projects', 'HRM', 'CRM']) THEN RAISE EXCEPTION 'Choose optional modules from the list.'; END IF;
  UPDATE companies c SET modules = ARRAY(SELECT DISTINCT m FROM unnest(c.modules || coalesce(p_modules, ARRAY[]::text[])) m ORDER BY m)
  WHERE c.id = p_company AND c.firm_id = f RETURNING c.modules INTO res;
  RETURN res;
END $$;

/** Which page guides the person has opened (so a tour card is shown once, and the owner can see how far they got). */
CREATE FUNCTION setup_tour_seen(p_page text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid := app_firm_id();
BEGIN
  IF app_user_id() IS NULL OR app_is_owner() OR f IS NULL THEN RETURN; END IF;
  IF p_page !~ '^[A-Za-z0-9/-]{1,60}$' THEN RAISE EXCEPTION 'Unknown page.'; END IF;
  INSERT INTO trial_setup (firm_id, tour_seen) VALUES (f, ARRAY[p_page])
  ON CONFLICT (firm_id) DO UPDATE SET tour_seen = CASE WHEN p_page = ANY (trial_setup.tour_seen) OR cardinality(trial_setup.tour_seen) >= 80 THEN trial_setup.tour_seen ELSE trial_setup.tour_seen || p_page END,
    updated_at = now();
END $$;

/** Counts the "read a PDF or picture" help was used (the file itself is never kept). */
CREATE FUNCTION setup_extract_used() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid := app_firm_id();
BEGIN
  IF app_user_id() IS NULL OR app_is_owner() OR f IS NULL THEN RETURN; END IF;
  INSERT INTO trial_setup (firm_id, extract_used) VALUES (f, 1)
  ON CONFLICT (firm_id) DO UPDATE SET extract_used = trial_setup.extract_used + 1, updated_at = now();
END $$;

/** The owner's view of what every customer did in the setup, with counts only (never the books' contents). */
CREATE FUNCTION owner_setup_overview() RETURNS TABLE (firm_id uuid, step text, business_type text, goals text[], data_choice text, skipped boolean, completed boolean,
  tour_pages int, extract_used int, companies int, contacts int, documents int, people int, started_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  RETURN QUERY
  SELECT s.firm_id, s.step, s.business_type, s.goals, s.data_choice, s.skipped, s.completed_at IS NOT NULL, cardinality(s.tour_seen), s.extract_used,
    (SELECT count(*)::int FROM companies c WHERE c.firm_id = s.firm_id),
    (SELECT count(*)::int FROM contacts k JOIN companies c ON c.id = k.company_id WHERE c.firm_id = s.firm_id),
    (SELECT count(*)::int FROM documents d JOIN companies c ON c.id = d.company_id WHERE c.firm_id = s.firm_id),
    (SELECT count(*)::int FROM users u WHERE u.firm_id = s.firm_id AND u.status = 'active'),
    s.started_at, s.updated_at
  FROM trial_setup s;
END $$;

REVOKE ALL ON FUNCTION my_setup(), setup_save(text, text, text[], text, boolean, boolean), setup_apply_modules(uuid, text[]), setup_tour_seen(text), setup_extract_used(), owner_setup_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_setup(), setup_save(text, text, text[], text, boolean, boolean), setup_apply_modules(uuid, text[]), setup_tour_seen(text), setup_extract_used(), owner_setup_overview() TO nusuh_app;
