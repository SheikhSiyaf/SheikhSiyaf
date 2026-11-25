-- 0078 A company that signed up by itself can complete its own address, legal form, VAT status and contact details.
-- Company details are otherwise changed only by the platform owner (0023): the company's name, registration number and country stay that way
-- for everybody (the registration number is what limits a company to one free trial). This adds ONE narrow function, not a policy:
-- it works only for the person who manages the company's users, only in their own customer, and only for a customer that came through
-- self-service sign-up. Customers the owner created by hand are unchanged. Row-level security is not touched.
CREATE FUNCTION self_company_update(p_company uuid, p_legal_form text, p_address text, p_city text, p_vat_status text, p_vat_number text, p_vat_registration_date date,
                                    p_phone text, p_email text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE co companies;
BEGIN
  IF app_user_id() IS NULL OR app_is_owner() OR NOT app_is_admin() THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  SELECT * INTO co FROM companies WHERE id = p_company AND firm_id = app_firm_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM trial_fingerprints WHERE firm_id = co.firm_id) THEN RAISE EXCEPTION 'Not allowed.'; END IF;
  IF p_vat_status NOT IN ('registered', 'unregistered') THEN RAISE EXCEPTION 'Choose the VAT status.'; END IF;
  IF btrim(coalesce(p_address, '')) = '' OR btrim(coalesce(p_city, '')) = '' OR btrim(coalesce(p_legal_form, '')) = '' THEN RAISE EXCEPTION 'Enter the address, city and legal form.'; END IF;
  UPDATE companies SET legal_form = btrim(p_legal_form), address = btrim(p_address), city = btrim(p_city), vat_status = p_vat_status::vat_status,
    vat_number = CASE WHEN p_vat_status = 'registered' THEN nullif(btrim(p_vat_number), '') END,
    vat_registration_date = CASE WHEN p_vat_status = 'registered' THEN p_vat_registration_date END,
    vat_rate = CASE WHEN p_vat_status = 'registered' THEN (CASE co.country WHEN 'SA' THEN 15 WHEN 'AE' THEN 5 ELSE vat_rate END) ELSE 0 END,
    phone = nullif(btrim(coalesce(p_phone, '')), ''), email = nullif(btrim(coalesce(p_email, '')), '')
  WHERE id = p_company;
END $$;
REVOKE ALL ON FUNCTION self_company_update(uuid, text, text, text, text, text, date, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION self_company_update(uuid, text, text, text, text, text, date, text, text) TO nusuh_app;
