-- 0017: HRM: employee HR details, attendance, leave, loans and advances, monthly payroll with social insurance,
-- end of service provision and final settlement, HR documents with expiry dates.
--   * Amounts are worked out by src/books/payroll.ts (tested by hand in test/payroll.rules.test.ts). The database
--     checks that each payroll line adds up, that posted payroll never changes, and that every posting has its own
--     journal entry with the right totals.
--   * Posting a payroll run: Dr 5200 Salaries (earned pay less other deductions), Dr 5210 Social insurance (employer),
--     Dr 5220 End of service benefits / Cr 2230 End of service provision (the month's change), Cr 2220 Social insurance
--     payable (employee + employer), Cr 1150 Employee loans and advances (repayments), Cr 2210 Salaries payable (net).
--   * Paying it: Dr 2210 / Cr bank. A loan: Dr 1150 / Cr bank. A final settlement: Dr 2230 (the person's provision),
--     Dr or Cr 5220 for the difference, Dr 5200 for unused leave, Cr 1150 for a loan still open, Cr 2210 (to pay).
--   * Months with posted payroll are fixed: their attendance and leave can no longer change.

INSERT INTO accounts (company_id, code, name, name_ar, type)
SELECT c.id, v.code, v.name, v.name_ar, v.type::account_type
FROM companies c CROSS JOIN (VALUES
  ('1150', 'Employee loans and advances', 'سلف وقروض الموظفين', 'asset'),
  ('2210', 'Salaries payable', 'الرواتب المستحقة', 'liability'),
  ('2220', 'Social insurance payable', 'التأمينات الاجتماعية المستحقة', 'liability'),
  ('2230', 'End of service provision', 'مخصص مكافأة نهاية الخدمة', 'liability'),
  ('5210', 'Social insurance', 'التأمينات الاجتماعية', 'expense'),
  ('5220', 'End of service benefits', 'مكافأة نهاية الخدمة', 'expense')) v(code, name, name_ar, type)
WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id)
ON CONFLICT (company_id, code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Employee HR details (one row per employee contact)
-- ---------------------------------------------------------------------------
CREATE TABLE employee_profiles (
  contact_id           uuid PRIMARY KEY REFERENCES contacts(id),
  company_id           uuid NOT NULL REFERENCES companies(id),
  nationality          char(2) NOT NULL CHECK (nationality ~ '^[A-Z]{2}$'),
  id_number            text,               -- national ID, iqama or Emirates ID
  passport_no          text,
  date_of_birth        date,
  join_date            date NOT NULL,
  contract_type        text NOT NULL DEFAULT 'unlimited' CHECK (contract_type IN ('limited', 'unlimited')),
  contract_end         date,
  basic                numeric(18,2) NOT NULL CHECK (basic > 0),
  housing              numeric(18,2) NOT NULL DEFAULT 0 CHECK (housing >= 0),
  transport            numeric(18,2) NOT NULL DEFAULT 0 CHECK (transport >= 0),
  other_allowance      numeric(18,2) NOT NULL DEFAULT 0 CHECK (other_allowance >= 0),
  iban                 text,
  bank_routing         text,               -- UAE: the bank's or exchange house's routing (agent) code
  wps_person_id        text,               -- UAE: labour personal number; Saudi: not used
  insurance_no         text,               -- GOSI or GPSSA number
  insurance_registered date,               -- Saudi: first GOSI registration (old or new annuity system)
  annual_leave_days    int CHECK (annual_leave_days BETWEEN 0 AND 60),   -- NULL = the law's days
  opening_leave_days   numeric(8,2) NOT NULL DEFAULT 0,                  -- balance brought in at opening_as_of
  opening_as_of        date,
  opening_eos          numeric(18,2) NOT NULL DEFAULT 0 CHECK (opening_eos >= 0),   -- provision already in the books before Nusuh Books
  leaving_date         date,
  leaving_reason       text CHECK (leaving_reason IN ('resignation', 'termination', 'contract_end', 'retirement', 'death', 'other')),
  CHECK (contract_end IS NULL OR contract_end >= join_date),
  CHECK (leaving_date IS NULL OR leaving_date >= join_date),
  CHECK ((leaving_date IS NULL) = (leaving_reason IS NULL))
);

CREATE TABLE company_hr_settings (
  company_id     uuid PRIMARY KEY REFERENCES companies(id),
  employer_id    text,     -- UAE: MOHRE establishment ID for WPS; Saudi: establishment number for Mudad
  bank_routing   text,     -- UAE: the employer's bank routing code for WPS
  insurance_no   text      -- GOSI / GPSSA employer number
);

-- ---------------------------------------------------------------------------
-- Attendance (one sheet line per employee per month), leave, loans
-- ---------------------------------------------------------------------------
CREATE TABLE hr_attendance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  contact_id     uuid NOT NULL REFERENCES contacts(id),
  period_end     date NOT NULL CHECK (period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date),
  absent_days    int NOT NULL DEFAULT 0 CHECK (absent_days BETWEEN 0 AND 31),
  overtime_hours numeric(6,2) NOT NULL DEFAULT 0 CHECK (overtime_hours >= 0 AND overtime_hours <= 300),
  notes          text,
  UNIQUE (contact_id, period_end)
);

CREATE TABLE leave_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  contact_id  uuid NOT NULL REFERENCES contacts(id),
  kind        text NOT NULL CHECK (kind IN ('annual', 'sick', 'unpaid', 'other_paid')),
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  days        int NOT NULL CHECK (days > 0),
  reason      text,
  status      text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_by  uuid REFERENCES users(id),
  decided_at  timestamptz,
  CHECK (end_date >= start_date AND days = end_date - start_date + 1)
);
CREATE INDEX leave_requests_employee ON leave_requests (contact_id, start_date);

CREATE TABLE employee_loans (
  id            uuid PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES companies(id),
  contact_id    uuid NOT NULL REFERENCES contacts(id),
  number        text NOT NULL,
  issue_date    date NOT NULL,
  amount        numeric(18,2) NOT NULL CHECK (amount > 0),
  installment   numeric(18,2) NOT NULL CHECK (installment > 0),
  paid_from     uuid NOT NULL REFERENCES accounts(id),
  entry_id      uuid NOT NULL UNIQUE REFERENCES journal_entries(id),
  notes         text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number),
  CHECK (installment <= amount)
);

-- ---------------------------------------------------------------------------
-- Payroll
-- ---------------------------------------------------------------------------
CREATE TABLE payroll_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  period_end       date NOT NULL CHECK (period_end = (date_trunc('month', period_end) + interval '1 month - 1 day')::date),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'paid')),
  total_gross      numeric(18,2) NOT NULL DEFAULT 0,
  total_net        numeric(18,2) NOT NULL DEFAULT 0,
  total_employer   numeric(18,2) NOT NULL DEFAULT 0,
  entry_id         uuid UNIQUE REFERENCES journal_entries(id),
  paid_from        uuid REFERENCES accounts(id),
  paid_on          date,
  payment_entry_id uuid UNIQUE REFERENCES journal_entries(id),
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  posted_by        uuid REFERENCES users(id),
  posted_at        timestamptz,
  UNIQUE (company_id, period_end),
  CHECK ((status = 'draft') = (entry_id IS NULL)),
  CHECK ((status = 'paid') = (payment_entry_id IS NOT NULL))
);

CREATE TABLE payroll_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id),
  run_id             uuid NOT NULL REFERENCES payroll_runs(id),
  contact_id         uuid NOT NULL REFERENCES contacts(id),
  cost_centre_id     uuid REFERENCES cost_centres(id),
  -- what was entered or brought in
  unpaid_days        int NOT NULL DEFAULT 0 CHECK (unpaid_days >= 0),
  absent_days        int NOT NULL DEFAULT 0 CHECK (absent_days >= 0),
  sick_unpaid        int NOT NULL DEFAULT 0 CHECK (sick_unpaid >= 0),   -- hundredths of a day
  overtime_hours     numeric(6,2) NOT NULL DEFAULT 0 CHECK (overtime_hours >= 0),
  loan_id            uuid REFERENCES employee_loans(id),
  note               text,
  -- the pay
  basic              numeric(18,2) NOT NULL CHECK (basic >= 0),
  housing            numeric(18,2) NOT NULL CHECK (housing >= 0),
  transport          numeric(18,2) NOT NULL CHECK (transport >= 0),
  other_allowance    numeric(18,2) NOT NULL CHECK (other_allowance >= 0),
  overtime           numeric(18,2) NOT NULL CHECK (overtime >= 0),
  bonus              numeric(18,2) NOT NULL DEFAULT 0 CHECK (bonus >= 0),
  gross              numeric(18,2) NOT NULL,
  absence            numeric(18,2) NOT NULL CHECK (absence >= 0),
  sick               numeric(18,2) NOT NULL CHECK (sick >= 0),
  insurance_employee numeric(18,2) NOT NULL CHECK (insurance_employee >= 0),
  insurance_employer numeric(18,2) NOT NULL CHECK (insurance_employer >= 0),
  loan               numeric(18,2) NOT NULL DEFAULT 0 CHECK (loan >= 0),
  other_deductions   numeric(18,2) NOT NULL DEFAULT 0 CHECK (other_deductions >= 0),
  net                numeric(18,2) NOT NULL CHECK (net >= 0),
  eos_accrual        numeric(18,2) NOT NULL DEFAULT 0,
  UNIQUE (run_id, contact_id),
  CHECK (gross = basic + housing + transport + other_allowance + overtime + bonus),
  CHECK (net = gross - absence - sick - insurance_employee - loan - other_deductions),
  CHECK ((loan > 0) = (loan_id IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- End of service settlement and HR documents
-- ---------------------------------------------------------------------------
CREATE TABLE eos_settlements (
  id            uuid PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES companies(id),
  contact_id    uuid NOT NULL UNIQUE REFERENCES contacts(id),
  leaving_date  date NOT NULL,
  reason        text NOT NULL CHECK (reason IN ('resignation', 'termination', 'contract_end', 'retirement', 'death', 'other')),
  service_days  int NOT NULL,
  eos_amount    numeric(18,2) NOT NULL CHECK (eos_amount >= 0),
  provision     numeric(18,2) NOT NULL,
  leave_days    numeric(8,2) NOT NULL DEFAULT 0,
  leave_pay     numeric(18,2) NOT NULL DEFAULT 0 CHECK (leave_pay >= 0),
  loan_id       uuid REFERENCES employee_loans(id),
  loan_recovered numeric(18,2) NOT NULL DEFAULT 0 CHECK (loan_recovered >= 0),
  total_due     numeric(18,2) NOT NULL,
  entry_id      uuid NOT NULL UNIQUE REFERENCES journal_entries(id),
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (total_due = eos_amount + leave_pay - loan_recovered),
  CHECK ((loan_recovered > 0) = (loan_id IS NOT NULL))
);

CREATE TABLE employee_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  contact_id   uuid NOT NULL REFERENCES contacts(id),
  kind         text NOT NULL CHECK (kind IN ('national_id', 'iqama', 'emirates_id', 'passport', 'visa', 'work_permit', 'contract', 'medical_insurance', 'driving_licence', 'other')),
  number       text,
  issue_date   date,
  expiry_date  date,
  notes        text,
  CHECK (expiry_date IS NULL OR issue_date IS NULL OR expiry_date >= issue_date)
);
CREATE INDEX employee_documents_expiry ON employee_documents (company_id, expiry_date);

ALTER TABLE attachments ADD COLUMN employee_document_id uuid REFERENCES employee_documents(id);
ALTER TABLE attachments DROP CONSTRAINT attachments_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_belongs_to_one CHECK (num_nonnulls(document_id, stock_note_id, employee_document_id) = 1);
CREATE INDEX attachments_employee_document ON attachments (employee_document_id);

-- ---------------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------------
/** Is payroll posted for any month touching these dates? Such months are fixed. */
CREATE FUNCTION payroll_posted_between(p_company uuid, p_from date, p_to date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM payroll_runs WHERE company_id = p_company AND status <> 'draft'
                 AND period_end >= p_from AND date_trunc('month', period_end) <= p_to)
$$;

CREATE FUNCTION is_company_employee(p_company uuid, p_contact uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM contacts WHERE id = p_contact AND company_id = p_company AND is_employee)
$$;

CREATE FUNCTION before_employee_profile_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT is_company_employee(NEW.company_id, NEW.contact_id) THEN RAISE EXCEPTION 'HR details are for employees of this company.'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id <> OLD.company_id THEN RAISE EXCEPTION 'That belongs to a different company.'; END IF;
    IF NEW.join_date <> OLD.join_date AND EXISTS (SELECT 1 FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id
                                                  WHERE l.contact_id = NEW.contact_id AND r.status <> 'draft') THEN
      RAISE EXCEPTION 'This person has been paid through payroll, so the join date can no longer change.';
    END IF;
    IF EXISTS (SELECT 1 FROM eos_settlements WHERE contact_id = NEW.contact_id)
       AND (NEW.leaving_date, NEW.leaving_reason, NEW.basic, NEW.housing, NEW.transport, NEW.other_allowance)
           IS DISTINCT FROM (OLD.leaving_date, OLD.leaving_reason, OLD.basic, OLD.housing, OLD.transport, OLD.other_allowance) THEN
      RAISE EXCEPTION 'This person''s final settlement is done; their pay and leaving date no longer change.';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_profiles_before_change BEFORE INSERT OR UPDATE ON employee_profiles FOR EACH ROW EXECUTE FUNCTION before_employee_profile_change();

CREATE FUNCTION before_hr_attendance_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a hr_attendance%ROWTYPE;
BEGIN
  a := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF payroll_posted_between(a.company_id, a.period_end, a.period_end)
     OR (TG_OP = 'UPDATE' AND payroll_posted_between(OLD.company_id, OLD.period_end, OLD.period_end)) THEN
    RAISE EXCEPTION 'Payroll for this month is posted, so its attendance no longer changes.';
  END IF;
  IF TG_OP <> 'DELETE' AND NOT is_company_employee(NEW.company_id, NEW.contact_id) THEN RAISE EXCEPTION 'Choose an employee of this company.'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER hr_attendance_before_change BEFORE INSERT OR UPDATE OR DELETE ON hr_attendance FOR EACH ROW EXECUTE FUNCTION before_hr_attendance_change();

CREATE FUNCTION before_leave_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now(); NEW.decided_by := NULL; NEW.decided_at := NULL;
    IF NEW.status NOT IN ('requested', 'approved') THEN RAISE EXCEPTION 'A new leave request is requested or approved.'; END IF;
    IF NEW.status = 'approved' THEN NEW.decided_by := NEW.created_by; NEW.decided_at := now(); END IF;
  ELSE
    IF NEW.company_id <> OLD.company_id OR NEW.contact_id <> OLD.contact_id OR NEW.created_by <> OLD.created_by THEN
      RAISE EXCEPTION 'A leave request keeps its employee.';
    END IF;
    IF OLD.status IN ('rejected', 'cancelled') THEN RAISE EXCEPTION 'This leave request is closed.'; END IF;
    IF payroll_posted_between(OLD.company_id, OLD.start_date, OLD.end_date) AND OLD.status = 'approved' THEN
      RAISE EXCEPTION 'Payroll is posted for these dates, so this leave no longer changes.';
    END IF;
    IF NEW.status <> OLD.status THEN
      IF app_user_id() IS NOT NULL THEN NEW.decided_by := app_user_id(); END IF;
      NEW.decided_at := now();
    END IF;
  END IF;
  IF NOT is_company_employee(NEW.company_id, NEW.contact_id) THEN RAISE EXCEPTION 'Choose an employee of this company.'; END IF;
  IF NEW.status = 'approved' AND payroll_posted_between(NEW.company_id, NEW.start_date, NEW.end_date)
     AND (TG_OP = 'INSERT' OR OLD.status <> 'approved' OR (NEW.start_date, NEW.end_date, NEW.kind) IS DISTINCT FROM (OLD.start_date, OLD.end_date, OLD.kind)) THEN
    RAISE EXCEPTION 'Payroll is posted for these dates. Record the leave in a later month.';
  END IF;
  IF NEW.status IN ('requested', 'approved') AND EXISTS (SELECT 1 FROM leave_requests x WHERE x.contact_id = NEW.contact_id AND x.id <> NEW.id
       AND x.status IN ('requested', 'approved') AND x.start_date <= NEW.end_date AND x.end_date >= NEW.start_date) THEN
    RAISE EXCEPTION 'This person already has leave on some of these days.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER leave_requests_before_change BEFORE INSERT OR UPDATE ON leave_requests FOR EACH ROW EXECUTE FUNCTION before_leave_change();
CREATE TRIGGER leave_requests_no_delete BEFORE DELETE ON leave_requests FOR EACH ROW EXECUTE FUNCTION forbid_change();

/** Debit (positive) or credit (negative) on an account in an entry that belongs to the given source row. */
CREATE FUNCTION entry_amount(p_entry uuid, p_source uuid, p_company uuid, p_code text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM journal_entries WHERE id = p_entry AND source_id = p_source AND company_id = p_company)
    THEN (SELECT coalesce(sum(l.debit - l.credit), 0) FROM journal_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.entry_id = p_entry AND a.company_id = p_company AND a.code = p_code) END
$$;

CREATE FUNCTION before_employee_loan_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'A loan is never changed. Repayments come through payroll.'; END IF;
  IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  NEW.created_at := now();
  IF NOT is_company_employee(NEW.company_id, NEW.contact_id) THEN RAISE EXCEPTION 'Choose an employee of this company.'; END IF;
  IF entry_amount(NEW.entry_id, NEW.id, NEW.company_id, '1150') IS DISTINCT FROM NEW.amount THEN
    RAISE EXCEPTION 'A loan needs its own journal entry debiting 1150 Employee loans and advances.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_loans_before_change BEFORE INSERT OR UPDATE ON employee_loans FOR EACH ROW EXECUTE FUNCTION before_employee_loan_change();
CREATE TRIGGER employee_loans_no_delete BEFORE DELETE ON employee_loans FOR EACH ROW EXECUTE FUNCTION forbid_change();

/** What is still owed on a loan: the amount less repayments in posted payroll and in a final settlement. */
CREATE FUNCTION loan_balance(p_loan uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.amount
       - coalesce((SELECT sum(p.loan) FROM payroll_lines p JOIN payroll_runs r ON r.id = p.run_id WHERE p.loan_id = l.id AND r.status <> 'draft'), 0)
       - coalesce((SELECT s.loan_recovered FROM eos_settlements s WHERE s.loan_id = l.id), 0)
  FROM employee_loans l WHERE l.id = p_loan AND l.company_id = ANY (app_company_ids())
$$;
GRANT EXECUTE ON FUNCTION loan_balance(uuid) TO nusuh_app;

CREATE FUNCTION before_payroll_run_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'Posted payroll is never deleted.'; END IF;
    DELETE FROM payroll_lines WHERE run_id = OLD.id;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
    NEW.created_at := now(); NEW.status := 'draft'; NEW.entry_id := NULL; NEW.payment_entry_id := NULL; NEW.posted_by := NULL; NEW.posted_at := NULL;
    IF NEW.period_end > (date_trunc('month', current_date) + interval '1 month - 1 day')::date THEN
      RAISE EXCEPTION 'Payroll cannot be prepared for a future month.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.period_end <> OLD.period_end OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'A payroll run keeps its company and month.';
  END IF;
  IF OLD.status = 'paid' THEN RAISE EXCEPTION 'This payroll is paid. It never changes.'; END IF;
  IF OLD.status = 'posted' THEN
    IF NEW.status <> 'paid' OR (to_jsonb(NEW) - 'status' - 'paid_from' - 'paid_on' - 'payment_entry_id') <> (to_jsonb(OLD) - 'status' - 'paid_from' - 'paid_on' - 'payment_entry_id') THEN
      RAISE EXCEPTION 'Posted payroll never changes. Correct it in a later month.';
    END IF;
    IF entry_amount(NEW.payment_entry_id, NEW.id, NEW.company_id, '2210') IS DISTINCT FROM NEW.total_net THEN
      RAISE EXCEPTION 'Paying payroll needs its own journal entry clearing 2210 Salaries payable.';
    END IF;
    RETURN NEW;
  END IF;
  -- draft
  IF NEW.status = 'paid' THEN RAISE EXCEPTION 'Post the payroll before paying it.'; END IF;
  IF NEW.status = 'posted' THEN
    SELECT coalesce(sum(gross), 0) AS g, coalesce(sum(net), 0) AS n, coalesce(sum(insurance_employer), 0) AS e, count(*) AS c
      INTO s FROM payroll_lines WHERE run_id = NEW.id;
    IF s.c = 0 THEN RAISE EXCEPTION 'There is nobody to pay in this payroll.'; END IF;
    IF (NEW.total_gross, NEW.total_net, NEW.total_employer) IS DISTINCT FROM (s.g, s.n, s.e) THEN RAISE EXCEPTION 'The payroll totals must equal its lines.'; END IF;
    IF entry_amount(NEW.entry_id, NEW.id, NEW.company_id, '2210') IS DISTINCT FROM -NEW.total_net THEN
      RAISE EXCEPTION 'Posting payroll needs its own journal entry crediting 2210 Salaries payable with the net pay.';
    END IF;
    IF app_user_id() IS NOT NULL THEN NEW.posted_by := app_user_id(); END IF;
    NEW.posted_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payroll_runs_before_change BEFORE INSERT OR UPDATE OR DELETE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION before_payroll_run_change();

CREATE FUNCTION before_payroll_line_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l payroll_lines%ROWTYPE;
BEGIN
  l := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF (SELECT status FROM payroll_runs WHERE id = l.run_id) <> 'draft' OR (TG_OP = 'UPDATE' AND (SELECT status FROM payroll_runs WHERE id = OLD.run_id) <> 'draft') THEN
    RAISE EXCEPTION 'Posted payroll never changes. Correct it in a later month.';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM payroll_runs WHERE id = NEW.run_id AND company_id = NEW.company_id) OR NOT is_company_employee(NEW.company_id, NEW.contact_id)
       OR (NEW.cost_centre_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cost_centres WHERE id = NEW.cost_centre_id AND company_id = NEW.company_id))
       OR (NEW.loan_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employee_loans WHERE id = NEW.loan_id AND contact_id = NEW.contact_id)) THEN
      RAISE EXCEPTION 'That belongs to a different company.';
    END IF;
  END IF;
  RETURN l;
END $$;
CREATE TRIGGER payroll_lines_before_change BEFORE INSERT OR UPDATE OR DELETE ON payroll_lines FOR EACH ROW EXECUTE FUNCTION before_payroll_line_change();

CREATE FUNCTION before_eos_settlement_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'A final settlement is never changed.'; END IF;
  IF app_user_id() IS NOT NULL THEN NEW.created_by := app_user_id(); END IF;
  NEW.created_at := now();
  IF NOT EXISTS (SELECT 1 FROM employee_profiles WHERE contact_id = NEW.contact_id AND company_id = NEW.company_id AND join_date <= NEW.leaving_date) THEN
    RAISE EXCEPTION 'Choose an employee of this company who had joined by the leaving date.';
  END IF;
  IF entry_amount(NEW.entry_id, NEW.id, NEW.company_id, '2210') IS DISTINCT FROM -NEW.total_due THEN
    RAISE EXCEPTION 'A final settlement needs its own journal entry crediting 2210 Salaries payable with the amount due.';
  END IF;
  UPDATE employee_profiles SET leaving_date = NEW.leaving_date, leaving_reason = NEW.reason WHERE contact_id = NEW.contact_id;
  RETURN NEW;
END $$;
CREATE TRIGGER eos_settlements_before_change BEFORE INSERT OR UPDATE ON eos_settlements FOR EACH ROW EXECUTE FUNCTION before_eos_settlement_change();
CREATE TRIGGER eos_settlements_no_delete BEFORE DELETE ON eos_settlements FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION before_employee_document_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM attachments WHERE employee_document_id = OLD.id;
    RETURN OLD;
  END IF;
  IF NOT is_company_employee(NEW.company_id, NEW.contact_id) OR (TG_OP = 'UPDATE' AND NEW.company_id <> OLD.company_id) THEN
    RAISE EXCEPTION 'Choose an employee of this company.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_documents_before_change BEFORE INSERT OR UPDATE OR DELETE ON employee_documents FOR EACH ROW EXECUTE FUNCTION before_employee_document_change();

-- Attachments can belong to an HR document too; those can always be removed (they are not part of the books).
CREATE OR REPLACE FUNCTION before_attachment_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a attachments%ROWTYPE; draft boolean;
BEGIN
  a := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  draft := coalesce((SELECT status = 'draft' FROM documents WHERE id = a.document_id),
                    (SELECT status = 'draft' FROM stock_notes WHERE id = a.stock_note_id),
                    a.employee_document_id IS NOT NULL);
  IF TG_OP = 'DELETE' THEN
    IF NOT draft THEN RAISE EXCEPTION 'Attachments of an issued document are kept. They can be added to, not removed.'; END IF;
    DELETE FROM attachment_files WHERE attachment_id = OLD.id;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'An attachment is never changed. Add a new one instead.'; END IF;
  IF app_user_id() IS NOT NULL THEN NEW.uploaded_by := app_user_id(); END IF;
  NEW.uploaded_at := now();
  IF (NEW.document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND company_id = NEW.company_id))
     OR (NEW.stock_note_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stock_notes WHERE id = NEW.stock_note_id AND company_id = NEW.company_id))
     OR (NEW.employee_document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employee_documents WHERE id = NEW.employee_document_id AND company_id = NEW.company_id)) THEN
    RAISE EXCEPTION 'That belongs to a different company.';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Audit and row-level security
-- ---------------------------------------------------------------------------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['employee_profiles', 'company_hr_settings', 'hr_attendance', 'leave_requests', 'employee_loans', 'payroll_runs',
                           'payroll_lines', 'eos_settlements', 'employee_documents'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t || '_audit', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (company_id = ANY (app_company_ids()))', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (app_has_role(company_id, posting_roles())) WITH CHECK (app_has_role(company_id, posting_roles()))', t || '_update', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nusuh_app', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['hr_attendance', 'payroll_runs', 'payroll_lines', 'employee_documents'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (app_has_role(company_id, posting_roles()))', t || '_delete', t);
    EXECUTE format('GRANT DELETE ON %I TO nusuh_app', t);
  END LOOP;
END $$;
