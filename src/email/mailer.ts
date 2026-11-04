// The sender job: every minute, the next queued emails go to the provider; failures are retried later
// (db/migrations/0031_email.sql). Runs with nobody signed in.
import type pg from 'pg';
import { emailConfig, sendEmail, type EmailConfig, type Fetch } from './transport.js';

export async function sendQueued(pool: pg.Pool, o: { limit?: number; cfg?: EmailConfig; fetchFn?: Fetch } = {}) {
  const rows = (await pool.query('SELECT * FROM email_take($1)', [o.limit ?? 20])).rows;
  const out: { id: string; ok: boolean; error: string | null }[] = [];
  for (const r of rows) {
    const res = await sendEmail({ to: r.to_email, toName: r.to_name, replyTo: r.reply_to, subject: r.subject, text: r.body_text, html: r.body_html, attachments: r.attachments },
      o.cfg ?? emailConfig(), o.fetchFn);
    await pool.query('SELECT email_done($1, $2, $3, $4, $5)', [r.id, res.ok, res.ok ? null : res.error, res.ok ? res.providerId : null, !res.ok && res.hold]);
    out.push({ id: r.id, ok: res.ok, error: res.ok ? null : res.error });
  }
  return out;
}

export function startMailer(pool: pg.Pool, log: (m: string) => void = console.log) {
  if (process.env.EMAIL_JOBS === 'off') return () => undefined;
  if (emailConfig().provider === 'none') log('Email: no provider set (EMAIL_PROVIDER); emails wait in the outbox.');
  let running = false;
  const t = setInterval(() => {
    if (running) return;
    running = true;
    void sendQueued(pool).then((r) => { const bad = r.filter((x) => !x.ok && x.error && !x.error.startsWith('No email provider')); if (bad.length) log(`Email: ${bad.length} not sent (${bad[0]!.error})`); })
      .catch((e) => log(`Email job failed: ${(e as Error).message}`)).finally(() => { running = false; });
  }, 60_000);
  t.unref();
  return () => clearInterval(t);
}
