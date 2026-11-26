-- Fix: signup_done() added its two owner flags with  fl := fl || 'literal'. With an array on the left Postgres reads the quoted text as an array
-- ("malformed array literal"), so a second company with the same name, or a third sign-up from one address within a week, failed at the very last
-- step: the person saw "Some values are not in the right format" and nothing was created. The flags are now added as text.
CREATE OR REPLACE FUNCTION signup_done(p_email_key text, p_firm uuid, p_email text, p_company text, p_country text, p_ip_key text) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE fl text[] := ARRAY[]::text[];
BEGIN
  IF NOT (app_user_id() IS NULL OR app_is_owner()) THEN RAISE EXCEPTION 'Only the server does this.'; END IF;
  UPDATE trial_fingerprints SET firm_id = p_firm WHERE email_key = p_email_key;
  IF EXISTS (SELECT 1 FROM companies c WHERE lower(btrim(c.name)) = lower(btrim(p_company)) AND c.country = p_country AND c.firm_id <> p_firm) THEN fl := array_append(fl, 'same_company_name'::text); END IF;
  IF (SELECT count(*) FROM signup_events e WHERE e.ip_key = p_ip_key AND e.kind = 'verified' AND e.at > now() - interval '7 days') >= 2 THEN fl := array_append(fl, 'same_address_often'::text); END IF;
  INSERT INTO signup_events (kind, email_domain, email_key, company_name, country, ip_key, firm_id, flags) VALUES ('verified', split_part(lower(p_email), '@', 2), p_email_key, p_company, p_country, p_ip_key, p_firm, fl);
  RETURN fl;
END $$;
