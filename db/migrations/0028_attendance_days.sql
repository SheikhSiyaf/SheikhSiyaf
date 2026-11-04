-- 0028 Daily attendance from the time clock, and corrections that need approval.
--
-- hr_attendance_days: one status per person per day (present, absent, leave, off), read from a time-clock file.
-- The monthly sheet (hr_attendance: absent days and overtime hours, used by payroll) follows the days automatically.
-- Overturning is never done by hand:
--   * an absence becomes leave or an excused day, or an approved leave day becomes a working day, only through a
--     correction request (hr_attendance_corrections) approved by someone else with the approve right;
--   * an approved leave is cancelled only through such a request;
--   * leave approved over days the clock recorded as absent needs someone with the approve right who did not ask for it;
--   * a re-imported file never turns an absence or a leave day into something else.
-- Months with posted payroll do not change.

CREATE TABLE hr_attendance_imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  period_end  date NOT NULL,
  file_name   text,
  people      int NOT NULL DEFAULT 0,
  days        int NOT NULL DEFAULT 0,
  kept        int NOT NULL DEFAULT 0,          -- days not changed because only a correction may change them
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hr_attendance_days (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  contact_id      uuid NOT NULL REFERENCES contacts(id),
  day             date NOT NULL,
  status          text NOT NULL CHECK (status IN ('present', 'absent', 'leave', 'off')),
  check_in        smallint CHECK (check_in BETWEEN 0 AND 1439),        -- minutes after midnight
  check_out       smallint CHECK (check_out BETWEEN 0 AND 1439),
  worked_minutes  smallint CHECK (worked_minutes BETWEEN 0 AND 1440),
  overtime_minutes smallint NOT NULL DEFAULT 0 CHECK (overtime_minutes BETWEEN 0 AND 1440),
  leave_id        uuid REFERENCES leave_requests(id),
  import_id       uuid REFERENCES hr_attendance_imports(id),
  correction_id   uuid,                         -- the approved correction that last changed the day
  flags           text[] NOT NULL DEFAULT '{}',
  UNIQUE (contact_id, day),
  CHECK ((status = 'leave') = (leave_id IS NOT NULL)),
  CHECK (status = 'present' OR overtime_minutes = 0)
);
CREATE INDEX hr_attendance_days_month ON hr_attendance_days (company_id, day);

CREATE TABLE hr_attendance_corrections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id),
  contact_id    uuid NOT NULL REFERENCES contacts(id),
  kind          text NOT NULL CHECK (kind IN ('absence_to_leave', 'absence_excused', 'leave_to_working')),
  leave_kind    text CHECK (leave_kind IN ('annual', 'sick', 'unpaid', 'other_paid')),
  leave_id      uuid REFERENCES leave_requests(id),
  day_from      date NOT NULL,
  day_to        date NOT NULL,
  reason        text NOT NULL CHECK (btrim(reason) <> ''),
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'withdrawn')),
  decision_note text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  CHECK (day_to >= day_from AND day_to - day_from <= 62),
  CHECK ((kind = 'absence_to_leave') = (leave_kind IS NOT NULL)),
  CHECK ((kind = 'leave_to_working') = (leave_id IS NOT NULL))
);
ALTER TABLE hr_attendance_days ADD CONSTRAINT hr_attendance_days_correction FOREIGN KEY (correction_id) REFERENCES hr_attendance_corrections(id);

-- ---------------------------------------------------------------------------
-- The monthly sheet follows the days
-- ---------------------------------------------------------------------------
CREATE FUNCTION attendance_month_totals(p_contact uuid, p_period_end date) RETURNS TABLE (has_days boolean, absent int, overtime numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*) > 0, (count(*) FILTER (WHERE status = 'absent'))::int, least(round(coalesce(sum(overtime_minutes), 0) / 60.0, 2), 300)
  FROM hr_attendance_days WHERE contact_id = p_contact AND day BETWEEN date_trunc('month', p_period_end)::date AND p_period_end
$$;

CREATE FUNCTION sync_attendance_month(p_company uuid, p_contact uuid, p_day date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE pe date := (date_trunc('month', p_day) + interval '1 month - 1 day')::date; t record;
BEGIN
  SELECT * INTO t FROM attendance_month_totals(p_contact, pe);
  INSERT INTO hr_attendance (company_id, contact_id, period_end, absent_days, overtime_hours, notes)
  VALUES (p_company, p_contact, pe, t.absent, t.overtime, NULL)
  ON CONFLICT (contact_id, period_end) DO UPDATE SET absent_days = EXCLUDED.absent_days, overtime_hours = EXCLUDED.overtime_hours;
END $$;

/** By hand, a month that comes from the time clock keeps its absent days and overtime (notes may change). */
CREATE FUNCTION before_hr_attendance_clock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t record;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  SELECT * INTO t FROM attendance_month_totals(NEW.contact_id, NEW.period_end);
  IF t.has_days AND (NEW.absent_days <> t.absent OR NEW.overtime_hours <> t.overtime) THEN
    RAISE EXCEPTION 'This month comes from the time clock: absences change only through an approved correction.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hr_attendance_clock BEFORE INSERT OR UPDATE ON hr_attendance FOR EACH ROW EXECUTE FUNCTION before_hr_attendance_clock();

-- ---------------------------------------------------------------------------
-- Days
-- ---------------------------------------------------------------------------
CREATE FUNCTION before_attendance_day_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF payroll_posted_between(NEW.company_id, NEW.day, NEW.day) OR (TG_OP = 'UPDATE' AND payroll_posted_between(OLD.company_id, OLD.day, OLD.day)) THEN
    RAISE EXCEPTION 'Payroll for this month is posted, so its attendance no longer changes.';
  END IF;
  IF NOT is_company_employee(NEW.company_id, NEW.contact_id) THEN RAISE EXCEPTION 'Choose an employee of this company.'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id <> OLD.company_id OR NEW.contact_id <> OLD.contact_id OR NEW.day <> OLD.day THEN RAISE EXCEPTION 'A day of attendance stays with its person.'; END IF;
    IF OLD.status IN ('absent', 'leave') AND NEW.status <> OLD.status AND pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'An absence or a leave day changes only through an approved correction.';
    END IF;
    IF OLD.correction_id IS NOT NULL AND pg_trigger_depth() < 2 AND (NEW.status <> OLD.status OR NEW.correction_id IS DISTINCT FROM OLD.correction_id) THEN
      RAISE EXCEPTION 'This day was corrected with approval; it changes only through another correction.';
    END IF;
  END IF;
  IF NEW.status = 'leave' AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.id = NEW.leave_id AND l.contact_id = NEW.contact_id
       AND l.status = 'approved' AND NEW.day BETWEEN l.start_date AND l.end_date) THEN
    RAISE EXCEPTION 'A leave day needs approved leave covering it.';
  END IF;
  IF NEW.correction_id IS NOT NULL AND pg_trigger_depth() < 2 AND (TG_OP = 'INSERT' OR NEW.correction_id IS DISTINCT FROM OLD.correction_id) THEN
    RAISE EXCEPTION 'Corrections are applied when they are approved.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hr_attendance_days_before_change BEFORE INSERT OR UPDATE ON hr_attendance_days FOR EACH ROW EXECUTE FUNCTION before_attendance_day_change();
CREATE TRIGGER hr_attendance_days_no_delete BEFORE DELETE ON hr_attendance_days FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION after_attendance_day_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM sync_attendance_month(NEW.company_id, NEW.contact_id, NEW.day);
  RETURN NULL;
END $$;
CREATE TRIGGER hr_attendance_days_after_change AFTER INSERT OR UPDATE ON hr_attendance_days FOR EACH ROW EXECUTE FUNCTION after_attendance_day_change();

-- ---------------------------------------------------------------------------
-- Leave and the days it covers
-- ---------------------------------------------------------------------------
CREATE FUNCTION before_leave_overturn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
  -- Cancelling or rejecting leave that was approved: only through a correction request.
  IF TG_OP = 'UPDATE' AND OLD.status = 'approved' AND NEW.status <> 'approved' THEN
    RAISE EXCEPTION 'Approved leave is overturned only through a correction request approved by someone else.';
  END IF;
  -- Approving leave over days the clock recorded as absent turns absences into leave: someone else with the approve right.
  IF NEW.status = 'approved' AND (TG_OP = 'INSERT' OR OLD.status <> 'approved') AND EXISTS (
       SELECT 1 FROM hr_attendance_days d WHERE d.contact_id = NEW.contact_id AND d.day BETWEEN NEW.start_date AND NEW.end_date AND d.status = 'absent')
     AND (NOT app_can_approve(NEW.company_id) OR app_user_id() = NEW.created_by) THEN
    RAISE EXCEPTION 'Some of these days are recorded absent by the time clock. Leave over them is approved by someone else with the approve right.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER leave_requests_overturn BEFORE INSERT OR UPDATE ON leave_requests FOR EACH ROW EXECUTE FUNCTION before_leave_overturn();

/** Approved leave marks the recorded days in it as leave; leave no longer approved puts them back (clocked in: present, else absent). */
CREATE FUNCTION after_leave_days() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'approved' AND (TG_OP = 'INSERT' OR OLD.status <> 'approved') THEN
    UPDATE hr_attendance_days SET status = 'leave', leave_id = NEW.id, overtime_minutes = 0
    WHERE contact_id = NEW.contact_id AND day BETWEEN NEW.start_date AND NEW.end_date AND status IN ('absent', 'present');
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'approved' AND NEW.status <> 'approved' THEN
    UPDATE hr_attendance_days SET status = CASE WHEN check_in IS NOT NULL OR check_out IS NOT NULL THEN 'present' ELSE 'absent' END, leave_id = NULL
    WHERE leave_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER leave_requests_days AFTER INSERT OR UPDATE ON leave_requests FOR EACH ROW EXECUTE FUNCTION after_leave_days();

-- ---------------------------------------------------------------------------
-- Correction requests
-- ---------------------------------------------------------------------------
CREATE FUNCTION before_correction_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l leave_requests%ROWTYPE; bad int; total int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now(); NEW.status := 'requested'; NEW.decided_by := NULL; NEW.decided_at := NULL; NEW.decision_note := NULL;
    IF NOT is_company_employee(NEW.company_id, NEW.contact_id) THEN RAISE EXCEPTION 'Choose an employee of this company.'; END IF;
    IF payroll_posted_between(NEW.company_id, NEW.day_from, NEW.day_to) THEN RAISE EXCEPTION 'Payroll is posted for these dates, so their attendance no longer changes.'; END IF;
    IF NEW.kind = 'leave_to_working' THEN
      SELECT * INTO l FROM leave_requests WHERE id = NEW.leave_id;
      IF l.id IS NULL OR l.contact_id <> NEW.contact_id OR l.status <> 'approved' OR NEW.day_from < l.start_date OR NEW.day_to > l.end_date THEN
        RAISE EXCEPTION 'Choose days inside this person''s approved leave.';
      END IF;
    ELSE
      SELECT count(*), count(*) FILTER (WHERE status <> 'absent') INTO total, bad FROM hr_attendance_days
      WHERE contact_id = NEW.contact_id AND day BETWEEN NEW.day_from AND NEW.day_to AND status <> 'off';
      IF total = 0 OR bad > 0 THEN RAISE EXCEPTION 'Choose days the time clock recorded as absent.'; END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM hr_attendance_corrections c WHERE c.contact_id = NEW.contact_id AND c.status = 'requested'
         AND c.day_from <= NEW.day_to AND c.day_to >= NEW.day_from) THEN
      RAISE EXCEPTION 'A correction for some of these days is already waiting.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.contact_id <> OLD.contact_id OR NEW.kind <> OLD.kind OR NEW.leave_kind IS DISTINCT FROM OLD.leave_kind
     OR NEW.leave_id IS DISTINCT FROM OLD.leave_id OR NEW.day_from <> OLD.day_from OR NEW.day_to <> OLD.day_to OR NEW.reason <> OLD.reason OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'A correction request is not changed. Withdraw it and ask again.';
  END IF;
  IF OLD.status <> 'requested' THEN RAISE EXCEPTION 'This correction has been decided.'; END IF;
  IF NEW.status = 'withdrawn' THEN
    IF app_user_id() IS DISTINCT FROM OLD.created_by THEN RAISE EXCEPTION 'Only the person who asked can withdraw it.'; END IF;
  ELSIF NEW.status IN ('approved', 'rejected') THEN
    IF NOT app_can_approve(NEW.company_id) THEN RAISE EXCEPTION 'Your role does not allow approving.'; END IF;
    IF app_user_id() = OLD.created_by THEN RAISE EXCEPTION 'Someone else approves a correction you asked for.'; END IF;
    IF NEW.status = 'rejected' AND coalesce(btrim(NEW.decision_note), '') = '' THEN RAISE EXCEPTION 'Say why it is rejected.'; END IF;
  ELSIF NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'Approve, reject or withdraw.';
  END IF;
  NEW.decided_by := app_user_id(); NEW.decided_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER hr_attendance_corrections_before_change BEFORE INSERT OR UPDATE ON hr_attendance_corrections FOR EACH ROW EXECUTE FUNCTION before_correction_change();
CREATE TRIGGER hr_attendance_corrections_no_delete BEFORE DELETE ON hr_attendance_corrections FOR EACH ROW EXECUTE FUNCTION forbid_change();

/** An approved correction is applied at once. */
CREATE FUNCTION after_correction_approved() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l leave_requests%ROWTYPE; nid uuid;
BEGIN
  IF NOT (NEW.status = 'approved' AND OLD.status = 'requested') THEN RETURN NULL; END IF;
  IF NEW.kind = 'absence_to_leave' THEN
    -- The leave is approved by the person approving the correction; the days follow it (after_leave_days).
    INSERT INTO leave_requests (company_id, contact_id, kind, start_date, end_date, days, reason, status, created_by)
    VALUES (NEW.company_id, NEW.contact_id, NEW.leave_kind, NEW.day_from, NEW.day_to, NEW.day_to - NEW.day_from + 1, NEW.reason, 'approved', NEW.decided_by)
    RETURNING id INTO nid;
    UPDATE hr_attendance_days SET correction_id = NEW.id WHERE contact_id = NEW.contact_id AND day BETWEEN NEW.day_from AND NEW.day_to AND status = 'leave';
  ELSIF NEW.kind = 'absence_excused' THEN
    UPDATE hr_attendance_days SET status = 'present', correction_id = NEW.id
    WHERE contact_id = NEW.contact_id AND day BETWEEN NEW.day_from AND NEW.day_to AND status = 'absent';
  ELSE
    SELECT * INTO l FROM leave_requests WHERE id = NEW.leave_id FOR UPDATE;
    IF l.status <> 'approved' THEN RAISE EXCEPTION 'This leave is no longer approved.'; END IF;
    UPDATE leave_requests SET status = 'cancelled' WHERE id = l.id;
    -- What is left of the leave before and after the days given back stays approved.
    IF NEW.day_from > l.start_date THEN
      INSERT INTO leave_requests (company_id, contact_id, kind, start_date, end_date, days, reason, status, created_by)
      VALUES (l.company_id, l.contact_id, l.kind, l.start_date, NEW.day_from - 1, NEW.day_from - l.start_date, l.reason, 'approved', NEW.decided_by);
    END IF;
    IF NEW.day_to < l.end_date THEN
      INSERT INTO leave_requests (company_id, contact_id, kind, start_date, end_date, days, reason, status, created_by)
      VALUES (l.company_id, l.contact_id, l.kind, NEW.day_to + 1, l.end_date, l.end_date - NEW.day_to, l.reason, 'approved', NEW.decided_by);
    END IF;
    UPDATE hr_attendance_days SET status = 'present', correction_id = NEW.id
    WHERE contact_id = NEW.contact_id AND day BETWEEN NEW.day_from AND NEW.day_to AND status IN ('absent', 'present');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER hr_attendance_corrections_apply AFTER UPDATE ON hr_attendance_corrections FOR EACH ROW EXECUTE FUNCTION after_correction_approved();

-- ---------------------------------------------------------------------------
-- Access and audit
-- ---------------------------------------------------------------------------
CREATE FUNCTION before_attendance_import() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER hr_attendance_imports_before_insert BEFORE INSERT ON hr_attendance_imports FOR EACH ROW EXECUTE FUNCTION before_attendance_import();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hr_attendance_imports', 'hr_attendance_days', 'hr_attendance_corrections'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_insert', t);
  END LOOP;
END $$;
CREATE POLICY hr_attendance_days_update ON hr_attendance_days FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()));
-- Deciding: approvers (who may not post, such as a reviewer); withdrawing: the person who asked.
CREATE POLICY hr_attendance_corrections_update ON hr_attendance_corrections FOR UPDATE
  USING (app_can_approve(company_id) OR created_by = app_user_id()) WITH CHECK (app_can_approve(company_id) OR created_by = app_user_id());
GRANT SELECT, INSERT ON hr_attendance_imports TO nusuh_app;
GRANT SELECT, INSERT, UPDATE ON hr_attendance_days, hr_attendance_corrections TO nusuh_app;
