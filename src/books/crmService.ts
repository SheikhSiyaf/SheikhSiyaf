// CRM: leads, deals (pipeline), activities and campaigns. Runs inside withUser(); db/migrations/0020_crm.sql
// keeps every link inside the company and moves a deal when its quotation is invoiced or declined.
import type { Db } from '../db/session.js';
import { fromMinor, toMinor, type Minor } from '../money.js';
import { HttpError } from '../api/errors.js';
import { SYSTEM_ACCOUNTS } from './chartTemplate.js';
import { saveContact, saveDraft } from './documentsService.js';

const bad = (message: string, key?: string): never => { throw new HttpError(400, message, key); };
const notFound = (): never => { throw new HttpError(404, 'Not found.', 'err.notFound'); };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const t = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const d = (v: unknown) => (typeof v === 'string' && DATE.test(v) ? v : null);
const money = (v: unknown): string => {
  const s = String(v ?? '').replace(/,/g, '').trim();
  if (!s) return '0.00';
  try { const m = toMinor(s); if (m < 0n) bad('Amounts cannot be negative.', 'err.amount'); return fromMinor(m); } catch (e) { if (e instanceof HttpError) throw e; return bad('Amounts have at most 2 decimals.', 'err.amountFormat'); }
};
const pick = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);

export const LEAD_SOURCES = ['referral', 'website', 'walk_in', 'phone', 'social', 'exhibition', 'campaign', 'other'] as const;
export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'] as const;
export const STAGES = ['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
export const OPEN_STAGES = ['new', 'qualified', 'proposal', 'negotiation'] as const;
/** How likely a deal at each stage is to be won, for the weighted pipeline. */
export const STAGE_CHANCE: Record<(typeof STAGES)[number], number> = { new: 10, qualified: 25, proposal: 50, negotiation: 75, won: 100, lost: 0 };
export const ACTIVITY_KINDS = ['call', 'meeting', 'task', 'email', 'note'] as const;
export const CHANNELS = ['email', 'sms', 'whatsapp', 'social', 'event', 'print', 'other'] as const;

export const people = async (db: Db, companyId: string) => (await db.query('SELECT id, name FROM crm_people($1)', [companyId])).rows as { id: string; name: string }[];

// ------------------------------------------------------------------ campaigns
export async function listCampaigns(db: Db, companyId: string) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.channel, c.start_date::text AS "startDate", c.end_date::text AS "endDate", c.budget::text, c.status, c.audience, c.notes,
            (SELECT count(*) FROM crm_leads l WHERE l.campaign_id = c.id)::int AS leads,
            (SELECT count(*) FROM crm_leads l WHERE l.campaign_id = c.id AND l.status = 'converted')::int AS converted,
            (SELECT count(*) FROM crm_deals x JOIN crm_leads l ON l.id = x.lead_id WHERE l.campaign_id = c.id AND x.stage = 'won')::int AS won,
            (SELECT coalesce(sum(x.value), 0) FROM crm_deals x JOIN crm_leads l ON l.id = x.lead_id WHERE l.campaign_id = c.id AND x.stage = 'won')::numeric(18,2)::text AS "wonValue"
     FROM crm_campaigns c WHERE c.company_id = $1 ORDER BY c.status = 'done', coalesce(c.start_date, c.created_at::date) DESC`, [companyId]);
  return rows.map((r) => ({ ...r, costPerLead: r.leads ? fromMinor(toMinor(r.budget) / BigInt(r.leads)) : null }));
}
export async function saveCampaign(db: Db, companyId: string, x: Record<string, unknown>, id?: string): Promise<string> {
  const name = t(x.name) ?? bad('Enter the campaign name.', 'err.campaignName');
  const start = d(x.startDate), end = d(x.endDate);
  if (start && end && end < start) bad('The end date is before the start date.', 'err.campaignDates');
  const v = [name, pick(x.channel, CHANNELS, 'other'), start, end, money(x.budget), pick(x.status, ['planned', 'running', 'done'] as const, 'planned'), t(x.audience), t(x.notes)];
  if (id) {
    const { rowCount } = await db.query('UPDATE crm_campaigns SET name=$2, channel=$3, start_date=$4, end_date=$5, budget=$6, status=$7, audience=$8, notes=$9 WHERE id = $1', [id, ...v]);
    if (!rowCount) notFound();
    return id;
  }
  return (await db.query(`INSERT INTO crm_campaigns (company_id, name, channel, start_date, end_date, budget, status, audience, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, app_user_id()) RETURNING id`, [companyId, ...v])).rows[0].id;
}

// ------------------------------------------------------------------ leads
const LEAD_COLS = `l.id, l.name, l.name_ar AS "nameAr", l.contact_person AS "contactPerson", l.phone, l.email, l.source, l.campaign_id AS "campaignId", cp.name AS "campaignName",
  l.owner_id AS "ownerId", person_name(l.owner_id) AS "ownerName", l.status, l.estimated_value::text AS "estimatedValue", l.notes, l.lost_reason AS "lostReason",
  l.contact_id AS "contactId", l.created_at AS "createdAt",
  (SELECT min(a.due_date)::text FROM crm_activities a WHERE a.lead_id = l.id AND a.done_at IS NULL) AS "nextActivity"`;
const LEAD_FROM = 'FROM crm_leads l LEFT JOIN crm_campaigns cp ON cp.id = l.campaign_id';

export async function listLeads(db: Db, companyId: string, f: { status?: string; q?: string; ownerId?: string } = {}) {
  const { rows } = await db.query(
    `SELECT ${LEAD_COLS} ${LEAD_FROM} WHERE l.company_id = $1
       AND ($2 = '' OR ($2 = 'open' AND l.status IN ('new', 'contacted', 'qualified')) OR l.status = $2)
       AND ($3 = '' OR l.name ILIKE '%' || $3 || '%' OR coalesce(l.contact_person, '') ILIKE '%' || $3 || '%' OR coalesce(l.phone, '') LIKE '%' || $3 || '%')
       AND ($4::uuid IS NULL OR l.owner_id = $4)
     ORDER BY l.status IN ('converted', 'lost'), l.created_at DESC`, [companyId, f.status ?? '', (f.q ?? '').trim(), f.ownerId || null]);
  return rows;
}
export async function getLead(db: Db, id: string) {
  return (await db.query(`SELECT ${LEAD_COLS}, l.company_id AS "companyId" ${LEAD_FROM} WHERE l.id = $1`, [id])).rows[0] ?? notFound();
}
export async function saveLead(db: Db, companyId: string, x: Record<string, unknown>, id?: string): Promise<string> {
  const name = t(x.name) ?? bad('Enter the name of the possible customer.', 'err.leadName');
  const email = t(x.email);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Check the email address.', 'err.email');
  if (!t(x.phone) && !email) bad('Enter a phone number or an email so someone can follow up.', 'err.leadReach');
  const status = pick(x.status, ['new', 'contacted', 'qualified', 'lost'] as const, 'new');
  if (status === 'lost' && !t(x.lostReason)) bad('Say why the lead was lost.', 'err.lostReason');
  const campaign = t(x.campaignId);
  const v = [name, t(x.nameAr), t(x.contactPerson), t(x.phone), email, campaign ? 'campaign' : pick(x.source, LEAD_SOURCES, 'other'), campaign, t(x.ownerId), money(x.estimatedValue), t(x.notes),
    status === 'lost' ? t(x.lostReason) : null];
  if (id) {
    const old = await getLead(db, id);
    if (old.status === 'converted') bad('This lead is already a customer.', 'err.leadConverted');
    const { rowCount } = await db.query(`UPDATE crm_leads SET name=$2, name_ar=$3, contact_person=$4, phone=$5, email=$6, source=$7, campaign_id=$8, owner_id=$9,
        estimated_value=$10, notes=$11, lost_reason=$12, status=$13 WHERE id = $1`, [id, ...v, status]);
    if (!rowCount) notFound();
    return id;
  }
  return (await db.query(`INSERT INTO crm_leads (company_id, name, name_ar, contact_person, phone, email, source, campaign_id, owner_id, estimated_value, notes, lost_reason, status, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, app_user_id()) RETURNING id`, [companyId, ...v, status])).rows[0].id;
}

/** Makes the lead a customer (a new one, or an existing customer chosen), moves its open deals to that customer and, if asked, opens a deal. */
export async function convertLead(db: Db, id: string, x: { contactId?: string | null; dealTitle?: string; dealValue?: string } = {}): Promise<{ contactId: string; dealId: string | null }> {
  const l = await getLead(db, id);
  if (l.status === 'converted') bad('This lead is already a customer.', 'err.leadConverted');
  if (l.status === 'lost') bad('This lead was lost. Reopen it first.', 'err.leadLost');
  const contactId = x.contactId || await saveContact(db, l.companyId, { isCustomer: true, name: l.name, nameAr: l.nameAr ?? undefined, email: l.email ?? undefined, phone: l.phone ?? undefined });
  await db.query(`UPDATE crm_leads SET status = 'converted', contact_id = $2, lost_reason = NULL WHERE id = $1`, [id, contactId]);
  await db.query(`UPDATE crm_deals SET contact_id = $2 WHERE lead_id = $1 AND contact_id IS NULL`, [id, contactId]);
  let dealId: string | null = null;
  if (t(x.dealTitle)) dealId = await saveDeal(db, l.companyId, { title: x.dealTitle, contactId, leadId: id, value: x.dealValue ?? l.estimatedValue, ownerId: l.ownerId, stage: 'qualified' });
  return { contactId, dealId };
}

// ------------------------------------------------------------------ deals
const DEAL_COLS = `x.id, x.title, x.contact_id AS "contactId", c.name AS "customerName", c.name_ar AS "customerNameAr", x.lead_id AS "leadId", l.name AS "leadName",
  x.stage, x.value::text, x.expected_close::text AS "expectedClose", x.owner_id AS "ownerId", person_name(x.owner_id) AS "ownerName", x.quotation_id AS "quotationId",
  q.number AS "quotationNumber", q.status AS "quotationStatus", x.lost_reason AS "lostReason", x.closed_at::text AS "closedAt", x.notes, x.created_at AS "createdAt",
  (SELECT min(a.due_date)::text FROM crm_activities a WHERE a.deal_id = x.id AND a.done_at IS NULL) AS "nextActivity"`;
const DEAL_FROM = `FROM crm_deals x LEFT JOIN contacts c ON c.id = x.contact_id LEFT JOIN crm_leads l ON l.id = x.lead_id LEFT JOIN documents q ON q.id = x.quotation_id`;

/** The pipeline: open deals by stage with their totals and weighted value, plus deals won and lost in the period. */
export async function pipeline(db: Db, companyId: string, f: { ownerId?: string; from?: string; to?: string } = {}) {
  const from = d(f.from) ?? `${today().slice(0, 4)}-01-01`, to = d(f.to) ?? today();
  const { rows } = await db.query(
    `SELECT ${DEAL_COLS} ${DEAL_FROM} WHERE x.company_id = $1 AND ($2::uuid IS NULL OR x.owner_id = $2)
       AND (x.stage NOT IN ('won', 'lost') OR x.closed_at BETWEEN $3 AND $4)
     ORDER BY x.expected_close NULLS LAST, x.created_at`, [companyId, f.ownerId || null, from, to]);
  const stages = STAGES.map((s) => {
    const deals = rows.filter((r) => r.stage === s);
    const total = deals.reduce((a: Minor, r) => a + toMinor(r.value), 0n);
    return { stage: s, chance: STAGE_CHANCE[s], deals, count: deals.length, total: fromMinor(total), weighted: fromMinor((total * BigInt(STAGE_CHANCE[s]) + 50n) / 100n) };
  });
  const open = stages.filter((s) => (OPEN_STAGES as readonly string[]).includes(s.stage));
  const sum = (xs: typeof stages, k: 'total' | 'weighted') => fromMinor(xs.reduce((a, s) => a + toMinor(s[k]), 0n));
  const won = stages.find((s) => s.stage === 'won')!, lost = stages.find((s) => s.stage === 'lost')!;
  return { from, to, stages, openTotal: sum(open, 'total'), weighted: sum(open, 'weighted'), wonTotal: won.total, wonCount: won.count, lostCount: lost.count,
    winRate: won.count + lost.count ? Math.round((won.count * 100) / (won.count + lost.count)) : null };
}
export async function getDeal(db: Db, id: string) {
  return (await db.query(`SELECT ${DEAL_COLS}, x.company_id AS "companyId" ${DEAL_FROM} WHERE x.id = $1`, [id])).rows[0] ?? notFound();
}
export async function saveDeal(db: Db, companyId: string, x: Record<string, unknown>, id?: string): Promise<string> {
  const title = t(x.title) ?? bad('Enter what the deal is for.', 'err.dealTitle');
  const contactId = t(x.contactId), leadId = t(x.leadId);
  if (!contactId && !leadId) bad('Choose the customer or the lead.', 'err.dealWho');
  const stage = pick(x.stage, STAGES, 'new');
  if (stage === 'lost' && !t(x.lostReason)) bad('Say why the deal was lost.', 'err.lostReason');
  const closing = stage === 'won' || stage === 'lost';
  const old = id ? await getDeal(db, id) : null;
  const closedAt = closing ? (old?.closedAt && old.stage === stage ? old.closedAt : today()) : null;
  const v = [title, contactId, leadId, stage, money(x.value), d(x.expectedClose), t(x.ownerId), stage === 'lost' ? t(x.lostReason) : null, closedAt, t(x.notes)];
  if (id) {
    const { rowCount } = await db.query(`UPDATE crm_deals SET title=$2, contact_id=$3, lead_id=$4, stage=$5, value=$6, expected_close=$7, owner_id=$8, lost_reason=$9, closed_at=$10, notes=$11
      WHERE id = $1`, [id, ...v]);
    if (!rowCount) notFound();
    return id;
  }
  return (await db.query(`INSERT INTO crm_deals (company_id, title, contact_id, lead_id, stage, value, expected_close, owner_id, lost_reason, closed_at, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, app_user_id()) RETURNING id`, [companyId, ...v])).rows[0].id;
}
/** Moves a deal to another stage (the board's buttons). */
export async function moveDeal(db: Db, id: string, stage: string, lostReason?: string) {
  const x = await getDeal(db, id);
  await saveDeal(db, x.companyId, { ...x, value: x.value, stage, lostReason: lostReason ?? x.lostReason }, id);
}
/** Starts a draft quotation for the deal's customer with one line for its value, and links it. */
export async function quoteDeal(db: Db, id: string): Promise<string> {
  const x = await getDeal(db, id);
  if (!x.contactId) bad('Make the lead a customer first.', 'err.dealNeedsCustomer');
  if (x.quotationId) bad('This deal already has a quotation.', 'err.dealHasQuotation');
  if (x.stage === 'won' || x.stage === 'lost') bad('This deal is closed.', 'err.dealClosed');
  const sales = (await db.query('SELECT id FROM accounts WHERE company_id = $1 AND code = $2', [x.companyId, SYSTEM_ACCOUNTS.sales])).rows[0]?.id ?? bad('No sales account.', 'err.chart');
  const vatStatus = (await db.query('SELECT vat_status FROM companies WHERE id = $1', [x.companyId])).rows[0].vat_status;
  const qid = await saveDraft(db, x.companyId, { type: 'quotation', contactId: x.contactId, issueDate: today(), reference: x.title,
    lines: [{ description: x.title, quantity: '1', unitPrice: x.value, accountId: sales, vatCode: vatStatus === 'registered' ? 'standard' : 'out_of_scope' }] });
  await db.query(`UPDATE crm_deals SET quotation_id = $2, stage = CASE WHEN stage IN ('new', 'qualified') THEN 'proposal' ELSE stage END WHERE id = $1`, [id, qid]);
  return qid;
}

// ------------------------------------------------------------------ activities
const ACT_COLS = `a.id, a.kind, a.subject, a.notes, a.due_date::text AS "dueDate", a.due_time AS "dueTime", a.done_at AS "doneAt", a.lead_id AS "leadId", l.name AS "leadName",
  a.deal_id AS "dealId", x.title AS "dealTitle", a.contact_id AS "contactId", c.name AS "contactName", c.name_ar AS "contactNameAr", a.owner_id AS "ownerId", person_name(a.owner_id) AS "ownerName"`;
const ACT_FROM = `FROM crm_activities a LEFT JOIN crm_leads l ON l.id = a.lead_id LEFT JOIN crm_deals x ON x.id = a.deal_id LEFT JOIN contacts c ON c.id = a.contact_id`;

export async function listActivities(db: Db, companyId: string, f: { show?: string; ownerId?: string; leadId?: string; dealId?: string; contactId?: string } = {}) {
  const show = f.show ?? 'open';
  const { rows } = await db.query(
    `SELECT ${ACT_COLS} ${ACT_FROM} WHERE a.company_id = $1
       AND ($2 = 'all' OR ($2 = 'open' AND a.done_at IS NULL) OR ($2 = 'overdue' AND a.done_at IS NULL AND a.due_date < current_date) OR ($2 = 'done' AND a.done_at IS NOT NULL))
       AND ($3::uuid IS NULL OR a.owner_id = $3) AND ($4::uuid IS NULL OR a.lead_id = $4) AND ($5::uuid IS NULL OR a.deal_id = $5) AND ($6::uuid IS NULL OR a.contact_id = $6)
     ORDER BY a.done_at IS NOT NULL, a.done_at DESC NULLS FIRST, a.due_date NULLS LAST, a.due_time NULLS LAST, a.created_at`,
    [companyId, show, f.ownerId || null, f.leadId || null, f.dealId || null, f.contactId || null]);
  return rows;
}
export async function saveActivity(db: Db, companyId: string, x: Record<string, unknown>, id?: string): Promise<string> {
  const subject = t(x.subject) ?? bad('Enter what the activity is about.', 'err.activitySubject');
  const time = t(x.dueTime);
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) bad('Enter the time as hours and minutes.', 'err.activityTime');
  const links = [t(x.leadId), t(x.dealId), t(x.contactId)].filter(Boolean);
  if (links.length > 1) bad('Link the activity to one lead, deal or customer.', 'err.activityLink');
  const v = [pick(x.kind, ACTIVITY_KINDS, 'task'), subject, t(x.notes), d(x.dueDate), time, t(x.leadId), t(x.dealId), t(x.contactId), t(x.ownerId)];
  if (id) {
    const { rowCount } = await db.query(`UPDATE crm_activities SET kind=$2, subject=$3, notes=$4, due_date=$5, due_time=$6, lead_id=$7, deal_id=$8, contact_id=$9, owner_id=$10 WHERE id = $1`, [id, ...v]);
    if (!rowCount) notFound();
    return id;
  }
  return (await db.query(`INSERT INTO crm_activities (company_id, kind, subject, notes, due_date, due_time, lead_id, deal_id, contact_id, owner_id, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, app_user_id()) RETURNING id`, [companyId, ...v])).rows[0].id;
}
export async function setActivityDone(db: Db, id: string, done: boolean) {
  const { rowCount } = await db.query('UPDATE crm_activities SET done_at = CASE WHEN $2 THEN now() END WHERE id = $1', [id, done]);
  if (!rowCount) notFound();
}
export async function deleteActivity(db: Db, id: string) {
  const { rowCount } = await db.query('DELETE FROM crm_activities WHERE id = $1', [id]);
  if (!rowCount) notFound();
}
