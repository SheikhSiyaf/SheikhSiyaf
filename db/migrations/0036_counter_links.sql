-- 0036 The warehouse counter joined to sales and purchases.
--
-- Goods out at the counter can make the customer's invoice in the same step (issued, at each item's sale price, and
-- paid on the spot when the customer pays there); goods in can make the supplier's bill as a draft for the
-- accountant (at the cost received, on 2050 Goods received not yet billed, so the bill clears it), optionally from the
-- purchase order. counter_links records which goods note made which document (and payment). Posted notes and issued
-- documents never change, so the link is its own row: written once, never changed or deleted.

CREATE TABLE counter_links (
  stock_note_id  uuid PRIMARY KEY REFERENCES stock_notes(id),
  company_id     uuid NOT NULL REFERENCES companies(id),
  document_id    uuid NOT NULL UNIQUE REFERENCES documents(id),
  payment_id     uuid REFERENCES payments(id),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION before_counter_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n stock_notes; d documents;
BEGIN
  SELECT * INTO n FROM stock_notes WHERE id = NEW.stock_note_id;
  SELECT * INTO d FROM documents WHERE id = NEW.document_id;
  IF n.status IS DISTINCT FROM 'posted' OR n.company_id <> NEW.company_id OR d.company_id <> NEW.company_id
     OR NOT ((n.type = 'gdn' AND d.type = 'invoice') OR (n.type = 'grn' AND d.type = 'bill'))
     OR n.contact_id IS DISTINCT FROM d.contact_id THEN
    RAISE EXCEPTION 'Goods out go with the customer''s invoice and goods in with the supplier''s bill, for the same customer or supplier.';
  END IF;
  IF NEW.payment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payment_allocations WHERE payment_id = NEW.payment_id AND document_id = NEW.document_id) THEN
    RAISE EXCEPTION 'The payment must be for this invoice.';
  END IF;
  NEW.created_by := app_user_id();
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER counter_links_before_insert BEFORE INSERT ON counter_links FOR EACH ROW EXECUTE FUNCTION before_counter_link();
CREATE TRIGGER counter_links_no_change BEFORE UPDATE OR DELETE ON counter_links FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER counter_links_audit AFTER INSERT OR UPDATE OR DELETE ON counter_links FOR EACH ROW EXECUTE FUNCTION audit_row();

ALTER TABLE counter_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY counter_links_read ON counter_links FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY counter_links_insert ON counter_links FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
GRANT SELECT, INSERT ON counter_links TO nusuh_app;
