// Throttling of sign-in and other public endpoints, kept in the database (db/migrations/0040) so the counts survive
// restarts and are shared by every server instance. Each Throttle counts one kind of key: an account (normalised
// email), an IP address, a person's two-factor step, or another public endpoint.
import type pg from 'pg';
import { HttpError } from '../api/errors.js';

type Querier = Pick<pg.Pool, 'query'>;
export interface Limit { kind: string; max: number; windowMs: number }
const MIN15 = 15 * 60_000;
export const LOGIN_LIMITS = {
  /** 5 wrong passwords on one account in 15 minutes lock that account for 15 minutes, even for the right password. */
  account: { kind: 'account', max: 5, windowMs: MIN15 },
  /** 30 failures from one address, across any accounts, in 15 minutes block that address for 15 minutes. */
  ip: { kind: 'ip', max: 30, windowMs: MIN15 },
  /** 5 wrong two-factor codes for one person in 15 minutes lock their code step for 15 minutes. */
  mfa: { kind: 'mfa', max: 5, windowMs: MIN15 },
} satisfies Record<string, Limit>;

/** The normalised account key: the email as typed, trimmed and in lower case. */
export const accountKey = (email: string) => email.trim().toLowerCase();

export class Throttle {
  private now: () => Date;
  constructor(private db: Querier, private limit: Limit & { now?: () => Date }) { this.now = limit.now ?? (() => new Date()); }
  /** Refuses (429) while the key is locked. */
  async check(key: string): Promise<void> {
    const r = await this.db.query('SELECT auth_throttle_blocked($1, $2, $3) AS b', [this.limit.kind, key, this.now()]);
    if (r.rows[0].b) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.', 'err.tooMany');
  }
  /** Counts a failure; returns whether the key is now locked. */
  async fail(key: string): Promise<boolean> {
    const r = await this.db.query('SELECT auth_throttle_fail($1, $2, $3, $4, $5) AS locked',
      [this.limit.kind, key, this.limit.max, Math.round(this.limit.windowMs / 1000), this.now()]);
    return Boolean(r.rows[0].locked);
  }
  /** Clears the key's count (an account after a successful sign-in; an address is never cleared). */
  async clear(key: string): Promise<void> {
    await this.db.query('SELECT auth_throttle_clear($1, $2)', [this.limit.kind, key]);
  }
}

/** Deletes attempts older than 24 hours. */
export async function purgeAttempts(db: Querier): Promise<number> {
  return (await db.query('SELECT auth_throttle_purge() AS n')).rows[0].n as number;
}
/** Runs the purge every hour, with the server's other jobs. */
export function startAuthPurgeJob(pool: pg.Pool, log: (m: string) => void = console.log) {
  const go = () => void purgeAttempts(pool).then((n) => { if (n) log(`Sign-in attempts purged: ${n}`); }).catch((e) => log(`Sign-in attempt purge failed: ${(e as Error).message}`));
  const first = setTimeout(go, 50_000);
  const every = setInterval(go, 60 * 60 * 1000);
  first.unref(); every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
