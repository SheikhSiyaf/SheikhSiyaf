// The guided first-run setup (db/migrations/0075_trial_setup.sql, rules in setupRules.ts). Every answer is checked against the lists
// in the rules here, on the server. Switching on modules is only possible while the customer is in its unpaid trial (the database checks).
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { STEPS, cleanAnswers, industryRows, modulesForGoals, GUIDE_PAGES, type BusinessType, type Step } from './setupRules.js';
import * as Imp from './importService.js';

const bad = (message: string, key: string): never => { throw new HttpError(400, message, key); };

export interface SetupState {
  step: Step; businessType: BusinessType | null; goals: string[]; dataChoice: 'import' | 'fresh' | null; skipped: boolean; completed: boolean; tourSeen: string[];
  inTrial: boolean; show: boolean; companies: { id: string; name: string; modules: string[] }[];
}
export const mySetup = async (db: Db): Promise<SetupState | null> => (await db.query('SELECT my_setup() AS s')).rows[0].s ?? null;

export interface SaveInput { step?: unknown; businessType?: unknown; goals?: unknown; dataChoice?: unknown; skip?: unknown; done?: unknown }
export async function saveStep(db: Db, x: SaveInput): Promise<SetupState | null> {
  const step = String(x.step ?? '');
  if (!(STEPS as readonly string[]).includes(step)) bad('Unknown setup step.', 'err.setupStep');
  const a = cleanAnswers(x);
  if (!a.ok) return bad('Choose from the lists shown.', 'err.setupAnswer');
  const before = await mySetup(db);
  if (!before) throw new HttpError(403, 'Not allowed.', 'err.forbidden');
  await db.query('SELECT setup_save($1, $2, $3, $4, $5, $6)', [step, a.value.businessType ?? null, a.value.goals ?? null, a.value.dataChoice ?? null, x.skip === true, x.done === true || step === 'done']);
  // The goals switch on the optional modules they need, for a customer that keeps one company's books (an accounting firm picks per client).
  const wanted = a.value.goals ? modulesForGoals(a.value.goals) : [];
  if (wanted.length && before.inTrial && before.companies.length === 1) await db.query('SELECT setup_apply_modules($1, $2)', [before.companies[0]!.id, wanted]);
  return mySetup(db);
}

/** Adds the accounts a kind of business usually needs to one company, through the ordinary accounts import (existing codes are left alone; nothing is posted). */
export async function applyChart(db: Db, companyId: string, businessType: unknown): Promise<{ added: number }> {
  if (!['trading', 'services', 'restaurant', 'rentals', 'contracting', 'other'].includes(String(businessType))) bad('Choose your kind of business.', 'err.setupAnswer');
  if (!(await db.query('SELECT 1 FROM companies WHERE id = $1', [companyId])).rows.length) throw new HttpError(404, 'Company not found.', 'err.notFound');
  const rows = industryRows(businessType as BusinessType);
  if (!rows.length) return { added: 0 };
  try { return { added: (await Imp.run(db, companyId, 'accounts', rows)).imported }; }
  catch (e) { if (e instanceof HttpError && e.key === 'err.importNothing') return { added: 0 }; throw e; }
}

export async function tourSeen(db: Db, page: unknown): Promise<void> {
  if (!(GUIDE_PAGES as readonly string[]).includes(String(page))) bad('Unknown page.', 'err.setupAnswer');
  await db.query('SELECT setup_tour_seen($1)', [String(page)]);
}
