-- 0082: what the invoice Nusuh Books sends to its customers needs to show, in the layout of a ZATCA standard tax invoice.
-- billing_settings: the seller's Arabic name and address and its commercial registration number (the English name, address and VAT number
--   were already there). The VAT number, when given, must be the 15 digits of a Saudi VAT number.
-- billing_invoices: the buyer as it was on the day the invoice was made (name in Arabic, VAT number, registration number, address), kept on the
--   invoice so a later change to the customer's company details never changes an invoice already sent. They are filled in by a trigger from the
--   customer's own company when the customer keeps its own books (a company customer); an accounting firm customer has no single company, so
--   those lines stay empty. Older invoices keep what they had (nothing is filled in afterwards: an issued invoice is not changed).
ALTER TABLE billing_settings
  ADD COLUMN seller_name_ar    text CHECK (seller_name_ar IS NULL OR (btrim(seller_name_ar) <> '' AND char_length(seller_name_ar) <= 100)),
  ADD COLUMN seller_address_ar text CHECK (seller_address_ar IS NULL OR (btrim(seller_address_ar) <> '' AND char_length(seller_address_ar) <= 300)),
  ADD COLUMN seller_cr         text CHECK (seller_cr IS NULL OR seller_cr ~ '^[0-9A-Za-z-]{5,30}$'),
  ADD CONSTRAINT billing_settings_seller_vat_shape CHECK (seller_vat IS NULL OR seller_vat ~ '^[0-9]{15}$');

ALTER TABLE billing_invoices
  ADD COLUMN buyer_name_ar text CHECK (char_length(buyer_name_ar) <= 160),
  ADD COLUMN buyer_vat     text CHECK (char_length(buyer_vat) <= 30),
  ADD COLUMN buyer_cr      text CHECK (char_length(buyer_cr) <= 30),
  ADD COLUMN buyer_address text CHECK (char_length(buyer_address) <= 400);

-- The buyer's details are copied once, when the invoice is made.
CREATE FUNCTION billing_invoice_buyer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c companies%ROWTYPE;
BEGIN
  IF (SELECT kind FROM firms WHERE id = NEW.firm_id) = 'company' THEN
    SELECT * INTO c FROM companies WHERE firm_id = NEW.firm_id ORDER BY created_at LIMIT 1;
    IF FOUND THEN
      NEW.buyer_name_ar := coalesce(NEW.buyer_name_ar, c.name_ar);
      NEW.buyer_vat     := coalesce(NEW.buyer_vat, c.vat_number);
      NEW.buyer_cr      := coalesce(NEW.buyer_cr, c.cr_number);
      NEW.buyer_address := coalesce(NEW.buyer_address, nullif(btrim(concat_ws(', ', nullif(c.address, 'To be completed in company settings'), c.city, CASE c.country WHEN 'SA' THEN 'Saudi Arabia' WHEN 'AE' THEN 'United Arab Emirates' WHEN 'OM' THEN 'Oman' END)), ''));
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER billing_invoices_buyer BEFORE INSERT ON billing_invoices FOR EACH ROW EXECUTE FUNCTION billing_invoice_buyer();
