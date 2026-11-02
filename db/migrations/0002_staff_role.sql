-- 0002: firm staff carry their firm role on the user (Firm partner, Reviewer, Staff accountant).
-- Assigning a staff member to a client then always uses that role, so the Administrator only
-- ticks which clients each person handles (as in the prototype's Staff screen).

ALTER TABLE users ADD COLUMN staff_role user_role;

UPDATE users u SET staff_role = (
  SELECT m.role FROM memberships m WHERE m.user_id = u.id ORDER BY m.role LIMIT 1)
WHERE u.kind = 'firm_staff';
UPDATE users SET staff_role = 'staff_accountant' WHERE kind = 'firm_staff' AND staff_role IS NULL;

ALTER TABLE users ADD CONSTRAINT staff_role_for_firm_staff CHECK (
  (kind = 'firm_staff' AND staff_role IN ('partner','reviewer','staff_accountant')) OR
  (kind <> 'firm_staff' AND staff_role IS NULL));

CREATE OR REPLACE FUNCTION check_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u users%ROWTYPE; c_firm uuid;
BEGIN
  SELECT * INTO u FROM users WHERE id = NEW.user_id;
  SELECT firm_id INTO c_firm FROM companies WHERE id = NEW.company_id;
  IF u.firm_id IS DISTINCT FROM c_firm THEN
    RAISE EXCEPTION 'This user belongs to a different firm.';
  END IF;
  IF u.kind = 'admin' THEN
    RAISE EXCEPTION 'Administrators cannot be assigned to client books.';
  ELSIF u.kind = 'firm_staff' AND NEW.role NOT IN ('partner','reviewer','staff_accountant') THEN
    RAISE EXCEPTION 'Firm staff can only be Firm partner, Reviewer or Staff accountant.';
  ELSIF u.kind = 'firm_staff' AND NEW.role <> u.staff_role THEN
    RAISE EXCEPTION 'A staff member has the same role for every client they handle.';
  ELSIF u.kind = 'client' AND NEW.role NOT IN ('client_accountant','client_viewer') THEN
    RAISE EXCEPTION 'Client users can only be Client accountant or Client management.';
  END IF;
  IF u.kind = 'client' AND EXISTS (SELECT 1 FROM memberships m
                                   WHERE m.user_id = NEW.user_id AND m.company_id <> NEW.company_id) THEN
    RAISE EXCEPTION 'A client user can only belong to their own company.';
  END IF;
  RETURN NEW;
END $$;
