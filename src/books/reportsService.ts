// Profit and loss statement in the usual format:
//   Sales - Cost of sales = Gross profit; Gross profit - Indirect expenses + Indirect income = Net profit.
// Each income and expense account sits on one of these lines (accounts.pnl_group, db/migrations/0016).
import type { Db } from '../db/session.js';
import { fromMinor, toMinor } from '../money.js';

export type PnlGroup = 'revenue' | 'cost_of_sales' | 'indirect_expense' | 'other_income';

export async function profitAndLoss(db: Db, companyId: string, from: string, to: string) {
  const { rows } = await db.query(
    `SELECT a.id AS "accountId", a.name, a.name_ar AS "nameAr", a.pnl_group AS "group",
            (CASE WHEN a.type = 'income' THEN sum(l.credit - l.debit) ELSE sum(l.debit - l.credit) END)::numeric(18,2)::text AS amount
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE e.company_id = $1 AND e.entry_date BETWEEN $2 AND $3 AND a.type IN ('income', 'expense')
     GROUP BY a.id HAVING sum(l.debit - l.credit) <> 0 ORDER BY a.code`, [companyId, from, to]);
  const lines = rows as { accountId: string; name: string; nameAr: string | null; group: PnlGroup; amount: string }[];
  const sum = (g: PnlGroup) => lines.filter((l) => l.group === g).reduce((t, l) => t + toMinor(l.amount), 0n);
  const revenue = sum('revenue'), cost = sum('cost_of_sales'), indirect = sum('indirect_expense'), other = sum('other_income');
  const gross = revenue - cost;
  return {
    from, to, lines,
    revenue: fromMinor(revenue), costOfSales: fromMinor(cost), grossProfit: fromMinor(gross),
    indirectExpenses: fromMinor(indirect), otherIncome: fromMinor(other), netProfit: fromMinor(gross - indirect + other),
  };
}
