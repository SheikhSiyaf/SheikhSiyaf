// The hand-over from the website's Order button (migration 0092). The visitor arrives with only a module selection. We keep that selection on the
// server under a secret token, attach it to the sign-up or the signed-in customer, and show it pre-ticked on the buy screen. Nothing the visitor
// sends can be a price, an amount, a discount, a status or an id: those fields are never read, and the order is priced in the database.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Db } from '../db/session.js';
import { HttpError } from '../api/errors.js';
import { OPTIONAL_MODULES } from './modules.js';
import type { SignupConfig } from './signupService.js';

/** The version of the terms and privacy policy a person accepts at sign-up. Change it when the legal pages change (their wording is the website's). */
export const TERMS_VERSION = '2026-11';

export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const sha = (s: string) => createHash('sha256').update(s).digest('base64url');
const ipKey = (cfg: SignupConfig, ip: string) => createHmac('sha256', cfg.pepper).update(`ip:${ip || 'unknown'}`).digest('base64url');

/** Only listed modules survive, once each; anything else in the request is dropped. */
export function cleanSelection(body: Record<string, unknown>): { modules: string[]; cleanup: boolean } {
  const raw = Array.isArray(body.modules) ? body.modules : typeof body.modules === 'string' ? body.modules.split(',') : [];
  const modules = OPTIONAL_MODULES.filter((m) => raw.slice(0, 40).some((x) => String(x).trim() === m));
  return { modules: [...modules], cleanup: body.cleanup === true || body.cleanup === '1' || body.cleanup === 1 };
}

export async function createIntent(pool: pg.Pool, cfg: SignupConfig, body: unknown, ip: string): Promise<{ token: string; modules: string[]; cleanup: boolean }> {
  const sel = cleanSelection((body && typeof body === 'object' ? body : {}) as Record<string, unknown>);
  const token = randomBytes(32).toString('base64url');
  const r = (await pool.query('SELECT order_intent_create($1, $2::text[], $3, $4) AS r', [sha(token), sel.modules, sel.cleanup, ipKey(cfg, ip)])).rows[0].r as string;
  if (r !== 'ok') throw new HttpError(429, 'Too many requests. Wait a few minutes and try again.', 'err.tooMany');
  return { token, ...sel };
}

export async function peekIntent(pool: pg.Pool, token: unknown): Promise<{ modules: string[]; cleanup: boolean } | null> {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  return (await pool.query('SELECT order_intent_peek($1) AS r', [sha(token)])).rows[0].r ?? null;
}

/** For the sign-up: the token the visitor holds, if any. Anything that is not a well-formed token is ignored. */
export const intentHash = (token: unknown): string | null => (typeof token === 'string' && TOKEN.test(token) ? sha(token) : null);

export async function claimIntent(db: Db, token: unknown): Promise<{ modules: string[]; cleanup: boolean; fresh: boolean } | null> {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  return (await db.query('SELECT order_intent_claim($1) AS r', [sha(token)])).rows[0].r ?? null;
}

export const myIntent = async (db: Db): Promise<{ modules: string[]; cleanup: boolean } | null> => (await db.query('SELECT my_order_intent() AS r')).rows[0].r ?? null;
