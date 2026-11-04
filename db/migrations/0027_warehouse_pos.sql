-- 0027 Warehouse counter: a barcode on every item, and counter roles (POS users).
--
-- items.barcode: the code scanned at the warehouse counter. A client can type the supplier's code (EAN-13, UPC or
-- any code its scanner reads); when left empty, Nusuh makes one: 2 + 11 digits + check digit (EAN-13 in the range
-- for a shop's own use), so goods received without a code can still be labelled and scanned.
-- client_roles.pos_mode: people with this role see only the counter screens (warehouse desk, restaurant order pad),
-- not the books menu. What they can do is still set by the role's modules.

CREATE SEQUENCE item_barcode_seq START 1;

CREATE FUNCTION ean13_check(p_body text) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT (10 - (sum(substr(p_body, i, 1)::int * CASE WHEN (length(p_body) - i) % 2 = 0 THEN 3 ELSE 1 END) % 10)::int) % 10
  FROM generate_series(1, length(p_body)) AS i
$$;

ALTER TABLE items ADD COLUMN barcode text;

CREATE FUNCTION before_item_barcode() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE body text;
BEGIN
  NEW.barcode := regexp_replace(coalesce(NEW.barcode, ''), '\s+', '', 'g');
  IF NEW.barcode = '' THEN
    body := '2' || lpad(nextval('item_barcode_seq')::text, 11, '0');
    NEW.barcode := body || ean13_check(body)::text;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER items_barcode BEFORE INSERT OR UPDATE OF barcode ON items FOR EACH ROW EXECUTE FUNCTION before_item_barcode();

-- Items made before this get their own code now.
UPDATE items SET barcode = NULL;
ALTER TABLE items ALTER COLUMN barcode SET NOT NULL,
  ADD CONSTRAINT items_barcode_printable CHECK (barcode ~ '^[!-~]{1,48}$');
CREATE UNIQUE INDEX items_company_barcode_key ON items (company_id, barcode);

-- Counter roles.
ALTER TABLE client_roles ADD COLUMN pos_mode boolean NOT NULL DEFAULT false;

DROP FUNCTION app_client_role(uuid);
CREATE FUNCTION app_client_role(p_company uuid)
RETURNS TABLE (permissions jsonb, can_approve boolean, name text, name_ar text, can_review boolean, can_sign_off boolean, pos_mode boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.permissions, r.can_approve, r.name, r.name_ar, r.can_review, r.can_sign_off, r.pos_mode FROM memberships m JOIN client_roles r ON r.id = m.client_role_id
  WHERE m.user_id = app_user_id() AND m.company_id = p_company
$$;
GRANT EXECUTE ON FUNCTION app_client_role(uuid) TO nusuh_app;
