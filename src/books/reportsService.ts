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
     WHERE e.company_id = $1 AND e.entry_date BETWEEN $2 AND $3 AND a.type IN ('income', 'expense') AND e.source_type IS DISTINCT FROM 'year_end_close'
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

// ------------------------------------------------------------------ helpers
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d: string, n: number) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)).toISOString().slice(0, 10);
const monthEndOf = (d: string) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).toISOString().slice(0, 10);
const addMonths = (d: string, n: number) => { const x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1 + n, 1)); return x.toISOString().slice(0, 10); };
/** One decimal percentage of a over b (a display figure, not money): 1234 / 10000 -> 12.3. */
export const pct = (a: bigint, b: bigint): number | null => (b === 0n ? null : Number((a * 1000n) / b) / 10);

/** First day of the financial year that contains the date (from the company's year end). */
export async function fyStart(db: Db, companyId: string, asOf: string): Promise<string> {
  const c = (await db.query('SELECT fy_end_month AS m, fy_end_day AS d FROM companies WHERE id = $1', [companyId])).rows[0];
  const m = c?.m ?? 12, dd = c?.d ?? 31;
  const y = +asOf.slice(0, 4);
  const endThisYear = `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const lastEnd = endThisYear < asOf ? endThisYear : `${y - 1}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  return addDays(lastEnd, 1);
}

// ------------------------------------------------------------------ P&L in columns
export type Compare = 'none' | 'previous' | 'lastYear' | 'monthly';
/** The periods to show: the chosen one, the one before it or the same one last year, or each month in it (up to 12). */
export function periodsFor(from: string, to: string, compare: Compare): { from: string; to: string }[] {
  if (compare === 'monthly') {
    const out = [];
    for (let m = from.slice(0, 7) + '-01'; m <= to && out.length < 12; m = addMonths(m, 1)) out.push({ from: m < from ? from : m, to: monthEndOf(m) > to ? to : monthEndOf(m) });
    return out;
  }
  if (compare === 'previous') {
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    // A whole month or months compares with the same number of months before it.
    const wholeMonths = from.endsWith('-01') && monthEndOf(to) === to;
    const months = (+to.slice(0, 4) * 12 + +to.slice(5, 7)) - (+from.slice(0, 4) * 12 + +from.slice(5, 7)) + 1;
    const prev = wholeMonths ? { from: addMonths(from, -months), to: addDays(from, -1) } : { from: addDays(from, -days), to: addDays(from, -1) };
    return [{ from, to }, prev];
  }
  if (compare === 'lastYear') {
    const back = (d: string) => { const y = `${+d.slice(0, 4) - 1}${d.slice(4)}`; return d.slice(5) === '02-29' ? `${+d.slice(0, 4) - 1}-02-28` : y; };
    return [{ from, to }, { from: back(from), to: back(to) }];
  }
  return [{ from, to }];
}
export async function pnlColumns(db: Db, companyId: string, from: string, to: string, compare: Compare) {
  const periods = periodsFor(from, to, compare);
  // One query at a time: a transaction's connection runs them in order anyway.
  const columns = [];
  for (const p of periods) columns.push(await profitAndLoss(db, companyId, p.from, p.to));
  return { compare, columns };
}

// ------------------------------------------------------------------ balance sheet
export interface BsLine { accountId: string; code: string; name: string; nameAr: string | null; amount: string }
type BsSection = 'nonCurrentAssets' | 'currentAssets' | 'currentLiabilities' | 'nonCurrentLiabilities' | 'equity';
/** Non-current assets: fixed assets 1500-1599 (with accumulated depreciation). Non-current liabilities: end of service
 *  provision (2230) and codes from 2500. Equity: capital accounts, earlier years' results, and this year's profit. */
const sectionOf = (type: string, code: string): BsSection | null =>
  type === 'asset' ? (code >= '1500' && code <= '1599' ? 'nonCurrentAssets' : 'currentAssets')
    : type === 'liability' ? (code === '2230' || code >= '2500' ? 'nonCurrentLiabilities' : 'currentLiabilities')
    : type === 'equity' ? 'equity' : null;

export async function balanceSheet(db: Db, companyId: string, asOf: string) {
  if (!DATE.test(asOf)) throw new Error('Choose the date.');
  const start = await fyStart(db, companyId, asOf);
  const { rows } = await db.query(
    `SELECT a.id AS "accountId", a.code, a.name, a.name_ar AS "nameAr", a.type,
            coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS dr,
            coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date < $3), 0)::numeric(18,2)::text AS "drBefore"
     FROM accounts a JOIN journal_lines l ON l.account_id = a.id JOIN journal_entries e ON e.id = l.entry_id
     WHERE a.company_id = $1 AND e.entry_date <= $2 AND e.source_type IS DISTINCT FROM 'year_end_close' GROUP BY a.id ORDER BY a.code`, [companyId, asOf, start]);
  const sections: Record<BsSection, BsLine[]> = { nonCurrentAssets: [], currentAssets: [], currentLiabilities: [], nonCurrentLiabilities: [], equity: [] };
  let earlier = 0n, thisYear = 0n;
  for (const r of rows) {
    const dr = toMinor(r.dr);
    if (r.type === 'income' || r.type === 'expense') { earlier += -toMinor(r.drBefore); thisYear += -(dr - toMinor(r.drBefore)); continue; }
    const sec = sectionOf(r.type, r.code)!;
    const amount = sec === 'currentAssets' || sec === 'nonCurrentAssets' ? dr : -dr;
    if (amount !== 0n) sections[sec].push({ accountId: r.accountId, code: r.code, name: r.name, nameAr: r.nameAr, amount: fromMinor(amount) });
  }
  const tot = (s: BsSection) => sections[s].reduce((t, l) => t + toMinor(l.amount), 0n);
  const assets = tot('nonCurrentAssets') + tot('currentAssets');
  const liabilities = tot('currentLiabilities') + tot('nonCurrentLiabilities');
  const equity = tot('equity') + earlier + thisYear;
  return {
    asOf, fyStart: start, sections,
    totals: { nonCurrentAssets: fromMinor(tot('nonCurrentAssets')), currentAssets: fromMinor(tot('currentAssets')), assets: fromMinor(assets),
      currentLiabilities: fromMinor(tot('currentLiabilities')), nonCurrentLiabilities: fromMinor(tot('nonCurrentLiabilities')), liabilities: fromMinor(liabilities),
      capital: fromMinor(tot('equity')), earlierYears: fromMinor(earlier), thisYear: fromMinor(thisYear), equity: fromMinor(equity),
      liabilitiesAndEquity: fromMinor(liabilities + equity) },
    balances: assets === liabilities + equity,
  };
}

// ------------------------------------------------------------------ cash flow
type CfSection = 'operating' | 'investing' | 'financing';
/** Where the money in the bank and cash accounts came from and went, by the other side of each entry:
 *  investing = fixed assets and their disposal (1500-1599, 4900); financing = equity (3xxx) and long-term
 *  borrowing (codes from 2500); everything else is operating. Transfers between bank accounts cancel out. */
const cfSectionOf = (type: string, code: string): CfSection =>
  (type === 'asset' && code >= '1500' && code <= '1599') || code === '4900' ? 'investing'
    : type === 'equity' || (type === 'liability' && code >= '2500' && code !== '2230') ? 'financing' : 'operating';

export async function cashFlow(db: Db, companyId: string, from: string, to: string) {
  const bal = async (d: string) => toMinor((await db.query(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     JOIN accounts a ON a.id = l.account_id WHERE a.company_id = $1 AND a.is_bank AND e.entry_date <= $2`, [companyId, d])).rows[0].v);
  // Each entry that touches a bank or cash account: its other lines carry the cash effect (credit - debit), which add up
  // to the bank movement because the entry balances.
  const { rows } = await db.query(
    `SELECT a.id AS "accountId", a.code, a.name, a.name_ar AS "nameAr", a.type, sum(l.credit - l.debit)::numeric(18,2)::text AS amount
     FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id
     WHERE e.company_id = $1 AND e.entry_date BETWEEN $2 AND $3 AND NOT a.is_bank
       AND EXISTS (SELECT 1 FROM journal_lines b JOIN accounts ba ON ba.id = b.account_id WHERE b.entry_id = e.id AND ba.is_bank)
     GROUP BY a.id HAVING sum(l.credit - l.debit) <> 0 ORDER BY a.code`, [companyId, from, to]);
  const sections: Record<CfSection, BsLine[]> = { operating: [], investing: [], financing: [] };
  for (const r of rows) sections[cfSectionOf(r.type, r.code)].push({ accountId: r.accountId, code: r.code, name: r.name, nameAr: r.nameAr, amount: r.amount });
  const tot = (s: CfSection) => sections[s].reduce((t, l) => t + toMinor(l.amount), 0n);
  const opening = await bal(addDays(from, -1)), closing = await bal(to);
  const net = tot('operating') + tot('investing') + tot('financing');
  return { from, to, sections, totals: { operating: fromMinor(tot('operating')), investing: fromMinor(tot('investing')), financing: fromMinor(tot('financing')), net: fromMinor(net) },
    opening: fromMinor(opening), closing: fromMinor(closing), agrees: opening + net === closing };
}

// ------------------------------------------------------------------ owner summary and ratios
export async function ownerSummary(db: Db, companyId: string, asOf: string) {
  const monthStart = `${asOf.slice(0, 7)}-01`;
  const lastStart = addMonths(monthStart, -1), lastEnd = addDays(monthStart, -1);
  const yStart = await fyStart(db, companyId, asOf);
  const month = await profitAndLoss(db, companyId, monthStart, asOf), last = await profitAndLoss(db, companyId, lastStart, lastEnd), ytd = await profitAndLoss(db, companyId, yStart, asOf);
  const bs = await balanceSheet(db, companyId, asOf);
  const byCode = async (code: string) => toMinor((await db.query(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE a.company_id = $1 AND a.code = $2 AND e.entry_date <= $3`, [companyId, code, asOf])).rows[0].v);
  const cash = toMinor((await db.query(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(18,2)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE a.company_id = $1 AND a.is_bank AND e.entry_date <= $2`, [companyId, asOf])).rows[0].v);
  const receivables = await byCode('1100'), payables = -(await byCode('2000')), inventory = await byCode('1300');
  const vatDue = -(await byCode('2100')) - (await byCode('1200'));
  const overdue = toMinor((await db.query(
    `SELECT coalesce(sum(document_amount_due(d.id)), 0)::numeric(18,2)::text AS v FROM documents d
     WHERE d.company_id = $1 AND d.type = 'invoice' AND d.status = 'issued' AND d.due_date < $2`, [companyId, asOf])).rows[0].v);
  const flows90 = (await db.query(
    `SELECT coalesce(sum(gross_total) FILTER (WHERE type = 'invoice'), 0)::numeric(18,2)::text AS sales,
            coalesce(sum(gross_total) FILTER (WHERE type IN ('bill', 'expense')), 0)::numeric(18,2)::text AS purchases
     FROM documents WHERE company_id = $1 AND status = 'issued' AND issue_date BETWEEN $2 AND $3`, [companyId, addDays(asOf, -89), asOf])).rows[0];
  const ca = toMinor(bs.totals.currentAssets), cl = toMinor(bs.totals.currentLiabilities);
  const days = (bal: bigint, flow: string) => (toMinor(flow) === 0n ? null : Number((bal * 90n) / toMinor(flow)));
  const top = async (sql: string) => (await db.query(sql, [companyId, yStart, asOf])).rows;
  return {
    asOf, monthStart, lastStart, lastEnd, yearStart: yStart,
    month: { revenue: month.revenue, grossProfit: month.grossProfit, netProfit: month.netProfit },
    lastMonth: { revenue: last.revenue, grossProfit: last.grossProfit, netProfit: last.netProfit },
    yearToDate: { revenue: ytd.revenue, grossProfit: ytd.grossProfit, netProfit: ytd.netProfit },
    position: { cash: fromMinor(cash), receivables: fromMinor(receivables), overdue: fromMinor(overdue), payables: fromMinor(payables), inventory: fromMinor(inventory), vatDue: fromMinor(vatDue),
      workingCapital: fromMinor(ca - cl) },
    ratios: {
      grossMargin: pct(toMinor(ytd.grossProfit), toMinor(ytd.revenue)), netMargin: pct(toMinor(ytd.netProfit), toMinor(ytd.revenue)),
      currentRatio: cl > 0n ? Number((ca * 100n) / cl) / 100 : null, quickRatio: cl > 0n ? Number(((ca - inventory) * 100n) / cl) / 100 : null,
      debtorDays: days(receivables, flows90.sales), creditorDays: days(payables, flows90.purchases),
    },
    topCustomers: await top(`SELECT c.id, c.name, c.name_ar AS "nameAr", sum(d.net_total)::numeric(18,2)::text AS amount FROM documents d JOIN contacts c ON c.id = d.contact_id
      WHERE d.company_id = $1 AND d.type = 'invoice' AND d.status = 'issued' AND d.issue_date BETWEEN $2 AND $3 GROUP BY c.id ORDER BY sum(d.net_total) DESC LIMIT 5`),
    topExpenses: (ytd.lines as { accountId: string; name: string; nameAr: string | null; group: PnlGroup; amount: string }[])
      .filter((l) => l.group === 'indirect_expense' || l.group === 'cost_of_sales').sort((a, b) => (toMinor(b.amount) > toMinor(a.amount) ? 1 : -1)).slice(0, 5),
  };
}

// ------------------------------------------------------------------ VAT return worksheet
type VatCodeKey = 'standard' | 'zero' | 'exempt' | 'out_of_scope';
/** Sales and purchases in the period by VAT treatment, from issued documents (credit notes and supplier credits
 *  reduce them), next to the VAT accounts in the books. A worksheet to prepare the ZATCA or FTA return. */
export async function vatReturn(db: Db, companyId: string, from: string, to: string) {
  const { rows } = await db.query(
    `SELECT CASE WHEN d.type IN ('invoice', 'credit_note') THEN 'sales' ELSE 'purchases' END AS side, l.vat_code AS code,
            sum(CASE WHEN d.type IN ('credit_note', 'supplier_credit') THEN -l.net_amount ELSE l.net_amount END)::numeric(18,2)::text AS net,
            sum(CASE WHEN d.type IN ('credit_note', 'supplier_credit') THEN -l.vat_amount ELSE l.vat_amount END)::numeric(18,2)::text AS vat,
            sum(CASE WHEN d.type IN ('credit_note', 'supplier_credit') THEN -l.net_amount ELSE 0 END)::numeric(18,2)::text AS adjust
     FROM documents d JOIN document_lines l ON l.document_id = d.id
     WHERE d.company_id = $1 AND d.issue_date BETWEEN $2 AND $3 AND d.status IN ('issued', 'invoiced')
       AND d.type IN ('invoice', 'credit_note', 'bill', 'supplier_credit', 'expense', 'claim')
     GROUP BY 1, 2`, [companyId, from, to]);
  const empty = () => ({ net: '0.00', vat: '0.00', adjust: '0.00' });
  const side = () => ({ standard: empty(), zero: empty(), exempt: empty(), out_of_scope: empty() } as Record<VatCodeKey, { net: string; vat: string; adjust: string }>);
  const sales = side(), purchases = side();
  for (const r of rows) (r.side === 'sales' ? sales : purchases)[r.code as VatCodeKey] = { net: r.net, vat: r.vat, adjust: r.adjust };
  const books = async (code: string) => toMinor((await db.query(
    `SELECT coalesce(sum(l.credit - l.debit), 0)::numeric(18,2)::text AS v FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
     WHERE a.company_id = $1 AND a.code = $2 AND e.entry_date BETWEEN $3 AND $4`, [companyId, code, from, to])).rows[0].v);
  const outputBooks = await books('2100'), inputBooks = -(await books('1200'));
  const outVat = (Object.values(sales) as { vat: string }[]).reduce((t, x) => t + toMinor(x.vat), 0n);
  const inVat = (Object.values(purchases) as { vat: string }[]).reduce((t, x) => t + toMinor(x.vat), 0n);
  const country = (await db.query('SELECT country FROM companies WHERE id = $1', [companyId])).rows[0].country;
  return { from, to, country, sales, purchases, outputVat: fromMinor(outVat), inputVat: fromMinor(inVat), netVat: fromMinor(outVat - inVat),
    books: { outputVat: fromMinor(outputBooks), inputVat: fromMinor(inputBooks), netVat: fromMinor(outputBooks - inputBooks) },
    agreesWithBooks: outVat === outputBooks && inVat === inputBooks };
}
