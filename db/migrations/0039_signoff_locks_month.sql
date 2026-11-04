-- 0039 A signed-off month is locked.
--
-- Until now a sign-off only recorded the review; the month stayed open for posting unless the partner also locked it.
-- Now, in the database and in the same transaction:
--   * signing off locks every period that overlaps the month, or creates the month's period locked when there is none
--     (a reviewer who cannot lock periods can still sign off);
--   * while a sign-off stands, nobody can unlock the month, the partner included;
--   * withdrawing the sign-off (always with a reason) unlocks the month again, unless year-end closing keeps it locked
--     or another standing sign-off still covers the same period;
--   * entries dated in a signed-off month are refused with the usual locked-period message, even on days no period
--     row covers.
-- Months that already have a standing sign-off are locked now.

CREATE FUNCTION signed_off_on(p_company uuid, p_day date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM review_signoffs s WHERE s.company_id = p_company AND s.withdrawn_at IS NULL
                 AND p_day BETWEEN date_trunc('month', s.period_end)::date AND s.period_end)
$$;

/** Is any day of this period inside a month with a standing sign-off? */
CREATE FUNCTION period_signed_off(p_company uuid, p_start date, p_end date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM review_signoffs s WHERE s.company_id = p_company AND s.withdrawn_at IS NULL
                 AND daterange(date_trunc('month', s.period_end)::date, s.period_end, '[]') && daterange(p_start, p_end, '[]'))
$$;

CREATE FUNCTION lock_signed_off_month(p_company uuid, p_end date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ms date := date_trunc('month', p_end)::date;
BEGIN
  UPDATE periods SET locked_at = now()
  WHERE company_id = p_company AND locked_at IS NULL AND daterange(start_date, end_date, '[]') && daterange(ms, p_end, '[]');
  IF NOT EXISTS (SELECT 1 FROM periods WHERE company_id = p_company AND daterange(start_date, end_date, '[]') && daterange(ms, p_end, '[]')) THEN
    INSERT INTO periods (company_id, start_date, end_date, locked_at) VALUES (p_company, ms, p_end, now());
  END IF;
END $$;

-- After the sign-off row is written (insert) or withdrawn (update): lock or reopen the month.
CREATE FUNCTION after_review_signoff_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ms date := date_trunc('month', NEW.period_end)::date;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM lock_signed_off_month(NEW.company_id, NEW.period_end);
  ELSIF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL THEN
    UPDATE periods p SET locked_at = NULL
    WHERE p.company_id = NEW.company_id AND p.locked_at IS NOT NULL
      AND daterange(p.start_date, p.end_date, '[]') && daterange(ms, NEW.period_end, '[]')
      AND NOT year_is_closed(p.company_id, p.start_date) AND NOT year_is_closed(p.company_id, p.end_date)
      AND NOT period_signed_off(p.company_id, p.start_date, p.end_date);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER review_signoffs_after_change AFTER INSERT OR UPDATE ON review_signoffs FOR EACH ROW EXECUTE FUNCTION after_review_signoff_change();

-- Nobody unlocks a signed-off month.
CREATE FUNCTION before_period_signed_off() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.locked_at IS NULL AND OLD.locked_at IS NOT NULL AND period_signed_off(NEW.company_id, NEW.start_date, NEW.end_date) THEN
    RAISE EXCEPTION 'This month is signed off. Withdraw the sign-off (with a reason) to reopen it.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER periods_signed_off BEFORE UPDATE ON periods FOR EACH ROW EXECUTE FUNCTION before_period_signed_off();

-- Entries dated in a signed-off month are refused, also on days no period row covers.
CREATE FUNCTION before_entry_signed_off() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL AND NOT app_has_role(NEW.company_id, posting_roles()) THEN
    RETURN NEW;   -- RLS rejects it; do not reveal the other company's sign-offs
  END IF;
  IF signed_off_on(NEW.company_id, NEW.entry_date) THEN
    RAISE EXCEPTION 'This period is locked. Choose a date in an open period.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER entries_signed_off BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION before_entry_signed_off();

GRANT EXECUTE ON FUNCTION signed_off_on(uuid, date), period_signed_off(uuid, date, date) TO nusuh_app;
REVOKE ALL ON FUNCTION lock_signed_off_month(uuid, date) FROM PUBLIC;

-- Months already signed off are locked now.
SELECT lock_signed_off_month(company_id, period_end) FROM review_signoffs WHERE withdrawn_at IS NULL;
