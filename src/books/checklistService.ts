// The checklist beside the bell: reads what is true of the company, builds this person's list (checklistRules.ts), and saves ticks,
// personal hiding and the Administrator's changes. Row-level security does the separation between companies and between people;
// the checks here decide which items a role may see and tick, and the Administrator-only changes (the database enforces those too).
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import {
  BUILT_IN, BUILT_IN_KEYS, buildChecklist, cleanItem, newKey, periodKey, previousMonth, progress, setupList,
  type Facts, type Item, type Override, type Role, type Tick,
} from './checklistRules.js';

const bad = (key = 'err.checklistInput') => new HttpError(400, 'That checklist change is not allowed.', key);
const notFound = () => new HttpError(404, 'Not found.', 'err.notFound');

async function readFacts(db: Db, companyId: string, today: string, monthEnd: string): Promise<Facts> {
  const r = (await db.query(
    `SELECT co.country, co.vat_status::text AS "vatStatus", co.cr_number AS cr, co.vat_number AS vat, co.modules,
        co.address <> 'To be completed in company settings' AS "addressDone", co.logo_path IS NOT NULL AS logo,
        EXISTS (SELECT 1 FROM bank_accounts WHERE company_id = $1 AND kind = 'bank') AS "bankAccounts",
        EXISTS (SELECT 1 FROM contacts WHERE company_id = $1 AND is_customer) AS customers,
        EXISTS (SELECT 1 FROM contacts WHERE company_id = $1 AND is_supplier) AS suppliers,
        EXISTS (SELECT 1 FROM items WHERE company_id = $1) AS items,
        EXISTS (SELECT 1 FROM journal_entries WHERE company_id = $1) AS entries,
        EXISTS (SELECT 1 FROM documents WHERE company_id = $1 AND type = 'invoice' AND status = 'issued') AS invoice,
        EXISTS (SELECT 1 FROM einvoice_devices WHERE company_id = $1 AND status = 'active') OR coalesce((SELECT enabled FROM einvoice_settings WHERE company_id = $1), false) AS einvoicing,
        EXISTS (SELECT 1 FROM approval_rules WHERE company_id = $1 AND active) AS "approvalRules",
        EXISTS (SELECT 1 FROM bank_statement_lines WHERE company_id = $1 AND status = 'open') AS "openBankLines",
        EXISTS (SELECT 1 FROM bank_statement_lines WHERE company_id = $1 AND status = 'open' AND txn_date <= $2::date) AS "openBankLinesToMonthEnd",
        EXISTS (SELECT 1 FROM documents WHERE company_id = $1 AND status = 'draft' AND type::text NOT IN ('quotation', 'purchase_order') AND (issue_date IS NULL OR issue_date <= $2::date)) AS "draftsToMonthEnd",
        EXISTS (SELECT 1 FROM review_signoffs WHERE company_id = $1 AND period_end = $2::date AND withdrawn_at IS NULL) AS "signedOff"
       FROM companies co WHERE co.id = $1`, [companyId, monthEnd])).rows[0];
  void today;
  const p = (await db.query('SELECT members, twofa FROM checklist_people($1)', [companyId])).rows[0];
  return { ...r, modules: r.modules ?? [], members: p?.members ?? 0, twofa: p?.twofa ?? false };
}

async function readRole(db: Db, companyId: string): Promise<Role | null> {
  const r = (await db.query('SELECT permissions, can_approve AS "canApprove", can_sign_off AS "canSignOff" FROM app_client_role($1)', [companyId])).rows[0];
  return r ? { permissions: r.permissions ?? {}, canApprove: !!r.canApprove, canSignOff: !!r.canSignOff } : null;
}

export interface Checklist {
  items: Item[]; progress: { done: number; total: number; open: number }; isAdmin: boolean; today: string; month: string;
}

/** This person's checklist for this company. `at` is only for tests (the clock). */
export async function checklistFor(db: Db, companyId: string, at?: Date): Promise<Checklist> {
  const clock = (await db.query(`SELECT ((coalesce($1::timestamptz, now())) AT TIME ZONE 'Asia/Riyadh')::date::text AS today, app_user_id() AS uid, app_is_admin() AS admin`, [at ?? null])).rows[0];
  const prev = previousMonth(clock.today);
  const [facts, role, over, ticks, hid] = await Promise.all([
    readFacts(db, companyId, clock.today, prev.end),
    readRole(db, companyId),
    db.query(OVERRIDE_SQL, [companyId]),
    db.query(`SELECT item_key AS key, user_id AS "userId", period, done_at::text AS at FROM checklist_ticks WHERE company_id = $1`, [companyId]),
    db.query('SELECT item_key FROM checklist_hidden WHERE company_id = $1 AND user_id = app_user_id()', [companyId]),
  ]);
  const items = buildChecklist({
    facts, role, isAdmin: !!clock.admin, today: clock.today, userId: clock.uid,
    overrides: over.rows as Override[], ticks: ticks.rows as Tick[], hiddenByMe: hid.rows.map((x) => x.item_key as string),
  });
  return { items, progress: progress(items), isAdmin: !!clock.admin, today: clock.today, month: prev.period };
}

const OVERRIDE_SQL = `SELECT key, is_custom AS "isCustom", area, scope, title, title_ar AS "titleAr", help, help_ar AS "helpAr", go_module AS "goModule", go_sub AS "goSub", sort, hidden
                FROM checklist_items WHERE company_id = $1`;

/** What the Administrator edits: the definitions of the list, with nothing from the books (so it works for an Administrator who is not a member too). */
export async function adminSetup(db: Db, companyId: string): Promise<{ items: ReturnType<typeof setupList> }> {
  await requireAdmin(db);
  return { items: setupList((await db.query(OVERRIDE_SQL, [companyId])).rows as Override[]) };
}

/** The item as this person sees it, or a 404: a person can only touch what the list shows them (an item their role cannot see does not exist for them). */
async function visibleItem(db: Db, companyId: string, key: unknown, at?: Date): Promise<{ item: Item; today: string; uid: string }> {
  if (typeof key !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(key)) throw bad();
  const c = await checklistFor(db, companyId, at);
  const item = c.items.find((x) => x.key === key);
  if (!item) throw notFound();
  const uid = (await db.query('SELECT app_user_id() AS uid')).rows[0].uid as string;
  return { item, today: c.today, uid };
}

/** Tick or un-tick by hand. An item that ticks itself from the books cannot be un-ticked here (the books decide). */
export async function setTick(db: Db, companyId: string, key: unknown, done: unknown, at?: Date): Promise<void> {
  if (typeof done !== 'boolean') throw bad();
  const { item, today, uid } = await visibleItem(db, companyId, key, at);
  const built = BUILT_IN.find((b) => b.key === item.key);
  if (item.how === 'auto') { if (!done) throw bad('err.checklistAuto'); return; }
  const period = periodKey(built?.period ?? 'once', today);
  const userId = item.scope === 'user' ? uid : null;
  if (done) {
    await db.query(
      `INSERT INTO checklist_ticks (company_id, item_key, user_id, period, done_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, item_key, (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)), period) DO NOTHING`, [companyId, item.key, userId, period, uid]);
  } else {
    await db.query(`DELETE FROM checklist_ticks WHERE company_id = $1 AND item_key = $2 AND period = $3 AND user_id IS NOT DISTINCT FROM $4`, [companyId, item.key, period, userId]);
  }
}

/** Hide an item from your own list, or bring it back. Nobody else is affected. */
export async function hideForMe(db: Db, companyId: string, key: unknown, hidden: unknown, at?: Date): Promise<void> {
  if (typeof hidden !== 'boolean') throw bad();
  const { item, uid } = await visibleItem(db, companyId, key, at);
  if (hidden) await db.query('INSERT INTO checklist_hidden (company_id, user_id, item_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [companyId, uid, item.key]);
  else await db.query('DELETE FROM checklist_hidden WHERE company_id = $1 AND user_id = $2 AND item_key = $3', [companyId, uid, item.key]);
}

async function requireAdmin(db: Db): Promise<void> {
  if (!(await db.query('SELECT app_is_admin() AS a')).rows[0].a) throw new HttpError(403, 'Only the company Administrator can change the checklist.', 'err.checklistAdmin');
}

const col = { title: 'title', titleAr: 'title_ar', help: 'help', helpAr: 'help_ar', goModule: 'go_module', goSub: 'go_sub', hidden: 'hidden' } as const;

/** The Administrator adds an item (no key) or changes one: a custom item fully, a built-in one only its wording and whether it is hidden. */
export async function saveItem(db: Db, companyId: string, raw: unknown): Promise<{ key: string }> {
  await requireAdmin(db);
  const create = !(raw && typeof raw === 'object' && typeof (raw as { key?: unknown }).key === 'string');
  const c = cleanItem(raw, create);
  if (!c.ok) throw bad();
  const v = c.value;
  if (create) {
    const key = newKey(randomUUID());
    const next = Number((await db.query(`SELECT coalesce(max(sort), 1000) + 10 AS n FROM checklist_items WHERE company_id = $1`, [companyId])).rows[0].n);
    await db.query(
      `INSERT INTO checklist_items (company_id, key, is_custom, area, scope, title, title_ar, help, help_ar, go_module, go_sub, sort, hidden)
       VALUES ($1, $2, true, $3, $4, $5, $6, $7, $8, $9, $10, $11, false)`,
      [companyId, key, v.area, v.scope ?? 'company', v.title, v.titleAr ?? null, v.help ?? null, v.helpAr ?? null, v.goModule ?? null, v.goSub ?? null, next]);
    return { key };
  }
  const key = v.key!;
  const existing = (await db.query('SELECT is_custom FROM checklist_items WHERE company_id = $1 AND key = $2', [companyId, key])).rows[0];
  const builtIn = BUILT_IN_KEYS.has(key);
  if (!builtIn && !existing) throw notFound();
  if (builtIn && (v.area !== undefined || v.scope !== undefined || v.goModule !== undefined || v.goSub !== undefined)) throw bad();
  if (!existing) await db.query('INSERT INTO checklist_items (company_id, key, is_custom) VALUES ($1, $2, false)', [companyId, key]);
  const sets: string[] = []; const vals: unknown[] = [companyId, key];
  for (const [name, column] of Object.entries(col) as [keyof typeof col, string][]) {
    if (v[name] !== undefined) { vals.push(v[name]); sets.push(`${column} = $${vals.length}`); }
  }
  if (!builtIn && v.area !== undefined) { vals.push(v.area); sets.push(`area = $${vals.length}`); }
  if (!builtIn && v.scope !== undefined) { vals.push(v.scope); sets.push(`scope = $${vals.length}`); }
  if (!builtIn && (v.title === null)) throw bad();
  if (sets.length) await db.query(`UPDATE checklist_items SET ${sets.join(', ')} WHERE company_id = $1 AND key = $2`, vals);
  return { key };
}

/** Remove an item the Administrator added. Built-in items are hidden instead, never removed. */
export async function deleteItem(db: Db, companyId: string, key: unknown): Promise<void> {
  await requireAdmin(db);
  if (typeof key !== 'string' || !/^c_[a-f0-9]{1,12}$/.test(key)) throw bad();
  const r = await db.query('DELETE FROM checklist_items WHERE company_id = $1 AND key = $2 AND is_custom', [companyId, key]);
  if (!r.rowCount) throw notFound();
  await db.query('DELETE FROM checklist_ticks WHERE company_id = $1 AND item_key = $2', [companyId, key]);
}

/** The Administrator sets the order: the keys given are numbered in turn (10, 20, 30...). Unknown or repeated keys are refused. */
export async function reorder(db: Db, companyId: string, keys: unknown): Promise<void> {
  await requireAdmin(db);
  if (!Array.isArray(keys) || keys.length > 80 || new Set(keys).size !== keys.length || keys.some((k) => typeof k !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(k))) throw bad();
  const custom = new Set((await db.query('SELECT key FROM checklist_items WHERE company_id = $1 AND is_custom', [companyId])).rows.map((r) => r.key as string));
  for (const k of keys as string[]) if (!BUILT_IN_KEYS.has(k) && !custom.has(k)) throw bad();
  let n = 0;
  for (const k of keys as string[]) {
    n += 10;
    await db.query(
      `INSERT INTO checklist_items (company_id, key, is_custom, sort) VALUES ($1, $2, false, $3)
       ON CONFLICT (company_id, key) DO UPDATE SET sort = EXCLUDED.sort`, [companyId, k, n + 0]);
  }
}
