-- 0068 The new pricing: a one-time software price, an optional one-time implementation ("accounts fixation") price, and a
-- yearly membership with a charge for each additional (optional) module. It replaces the monthly plans for every kind of customer.
--   one-time software price          9,000   billed once, on the customer's first invoice
--   implementation (accounts fixation) 5,000 optional, chosen per customer, billed once on the first invoice
--   annual membership                1,500   every year, the core modules included (sales, purchases, expenses, bank, journal,
--                                            ledger, reports)
--   each additional module             500   every year, for each optional module switched on (inventory, restaurant, rooms,
--                                            assets, rentals, projects, HR, CRM). For a customer with several companies
--                                            (an accounting firm) a module is counted once however many of its companies use it.
-- Amounts are before VAT; VAT is added on the invoice as before. The old plans stay in the table, off sale.

ALTER TABLE plans
  ADD COLUMN setup_price          numeric(18,2) NOT NULL DEFAULT 0 CHECK (setup_price >= 0),
  ADD COLUMN implementation_price numeric(18,2) NOT NULL DEFAULT 0 CHECK (implementation_price >= 0),
  ADD COLUMN extra_module_price   numeric(18,2) NOT NULL DEFAULT 0 CHECK (extra_module_price >= 0),   -- per module, per year
  ADD COLUMN annual               boolean NOT NULL DEFAULT false;   -- billed yearly only
ALTER TABLE subscriptions
  ADD COLUMN implementation boolean NOT NULL DEFAULT false,   -- the customer chose the implementation service
  ADD COLUMN setup_billed   boolean NOT NULL DEFAULT false;   -- the one-time charges are on an invoice already

-- What a customer uses today, now also the optional modules its active companies have switched on (each counted once).
DROP FUNCTION billing_usage(uuid);
CREATE FUNCTION billing_usage(p_firm uuid) RETURNS TABLE (companies int, users int, modules int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT billing_can_see(p_firm) THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  RETURN QUERY SELECT
    (SELECT count(*) FROM companies c WHERE c.firm_id = p_firm AND c.status = 'active')::int,
    (SELECT count(*) FROM users u WHERE u.firm_id = p_firm AND u.status = 'active' AND u.kind IN ('firm_staff', 'client'))::int,
    (SELECT count(DISTINCT m) FROM companies c, unnest(c.modules) m
      WHERE c.firm_id = p_firm AND c.status = 'active'
        AND m IN ('Inventory', 'Restaurant', 'Rooms', 'Assets', 'Rentals', 'Projects', 'HRM', 'CRM'))::int;
END $$;
REVOKE ALL ON FUNCTION billing_usage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_usage(uuid) TO nusuh_app;

-- The bill for one period: for an annual plan the lines are the one-time software price (first invoice only), the implementation
-- price (first invoice only, if chosen), the yearly membership, and the additional modules. The older plans bill as before.
CREATE OR REPLACE FUNCTION billing_quote(p_firm uuid, p_start date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s subscriptions; p plans; st billing_settings; u record; months int; ec int; eu int; lines jsonb := '[]';
        sub numeric; disc numeric; vat numeric; base numeric; mods int;
BEGIN
  IF NOT billing_can_see(p_firm) THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  SELECT * INTO s FROM subscriptions WHERE firm_id = p_firm;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO p FROM plans WHERE id = s.plan_id;
  SELECT * INTO st FROM billing_settings;
  SELECT * INTO u FROM billing_usage(p_firm);
  months := CASE s.cycle WHEN 'yearly' THEN 12 ELSE 1 END;
  base := CASE s.cycle WHEN 'yearly' THEN p.yearly_price ELSE p.monthly_price END;
  IF p.annual THEN
    IF NOT s.setup_billed AND p.setup_price > 0 THEN
      lines := lines || jsonb_build_object('key', 'software', 'quantity', 1, 'unitPrice', p.setup_price, 'amount', p.setup_price);
    END IF;
    IF NOT s.setup_billed AND s.implementation AND p.implementation_price > 0 THEN
      lines := lines || jsonb_build_object('key', 'implementation', 'quantity', 1, 'unitPrice', p.implementation_price, 'amount', p.implementation_price);
    END IF;
    lines := lines || jsonb_build_object('key', 'membership', 'name', p.name, 'quantity', 1, 'unitPrice', base, 'amount', base);
    mods := u.modules;
    IF mods > 0 AND p.extra_module_price > 0 THEN
      lines := lines || jsonb_build_object('key', 'extraModules', 'quantity', mods, 'months', 12, 'unitPrice', p.extra_module_price,
                                           'amount', mods * p.extra_module_price);
    END IF;
  ELSE
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
  END IF;
  sub := (SELECT coalesce(sum((l->>'amount')::numeric), 0) FROM jsonb_array_elements(lines) l);
  disc := round(sub * s.discount_pct / 100, 2);
  vat := round((sub - disc) * st.vat_rate / 100, 2);
  RETURN jsonb_build_object(
    'planName', p.name, 'cycle', s.cycle, 'periodStart', p_start,
    'periodEnd', ((p_start + make_interval(months => months)) - interval '1 day')::date,
    'currency', st.currency, 'lines', lines, 'subtotal', sub, 'discount', disc, 'vatRate', st.vat_rate, 'vat', vat, 'total', sub - disc + vat,
    'companies', u.companies, 'users', u.users, 'modules', u.modules, 'includedCompanies', p.included_companies, 'includedUsers', p.included_users);
END $$;

-- billing_run is the same, except that once the one-time charges are on an invoice they are marked billed (never charged twice).
CREATE OR REPLACE FUNCTION billing_run(p_day date)
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
      UPDATE subscriptions SET next_bill_on = s.next_bill_on, status = CASE WHEN status = 'trial' THEN 'active' ELSE status END,
                               setup_billed = setup_billed OR EXISTS (SELECT 1 FROM jsonb_array_elements(q->'lines') l WHERE l->>'key' IN ('software', 'implementation'))
      WHERE id = s.id;
    END LOOP;
  END LOOP;
  UPDATE subscriptions x SET status = 'past_due'
  WHERE x.status = 'active' AND EXISTS (SELECT 1 FROM billing_invoices b WHERE b.firm_id = x.firm_id AND b.status = 'open' AND b.due_on < p_day);
END $$;

-- The new plan replaces the old ones (which stay in the table, off sale, so existing subscriptions and invoices are kept).
UPDATE plans SET active = false WHERE code IN ('starter', 'business', 'firm', 'firm_plus');
INSERT INTO plans (code, name, name_ar, for_kind, monthly_price, yearly_price, included_companies, included_users, extra_company_price, extra_user_price,
                   trial_days, setup_price, implementation_price, extra_module_price, annual)
VALUES ('nusuh', 'Nusuh Books', 'نصوح بوكس', 'any', 0, 1500, 100000, 100000, 0, 0, 0, 9000, 5000, 500, true);
