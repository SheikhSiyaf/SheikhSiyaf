// Demo-site switches: OUTSIDE_CALLS=off stops every call to an outside service; AUTH_PURGE_JOBS=off stops the sign-in
// attempt cleanup job. No database needed.
import { describe, it, expect, vi, afterEach } from 'vitest';
import type pg from 'pg';
import { assertOutsideCalls, guardFetch } from '../src/outside.js';
import { HttpError } from '../src/api/errors.js';
import { sendEmail, type Fetch } from '../src/email/transport.js';
import { syncRates } from '../src/books/fxJobs.js';
import { startAuthPurgeJob } from '../src/auth/throttle.js';

const saved = { OUTSIDE_CALLS: process.env.OUTSIDE_CALLS, AUTH_PURGE_JOBS: process.env.AUTH_PURGE_JOBS };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.useRealTimers();
});

describe('OUTSIDE_CALLS=off', () => {
  it('refuses with a plain, translatable message, and allows calls when not set', () => {
    expect(() => assertOutsideCalls()).not.toThrow();
    process.env.OUTSIDE_CALLS = 'off';
    try { assertOutsideCalls(); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(403);
      expect((e as HttpError).key).toBe('err.outsideOff');
    }
  });

  it('a guarded fetch never sends the request', async () => {
    const inner = vi.fn(async () => 'sent');
    const f = guardFetch(inner);
    expect(await f()).toBe('sent');
    process.env.OUTSIDE_CALLS = 'off';
    expect(() => f()).toThrow(/switched off/);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('email waits in the outbox instead of going to the provider', async () => {
    process.env.OUTSIDE_CALLS = 'off';
    const fetchFn = vi.fn() as unknown as Fetch;
    const r = await sendEmail({ to: 'a@b.example', subject: 'Hi', text: 'Hello' }, { provider: 'resend', from: 'x@y.example', key: 'k' }, fetchFn);
    expect(r).toMatchObject({ ok: false, hold: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('exchange rates are not fetched; the central bank pegs are still stored', async () => {
    process.env.OUTSIDE_CALLS = 'off';
    const pool = { query: vi.fn(async (sql: string) => (sql.includes('fx_sync_needs') ? { rows: [{ base: 'SAR', currencies: [], have: 0 }] } : { rows: [{ n: 1 }] })) } as unknown as pg.Pool;
    const fetchJson = vi.fn();
    const [r] = await syncRates(pool, { day: '2026-11-15', fetchJson });
    expect(fetchJson).not.toHaveBeenCalled();
    expect(r?.provider).toBe(false);
    expect(r?.problem).toMatch(/switched off/);
  });
});

describe('AUTH_PURGE_JOBS=off', () => {
  const run = async () => {
    vi.useFakeTimers();
    const pool = { query: vi.fn(async () => ({ rows: [{ n: 0 }] })) } as unknown as pg.Pool;
    const stop = startAuthPurgeJob(pool, () => undefined);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    stop();
    return (pool.query as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
  };
  it('the sign-in attempt cleanup runs hourly by default', async () => { expect(await run()).toBeGreaterThanOrEqual(2); });
  it('and never runs when switched off', async () => { process.env.AUTH_PURGE_JOBS = 'off'; expect(await run()).toBe(0); });
});
