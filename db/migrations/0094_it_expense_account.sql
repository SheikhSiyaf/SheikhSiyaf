-- The standard chart had only "Computers and IT equipment" (1530, an asset) for IT, so a cost put on it went to the balance sheet and never reached Profit
-- and Loss or Expenses by category. New companies now get an expense account for IT and software costs (5410), and this adds the same account to the
-- companies that already have a chart. It uses the first free code from 5410 to 5499, and does nothing for a company that already has an account of that name.
-- Only an account is added: no entry is posted and nothing existing changes. Reversible: delete the accounts that have no lines.
INSERT INTO accounts (company_id, code, name, name_ar, type)
SELECT c.id, pick.code, 'IT and software expenses', 'مصروفات تقنية المعلومات والبرمجيات', 'expense'
FROM companies c
CROSS JOIN LATERAL (SELECT min(n)::text AS code FROM generate_series(5410, 5499) n
                     WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.code = n::text)) pick
WHERE pick.code IS NOT NULL
  AND EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.type = 'expense')
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.name = 'IT and software expenses');
