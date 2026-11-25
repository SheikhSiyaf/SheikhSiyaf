// The hourly trial job, nobody signed in: moves unpaid trials on (open -> ended -> closed, as the clock says) and queues the
// reminder e-mails that are due. LIFECYCLE_JOBS=off turns the whole job off; the e-mails also need TRIAL_EMAILS=on (they are off
// until the owner has read the texts and switched them on), PUBLIC_URL for the button's address.
import type pg from 'pg';
import { runExclusive } from '../jobs/runJob.js';
import { advance } from './trialService.js';
import { SUPPORT, sendTrialEmails } from './trialEmails.js';
import { ownerAlert } from './trialOrders.js';

export function startLifecycleJob(pool: pg.Pool, log: (m: string) => void = console.log) {
  if (process.env.LIFECYCLE_JOBS === 'off') return () => undefined;
  const go = async () => {
    await runExclusive(pool, 'lifecycle', async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const now = new Date();
        const moved = await advance(c, now);
        for (const m of moved) if (m.to === 'trial_ended') await ownerAlert(c, 'trial_ended_unpaid', { firmId: m.firmId });
        const mails = await sendTrialEmails(c, now, { enabled: process.env.TRIAL_EMAILS === 'on', appUrl: (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '') || 'https://app.nusuhbooks.com', copyTo: SUPPORT.email });
        await c.query('SELECT signup_cleanup()');   // old, never-confirmed sign-up requests
        await c.query('COMMIT');
        if (moved.length) log(`Trials: ${moved.length} moved on`);
        if (mails.sent.length) log(`Trials: ${mails.sent.length} reminder e-mail(s) queued`);
        for (const f of mails.failed) log(`Trials: reminder for ${f.firmId} failed (will be tried again): ${f.error}`);
      } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    }).catch((e) => log(`Trial job failed: ${(e as Error).message}`));
  };
  const first = setTimeout(() => void go(), 45_000);
  const every = setInterval(() => void go(), 60 * 60 * 1000);
  first.unref(); every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
