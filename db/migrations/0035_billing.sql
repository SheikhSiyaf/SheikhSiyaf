-- 0035 Billing and subscriptions in the owner console: what each customer (accounting firm or company) pays for
-- Nusuh Books.
--
-- plans: price per month and per year, what is included (companies, users) and the price of each extra one per month.
-- subscriptions: one per customer: plan, monthly or yearly, trial, next bill date, discount, cancel at period end.
-- billing_invoices: billed in advance for each period, with the usage on the day of billing; never deleted or
--   changed, only paid or voided. An unpaid invoice past its due date marks the subscription past due (the owner
--   decides whether to suspend the customer).
-- billing_settings: the seller's details on the invoices, VAT rate and payment terms.
--
-- The owner writes everything. A customer's Administrator reads its own subscription and invoices (Admin > Billing).
-- The daily job runs billing_run() with nobody signed in.

CREATE TABLE billing_settings (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  seller_name     text NOT NULL DEFAULT 'Nusuh Books' CHECK (btrim(seller_name) <> ''),
  seller_vat      text,
  seller_address  text,
  currency        char(3) NOT NULL DEFAULT 'SAR',
  vat_rate        numeric(5,2) NOT NULL DEFAULT 15 CHECK (vat_rate BETWEEN 0 AND 100),
  terms_days      int NOT NULL DEFAULT 14 CHECK (terms_days BETWEEN 0 AND 90),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing_settings DEFAULT VALUES;

CREATE TABLE plans (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_-]{2,30}$'),
  name                 text NOT NULL CHECK (btrim(name) <> ''),
  name_ar              text,
  for_kind             text NOT NULL DEFAULT 'any' CHECK (for_kind IN ('firm', 'company', 'any')),
  monthly_price        numeric(18,2) NOT NULL CHECK (monthly_price >= 0),
  yearly_price         numeric(18,2) NOT NULL CHECK (yearly_price >= 0),
  included_companies   int NOT NULL CHECK (included_companies >= 0),
  included_users       int NOT NULL CHECK (included_users >= 0),
  extra_company_price  numeric(18,2) NOT NULL DEFAULT 0 CHECK (extra_company_price >= 0),   -- per month
  extra_user_price     numeric(18,2) NOT NULL DEFAULT 0 CHECK (extra_user_price >= 0),      -- per month
  trial_days           int NOT NULL DEFAULT 14 CHECK (trial_days BETWEEN 0 AND 90),
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO plans (code, name, name_ar, for_kind, monthly_price, yearly_price, included_companies, included_users, extra_company_price, extra_user_price) VALUES
  ('starter',   'Starter',   'البداية',        'company', 149,  1490,  1,  3,  0,  39),
  ('business',  'Business',  'الأعمال',        'company', 399,  3990,  3,  10, 99, 29),
  ('firm',      'Firm',      'مكتب محاسبة',    'firm',    799,  7990,  10, 5,  59, 39),
  ('firm_plus', 'Firm Plus', 'مكتب محاسبة بلس', 'firm',    2499, 24990, 50, 20, 39, 29);

CREATE TABLE subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id               uuid NOT NULL UNIQUE REFERENCES firms(id),
  plan_id               uuid NOT NULL REFERENCES plans(id),
  cycle                 text NOT NULL CHECK (cycle IN ('monthly', 'yearly')),
  status                text NOT NULL CHECK (status IN ('trial', 'active', 'past_due', 'cancelled')),
  started_on            date NOT NULL,
  trial_ends            date,
  next_bill_on          date NOT NULL,
  discount_pct          numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  cancel_at_period_end  boolean NOT NULL DEFAULT false,
  notes                 text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'trial' OR trial_ends IS NOT NULL)
);

CREATE TABLE billing_invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid NOT NULL REFERENCES firms(id),
  number        text NOT NULL UNIQUE,
  customer_name text NOT NULL,
  plan_name     text NOT NULL,
  cycle         text NOT NULL CHECK (cycle IN ('monthly', 'yearly')),
  period_start  date NOT NULL,
  period_end    date NOT NULL CHECK (period_end >= period_start),
  issued_on     date NOT NULL,
  due_on        date NOT NULL CHECK (due_on >= issued_on),
  currency      char(3) NOT NULL,
  lines         jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),   -- [{key, quantity, unitPrice, amount}]
  subtotal      numeric(18,2) NOT NULL,
  discount      numeric(18,2) NOT NULL DEFAULT 0,
  vat_rate      numeric(5,2) NOT NULL,
  vat           numeric(18,2) NOT NULL,
  total         numeric(18,2) NOT NULL CHECK (total = subtotal - discount + vat),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void')),
  paid_on       date,
  paid_ref      text,
  void_reason   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'paid') = (paid_on IS NOT NULL)),
  CHECK (status <> 'void' OR btrim(coalesce(void_reason, '')) <> '')
);
CREATE UNIQUE INDEX billing_invoices_once ON billing_invoices (firm_id, period_start) WHERE status <> 'void';
CREATE INDEX billing_invoices_firm ON billing_invoices (firm_id, issued_on DESC);

/** An issued billing invoice keeps its amounts; it only moves from open to paid or void. */
CREATE FUNCTION before_billing_invoice_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'paid_on' - 'paid_ref' - 'void_reason') <> (to_jsonb(OLD) - 'status' - 'paid_on' - 'paid_ref' - 'void_reason')
     OR OLD.status <> 'open' THEN
    RAISE EXCEPTION 'An issued invoice is not changed: void it and bill again.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_invoices_before_update BEFORE UPDATE ON billing_invoices FOR EACH ROW EXECUTE FUNCTION before_billing_invoice_update();
CREATE TRIGGER billing_invoices_no_delete BEFORE DELETE ON billing_invoices FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER subscriptions_no_delete BEFORE DELETE ON subscriptions FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER plans_no_delete BEFORE DELETE ON plans FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER subscriptions_touch BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER billing_settings_touch BEFORE UPDATE ON billing_settings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Usage and the bill
-- ---------------------------------------------------------------------------
/** Who may see a customer's billing: the owner, its own Administrator, or the server (nobody signed in). */
CREATE FUNCTION billing_can_see(p_firm uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_user_id() IS NULL OR app_is_owner() OR (app_is_admin() AND app_firm_id() = p_firm)
$$;

/** What a customer uses today: active companies, and active people who work in the books (staff and company users). */
CREATE FUNCTION billing_usage(p_firm uuid) RETURNS TABLE (companies int, users int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT billing_can_see(p_firm) THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  RETURN QUERY SELECT
    (SELECT count(*) FROM companies c WHERE c.firm_id = p_firm AND c.status = 'active')::int,
    (SELECT count(*) FROM users u WHERE u.firm_id = p_firm AND u.status = 'active' AND u.kind IN ('firm_staff', 'client'))::int;
END $$;

/** The bill for one period starting p_start, with today's usage (nothing is saved). */
CREATE FUNCTION billing_quote(p_firm uuid, p_start date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s subscriptions; p plans; st billing_settings; u record; months int; ec int; eu int; lines jsonb := '[]';
        sub numeric; disc numeric; vat numeric; base numeric;
BEGIN
  IF NOT billing_can_see(p_firm) THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  SELECT * INTO s FROM subscriptions WHERE firm_id = p_firm;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO p FROM plans WHERE id = s.plan_id;
  SELECT * INTO st FROM billing_settings;
  SELECT * INTO u FROM billing_usage(p_firm);
  months := CASE s.cycle WHEN 'yearly' THEN 12 ELSE 1 END;
  base := CASE s.cycle WHEN 'yearly' THEN p.yearly_price ELSE p.monthly_price END;
  lines := lines || jsonb_build_object('key', 'plan', 'name', p.name, 'quantity', 1, 'unitPrice', base, 'amount', base);
  ec := greatest(0, u.companies - p.included_companies);
  eu := greatest(0, u.users - p.included_users);
  IF ec > 0 AND p.extra_company_price > 0 THEN
    lines := lines || jsonb_build_object('key', 'extraCompanies', 'quantity', ec, 'months', months, 'unitPrice', p.extra_company_price,
                                         'amount', ec * months * p.extra_company_price);
  END IF;
  IF eu > 0 AND p.extra_user_price > 0 THEN
    lines := lines || jsonb_build_object('key', 'extraUsers', 'quantity', eu, 'months', months, 'unitPrice', p.extra_user_price,
                                         'amount', eu * months * p.extra_user_price);
  END IF;
  sub := (SELECT coalesce(sum((l->>'amount')::numeric), 0) FROM jsonb_array_elements(lines) l);
  disc := round(sub * s.discount_pct / 100, 2);
  vat := round((sub - disc) * st.vat_rate / 100, 2);
  RETURN jsonb_build_object(
    'planName', p.name, 'cycle', s.cycle, 'periodStart', p_start,
    'periodEnd', ((p_start + make_interval(months => months)) - interval '1 day')::date,
    'currency', st.currency, 'lines', lines, 'subtotal', sub, 'discount', disc, 'vatRate', st.vat_rate, 'vat', vat, 'total', sub - disc + vat,
    'companies', u.companies, 'users', u.users, 'includedCompanies', p.included_companies, 'includedUsers', p.included_users);
END $$;

/** Bills every subscription whose next bill date has come (catching up missed periods), ends trials, applies
 *  cancellations at the end of the period, and marks subscriptions with an overdue invoice as past due.
 *  The owner (Run billing now) or the daily job. Returns the new invoices. */
CREATE FUNCTION billing_run(p_day date)
RETURNS TABLE (invoice_id uuid, firm_id uuid, number text, customer_name text, total numeric, currency char(3), due_on date, period_start date, period_end date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE s subscriptions; q jsonb; st billing_settings; n int; b billing_invoices; guard int;
BEGIN
  IF app_user_id() IS NOT NULL AND NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('billing_run'));
  SELECT * INTO st FROM billing_settings;
  FOR s IN SELECT * FROM subscriptions WHERE status <> 'cancelled' AND next_bill_on <= p_day ORDER BY next_bill_on FOR UPDATE LOOP
    guard := 0;
    WHILE s.next_bill_on <= p_day AND guard < 24 LOOP
      guard := guard + 1;
      IF s.cancel_at_period_end THEN
        UPDATE subscriptions SET status = 'cancelled' WHERE id = s.id;
        EXIT;
      END IF;
      q := billing_quote(s.firm_id, s.next_bill_on);
      SELECT count(*) + 1 INTO n FROM billing_invoices WHERE number LIKE 'NB-' || extract(year FROM p_day)::int || '-%';
      INSERT INTO billing_invoices (firm_id, number, customer_name, plan_name, cycle, period_start, period_end, issued_on, due_on, currency, lines,
                                    subtotal, discount, vat_rate, vat, total)
      VALUES (s.firm_id, 'NB-' || extract(year FROM p_day)::int || '-' || lpad(n::text, 4, '0'),
              (SELECT f.name FROM firms f WHERE f.id = s.firm_id), q->>'planName', s.cycle, s.next_bill_on,
              (q->>'periodEnd')::date, p_day, p_day + st.terms_days, q->>'currency', q->'lines',
              (q->>'subtotal')::numeric, (q->>'discount')::numeric, (q->>'vatRate')::numeric, (q->>'vat')::numeric, (q->>'total')::numeric)
      RETURNING * INTO b;
      invoice_id := b.id; firm_id := b.firm_id; number := b.number; customer_name := b.customer_name; total := b.total; currency := b.currency;
      due_on := b.due_on; period_start := b.period_start; period_end := b.period_end;
      RETURN NEXT;
      s.next_bill_on := (q->>'periodEnd')::date + 1;
      UPDATE subscriptions SET next_bill_on = s.next_bill_on, status = CASE WHEN status = 'trial' THEN 'active' ELSE status END WHERE id = s.id;
    END LOOP;
  END LOOP;
  UPDATE subscriptions x SET status = 'past_due'
  WHERE x.status = 'active' AND EXISTS (SELECT 1 FROM billing_invoices b WHERE b.firm_id = x.firm_id AND b.status = 'open' AND b.due_on < p_day);
END $$;

/** Owner: an invoice was paid (bank transfer, card, ...). A past-due subscription with nothing else overdue is active again. */
CREATE FUNCTION billing_mark_paid(p_id uuid, p_on date, p_ref text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid;
BEGIN
  IF NOT (app_is_owner() OR app_user_id() IS NULL) THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  UPDATE billing_invoices SET status = 'paid', paid_on = coalesce(p_on, current_date), paid_ref = nullif(btrim(coalesce(p_ref, '')), '')
  WHERE id = p_id AND status = 'open' RETURNING firm_id INTO f;
  IF f IS NULL THEN RAISE EXCEPTION 'Only an open invoice can be marked paid.'; END IF;
  UPDATE subscriptions SET status = 'active' WHERE firm_id = f AND status = 'past_due'
    AND NOT EXISTS (SELECT 1 FROM billing_invoices b WHERE b.firm_id = f AND b.status = 'open' AND b.due_on < current_date);
END $$;

/** Owner: void an invoice (billed by mistake). Its period can be billed again by moving the next bill date back. */
CREATE FUNCTION billing_void(p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f uuid;
BEGIN
  IF NOT app_is_owner() THEN RAISE EXCEPTION 'Only the platform owner can do this.'; END IF;
  IF btrim(coalesce(p_reason, '')) = '' THEN RAISE EXCEPTION 'Say why the invoice is voided.'; END IF;
  UPDATE billing_invoices SET status = 'void', void_reason = btrim(p_reason) WHERE id = p_id AND status = 'open' RETURNING firm_id INTO f;
  IF f IS NULL THEN RAISE EXCEPTION 'Only an open invoice can be voided.'; END IF;
  UPDATE subscriptions SET status = 'active' WHERE firm_id = f AND status = 'past_due'
    AND NOT EXISTS (SELECT 1 FROM billing_invoices b WHERE b.firm_id = f AND b.status = 'open' AND b.due_on < current_date);
END $$;

/** For billing emails: the customer's active Administrators. */
CREATE FUNCTION billing_recipients(p_firm uuid) RETURNS TABLE (name text, email text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (app_user_id() IS NULL OR app_is_owner()) THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  RETURN QUERY SELECT u.full_name, u.email FROM users u WHERE u.firm_id = p_firm AND u.kind = 'admin' AND u.status = 'active' ORDER BY u.full_name;
END $$;

ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_kind_check;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_kind_check
  CHECK (kind IN ('invitation', 'password_reset', 'document', 'statement', 'reminder', 'approval', 'notice', 'billing'));

-- ---------------------------------------------------------------------------
-- Access and audit
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_settings', 'plans', 'subscriptions', 'billing_invoices'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_is_owner())', t || '_owner_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_is_owner()) WITH CHECK (app_is_owner())', t || '_owner_update', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nusuh_app', t);
  END LOOP;
END $$;
-- Plans and the seller's details are shown to Administrators; subscriptions and invoices only to their own customer.
CREATE POLICY billing_settings_read ON billing_settings FOR SELECT USING (app_user_id() IS NOT NULL);
CREATE POLICY plans_read ON plans FOR SELECT USING (app_user_id() IS NOT NULL);
CREATE POLICY subscriptions_read ON subscriptions FOR SELECT USING (app_is_owner() OR (app_is_admin() AND firm_id = app_firm_id()));
CREATE POLICY billing_invoices_read ON billing_invoices FOR SELECT USING (app_is_owner() OR (app_is_admin() AND firm_id = app_firm_id()));

REVOKE ALL ON FUNCTION billing_can_see(uuid), billing_usage(uuid), billing_quote(uuid, date), billing_run(date), billing_mark_paid(uuid, date, text),
  billing_void(uuid, text), billing_recipients(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_can_see(uuid), billing_usage(uuid), billing_quote(uuid, date), billing_run(date), billing_mark_paid(uuid, date, text),
  billing_void(uuid, text), billing_recipients(uuid) TO nusuh_app;
