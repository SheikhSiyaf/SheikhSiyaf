-- 0048 Sign-offs, partner locks and year-end closing work together.
--
-- 1. Year-end closing and reopening work when the year's last month is signed off. Until now closing unlocked the
--    year-end month to post the closing entry, which a standing sign-off refuses. Now the month is never unlocked:
--    the closing entry and the reversal that reopens the year are the only postings allowed in a locked or signed-off
--    month, and only when
--      * the closing entry is the partner's, not yet tied to a year, and a closed year names it by the end of the
--        same transaction (checked at commit, so an entry merely labelled 'year_end_close' is refused);
--      * the reversal is the partner's, of the closing entry of a year being reopened, dated on that year end.
-- 2. Withdrawing a sign-off unlocks only the periods the sign-off itself locked. periods.signoff_lock records it; a
--    month the partner locked (before or after) stays locked. People cannot set signoff_lock: only the sign-off
--    trigger does. Months already locked when this runs count as the partner's locks (the safe side).

ALTER TABLE periods ADD COLUMN signoff_lock boolean NOT NULL DEFAULT false;
REVOKE INSERT, UPDATE ON periods FROM nusuh_app;
GRANT INSERT (company_id, start_date, end_date, locked_at), UPDATE (locked_at) ON periods TO nusuh_app;

-- A partner's lock or unlock is the partner's: it is never a sign-off lock afterwards.
CREATE OR REPLACE FUNCTION before_period_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.start_date <> OLD.start_date OR NEW.end_date <> OLD.end_date THEN
    RAISE EXCEPTION 'Period dates cannot be changed. Only lock or unlock the period.';
  END IF;
  IF NEW.locked_at IS NULL THEN NEW.signoff_lock := false; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION lock_signed_off_month(p_company uuid, p_end date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ms date := date_trunc('month', p_end)::date;
BEGIN
  UPDATE periods SET locked_at = now(), signoff_lock = true
  WHERE company_id = p_company AND locked_at IS NULL AND daterange(start_date, end_date, '[]') && daterange(ms, p_end, '[]');
  IF NOT EXISTS (SELECT 1 FROM periods WHERE company_id = p_company AND daterange(start_date, end_date, '[]') && daterange(ms, p_end, '[]')) THEN
    INSERT INTO periods (company_id, start_date, end_date, locked_at, signoff_lock) VALUES (p_company, ms, p_end, now(), true);
  END IF;
END $$;
REVOKE ALL ON FUNCTION lock_signed_off_month(uuid, date) FROM PUBLIC;

CREATE OR REPLACE FUNCTION after_review_signoff_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ms date := date_trunc('month', NEW.period_end)::date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM lock_signed_off_month(NEW.company_id, NEW.period_end);
  ELSIF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL THEN
    UPDATE periods p SET locked_at = NULL
    WHERE p.company_id = NEW.company_id AND p.locked_at IS NOT NULL AND p.signoff_lock
      AND daterange(p.start_date, p.end_date, '[]') && daterange(ms, NEW.period_end, '[]')
      AND NOT year_is_closed(p.company_id, p.start_date) AND NOT year_is_closed(p.company_id, p.end_date)
      AND NOT period_signed_off(p.company_id, p.start_date, p.end_date);
  END IF;
  RETURN NULL;
END $$;

-- Year-end closing locks every month of the year: from then on those are the year's locks, not the sign-off's.
CREATE FUNCTION after_fiscal_year_closed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE periods SET signoff_lock = false
  WHERE company_id = NEW.company_id AND signoff_lock AND start_date BETWEEN NEW.start_date AND NEW.end_date;
  RETURN NULL;
END $$;
CREATE TRIGGER fiscal_years_after_close AFTER INSERT ON fiscal_years FOR EACH ROW EXECUTE FUNCTION after_fiscal_year_closed();

/** Is this new entry the closing entry, or its reopening reversal, of a year the partner is closing or reopening now? */
CREATE FUNCTION is_year_end_posting(e journal_entries) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(e.source_type = 'year_end_close' AND app_user_id() IS NOT NULL AND app_has_role(e.company_id, ARRAY['partner']::user_role[]) AND (
    (e.reverses_entry_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM fiscal_years f WHERE f.id = e.source_id)
      AND NOT EXISTS (SELECT 1 FROM journal_entries x WHERE x.source_type = 'year_end_close' AND x.source_id = e.source_id))
    OR (e.reverses_entry_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM fiscal_years f WHERE f.id = e.source_id AND f.company_id = e.company_id AND f.entry_id = e.reverses_entry_id
                  AND f.status = 'reopened' AND f.reopen_entry_id IS NULL AND f.end_date = e.entry_date))), false)
$$;

CREATE OR REPLACE FUNCTION before_entry_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.created_at   := now();
  NEW.created_xact := pg_current_xact_id();
  IF app_user_id() IS NOT NULL THEN
    NEW.created_by := app_user_id();
    IF NOT app_has_role(NEW.company_id, posting_roles()) THEN
      RETURN NEW;   -- RLS rejects it; do not reveal the other company's period locks
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM periods p WHERE p.company_id = NEW.company_id
             AND NEW.entry_date BETWEEN p.start_date AND p.end_date AND p.locked_at IS NOT NULL)
     AND NOT is_year_end_posting(NEW) THEN
    RAISE EXCEPTION 'This period is locked. Choose a date in an open period.';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION before_entry_signed_off() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL AND NOT app_has_role(NEW.company_id, posting_roles()) THEN
    RETURN NEW;   -- RLS rejects it; do not reveal the other company's sign-offs
  END IF;
  IF signed_off_on(NEW.company_id, NEW.entry_date) AND NOT is_year_end_posting(NEW) THEN
    RAISE EXCEPTION 'This period is locked. Choose a date in an open period.';
  END IF;
  RETURN NEW;
END $$;

-- A closing entry must belong to a closed year by the end of its transaction.
CREATE FUNCTION check_year_end_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fiscal_years f WHERE f.entry_id = NEW.id) THEN
    RAISE EXCEPTION 'A closing entry is posted only by closing the year.';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER entries_year_end_owned AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source_type = 'year_end_close' AND NEW.reverses_entry_id IS NULL) EXECUTE FUNCTION check_year_end_entry();
