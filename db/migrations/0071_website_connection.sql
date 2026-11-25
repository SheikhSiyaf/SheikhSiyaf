-- 0071 The website connection: what the public website shows from the software.
--
--   Payment settings: which plan the website shows, and the names (English and Arabic) of its four price lines. The PRICES are
--   the plan's own prices in `plans` (the same ones the billing run uses), so the website and the invoices cannot disagree:
--       website "implementation" = plans.setup_price            (software, once)
--       website "cleanup"        = plans.implementation_price   (accounts clean-up and setup, once, optional)
--       website "annualCore"     = plans.yearly_price           (yearly, core modules)
--       website "perModule"      = plans.extra_module_price     (yearly, each extra module)
--   Every price edit needs a reason and is kept in plan_price_changes (never changed or deleted).
--
--   Testimonials: written by the owner, shown on the website only when visible. Each one needs the customer's permission
--   ticked. The most that can be saved is website_settings.testimonial_limit (5 to 10, default 8): the database refuses
--   one more than the limit, and refuses a lower limit than the number saved.
--
--   public_site_data(): the one read-only answer the website asks for (prices, names, visible testimonials). Nothing private.
--   Row-level security: only the platform owner reads or writes the tables; the public function is the only other way in.

CREATE TABLE website_settings (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  plan_id            uuid NOT NULL REFERENCES plans(id),
  line_names         jsonb NOT NULL CHECK (jsonb_typeof(line_names) = 'object'),   -- {"implementation": {"en": "...", "ar": "..."}, ...}
  testimonial_limit  int NOT NULL DEFAULT 8 CHECK (testimonial_limit BETWEEN 5 AND 10),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO website_settings (plan_id, line_names)
SELECT id, jsonb_build_object(
  'implementation', jsonb_build_object('en', 'Implementation', 'ar', 'التنفيذ'),
  'cleanup',        jsonb_build_object('en', 'Accounts clean-up and setup', 'ar', 'تنظيف الحسابات وإعدادها'),
  'annualCore',     jsonb_build_object('en', 'Annual fee', 'ar', 'الرسوم السنوية'),
  'perModule',      jsonb_build_object('en', 'Extra module', 'ar', 'وحدة إضافية'))
FROM plans WHERE code = 'nusuh';

-- No price can be negative (already) or absurd (new): the owner types these by hand.
ALTER TABLE plans ADD CONSTRAINT plans_prices_sane
  CHECK (monthly_price <= 1000000 AND yearly_price <= 1000000 AND setup_price <= 1000000 AND implementation_price <= 1000000 AND extra_module_price <= 1000000);

CREATE TABLE website_testimonials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 80),
  name_ar       text CHECK (char_length(name_ar) <= 80),
  role          text CHECK (char_length(role) <= 80),
  role_ar       text CHECK (char_length(role_ar) <= 80),
  company       text CHECK (char_length(company) <= 80),
  company_ar    text CHECK (char_length(company_ar) <= 80),
  quote         text NOT NULL CHECK (btrim(quote) <> '' AND char_length(quote) <= 300),
  quote_ar      text CHECK (char_length(quote_ar) <= 300),
  consent       boolean NOT NULL CHECK (consent),   -- the customer allowed us to publish it
  consent_note  text CHECK (char_length(consent_note) <= 200),
  visible       boolean NOT NULL DEFAULT true,
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX website_testimonials_order ON website_testimonials (sort_order, created_at);

/** One more than the limit is refused. The settings row is locked first, so two adds at once cannot both slip in. */
CREATE FUNCTION before_testimonial_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lim int;
BEGIN
  SELECT testimonial_limit INTO lim FROM website_settings FOR UPDATE;
  IF (SELECT count(*) FROM website_testimonials) >= lim THEN
    RAISE EXCEPTION 'You can save at most % testimonials. Delete one first, or raise the limit (up to 10).', lim;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER website_testimonials_limit BEFORE INSERT ON website_testimonials FOR EACH ROW EXECUTE FUNCTION before_testimonial_insert();

/** A lower limit than the number saved is refused: remove or hide some first. */
CREATE FUNCTION before_website_settings_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM website_testimonials;
  IF NEW.testimonial_limit < n THEN
    RAISE EXCEPTION 'You have % testimonials saved. Delete % first to set the limit to %.', n, n - NEW.testimonial_limit, NEW.testimonial_limit;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER website_settings_check BEFORE UPDATE ON website_settings FOR EACH ROW EXECUTE FUNCTION before_website_settings_update();
CREATE TRIGGER website_settings_touch BEFORE UPDATE ON website_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER website_testimonials_touch BEFORE UPDATE ON website_testimonials FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER website_settings_no_delete BEFORE DELETE ON website_settings FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE plan_price_changes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id            uuid NOT NULL REFERENCES plans(id),
  changed_by         uuid REFERENCES users(id),
  reason             text NOT NULL CHECK (btrim(reason) <> ''),
  before             jsonb NOT NULL,
  after              jsonb NOT NULL,
  customers_affected int NOT NULL,
  at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plan_price_changes_plan ON plan_price_changes (plan_id, at DESC);
CREATE TRIGGER plan_price_changes_immutable BEFORE UPDATE OR DELETE ON plan_price_changes FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['website_settings', 'website_testimonials', 'plan_price_changes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['website_settings', 'website_testimonials'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
  END LOOP;
END $$;
CREATE POLICY website_settings_owner ON website_settings FOR ALL USING (app_is_owner()) WITH CHECK (app_is_owner());
CREATE POLICY website_testimonials_owner ON website_testimonials FOR ALL USING (app_is_owner()) WITH CHECK (app_is_owner());
CREATE POLICY plan_price_changes_read ON plan_price_changes FOR SELECT USING (app_is_owner());
CREATE POLICY plan_price_changes_insert ON plan_price_changes FOR INSERT WITH CHECK (app_is_owner());
GRANT SELECT, UPDATE ON website_settings TO nusuh_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON website_testimonials TO nusuh_app;
GRANT SELECT, INSERT ON plan_price_changes TO nusuh_app;

-- ---------------------------------------------------------------------------
-- The public answer
-- ---------------------------------------------------------------------------
/** What the public website shows: prices and names of the plan chosen in Payment settings, and the visible testimonials in
 *  order. Read-only, no personal or accounting data. Anyone may call it (the program calls it with nobody signed in). */
CREATE FUNCTION public_site_data() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'currency', b.currency,
    'vatRate', b.vat_rate,
    'planName', p.name,
    'planNameAr', p.name_ar,
    'lines', jsonb_build_array(
      jsonb_build_object('key', 'implementation', 'name', w.line_names->'implementation'->>'en', 'nameAr', w.line_names->'implementation'->>'ar', 'amount', p.setup_price),
      jsonb_build_object('key', 'cleanup',        'name', w.line_names->'cleanup'->>'en',        'nameAr', w.line_names->'cleanup'->>'ar',        'amount', p.implementation_price),
      jsonb_build_object('key', 'annualCore',     'name', w.line_names->'annualCore'->>'en',     'nameAr', w.line_names->'annualCore'->>'ar',     'amount', p.yearly_price),
      jsonb_build_object('key', 'perModule',      'name', w.line_names->'perModule'->>'en',      'nameAr', w.line_names->'perModule'->>'ar',      'amount', p.extra_module_price)),
    'testimonials', jsonb_build_object(
      'limit', w.testimonial_limit,
      'items', coalesce((SELECT jsonb_agg(jsonb_build_object('name', t.name, 'nameAr', t.name_ar, 'role', t.role, 'roleAr', t.role_ar,
                                                             'company', t.company, 'companyAr', t.company_ar, 'quote', t.quote, 'quoteAr', t.quote_ar)
                                          ORDER BY t.sort_order, t.created_at)
                         FROM website_testimonials t WHERE t.visible), '[]'::jsonb)))
  FROM website_settings w JOIN plans p ON p.id = w.plan_id, billing_settings b
$$;
REVOKE ALL ON FUNCTION public_site_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_site_data() TO nusuh_app;
