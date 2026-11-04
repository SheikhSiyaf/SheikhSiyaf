-- 0038 Direct bank feeds. A bank account can be connected to the bank through an open-banking provider: its
-- transactions come in as statement lines by themselves (every six hours, or Sync now), exactly as an imported
-- statement would: the same duplicate check, match suggestions, rules and reconciliation.
--
-- The provider is an adapter (src/bankfeeds). Sandbox is built in for trying it out. Lean and Tarabut (licensed by SAMA
-- and the UAE Central Bank) need an agreement and keys before their adapters are written; the consent the customer
-- gives the bank lasts up to 90 days and is then renewed.

CREATE TABLE bank_feeds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  bank_account_id      uuid NOT NULL REFERENCES bank_accounts(id),
  provider             text NOT NULL CHECK (provider IN ('sandbox', 'lean', 'tarabut')),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'disconnected', 'error')),
  external_account_id  text,
  consent_expires_on   date,
  last_sync_at         timestamptz,
  synced_to            date,
  last_error           text,
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bank_feeds_one_live ON bank_feeds (bank_account_id) WHERE status <> 'disconnected';
ALTER TABLE bank_imports ADD COLUMN feed_id uuid REFERENCES bank_feeds(id);

CREATE FUNCTION before_bank_feed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now();
    IF NOT EXISTS (SELECT 1 FROM bank_accounts WHERE id = NEW.bank_account_id AND company_id = NEW.company_id AND kind = 'bank' AND status = 'active') THEN
      RAISE EXCEPTION 'Connect an active bank account of this company.';
    END IF;
  ELSIF NEW.company_id <> OLD.company_id OR NEW.bank_account_id <> OLD.bank_account_id OR NEW.provider <> OLD.provider OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'A bank feed stays with its bank account.';
  ELSIF OLD.status = 'disconnected' AND NEW.status <> 'disconnected' THEN
    RAISE EXCEPTION 'Connect the bank again: a disconnected feed stays disconnected.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_feeds_before_change BEFORE INSERT OR UPDATE ON bank_feeds FOR EACH ROW EXECUTE FUNCTION before_bank_feed();
CREATE TRIGGER bank_feeds_no_delete BEFORE DELETE ON bank_feeds FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER bank_feeds_audit AFTER INSERT OR UPDATE OR DELETE ON bank_feeds FOR EACH ROW EXECUTE FUNCTION audit_row();

/** For the sync job (nobody signed in): live feeds not synced in the last hours, with the person they run as. */
CREATE FUNCTION bank_feeds_due(p_hours int) RETURNS TABLE (id uuid, company_id uuid, run_as uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT f.id, f.company_id, f.created_by FROM bank_feeds f JOIN companies c ON c.id = f.company_id JOIN users u ON u.id = f.created_by
  WHERE f.status IN ('active', 'error') AND (f.last_sync_at IS NULL OR f.last_sync_at < now() - make_interval(hours => p_hours))
    AND c.status = 'active' AND u.status = 'active' AND app_user_id() IS NULL
$$;
/** For the sync job: a feed that could not sync says why (shown on the bank account). */
CREATE FUNCTION bank_feed_note(p_id uuid, p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE bank_feeds SET status = 'error', last_error = p_error, last_sync_at = now() WHERE id = p_id AND status = 'active' AND app_user_id() IS NULL
$$;

ALTER TABLE bank_feeds ENABLE ROW LEVEL SECURITY;
CREATE POLICY bank_feeds_read ON bank_feeds FOR SELECT USING (company_id = ANY (app_company_ids()));
CREATE POLICY bank_feeds_insert ON bank_feeds FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()));
CREATE POLICY bank_feeds_update ON bank_feeds FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));
GRANT SELECT, INSERT, UPDATE ON bank_feeds TO nusuh_app;
REVOKE ALL ON FUNCTION bank_feeds_due(int), bank_feed_note(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bank_feeds_due(int), bank_feed_note(uuid, text) TO nusuh_app;
