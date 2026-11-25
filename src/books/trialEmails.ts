// The free-trial reminder e-mails. Plain language, English now (Arabic later), no pressure, no figures that are not in the
// software: prices and names are read from the same place the website reads them (Payment settings), dates are Riyadh time.
// Which reminder is current is decided in trialRules.ts (currentNotice); each one goes to a customer once only
// (db/migrations/0072_trial_emails.sql). These are service messages about the customer's own account: they always send.
import type { Db } from '../db/session.js';
import { queue } from './emailService.js';
import type { Mail } from '../email/templates.js';
import { LIFECYCLE, addDays, currentNotice, endOfRiyadhDay, type Notice, type NoticeKey } from './trialRules.js';
import { stateOf } from './trialService.js';

/** How to reach us, in every reminder. The last reminders are also copied to the owner. */
export const SUPPORT = { email: 'hello@nusuhbooks.com', phone: '+966 546958273', hours: '8:00 am to 6:00 pm', website: 'https://nusuhbooks.com' } as const;
export const COPY_TO_OWNER: readonly NoticeKey[] = ['grace_week', 'closing_soon'];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmtDay = (day: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeZone: 'Asia/Riyadh' }).format(endOfRiyadhDay(day));
const money = (amount: number | string, cur: string) => `${cur} ${Number(amount).toLocaleString('en-US', Number(amount) % 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : undefined)}`;

interface Price { currency: string; lines: { key: string; name: string; amount: number | string }[] }
export interface Ctx { name: string; firm: string; appUrl: string; prices: Price; modules: string[] }

/** A short, plain e-mail: paragraphs, one button, and our contact details at the end. English only. */
function plainMail(subject: string, paragraphs: string[], appUrl: string, buttonText: string): Mail {
  const contact = `Questions? Reply to this e-mail, or write to ${SUPPORT.email} or call ${SUPPORT.phone} (${SUPPORT.hours}, Saudi time).`;
  const text = [...paragraphs, `${buttonText}: ${appUrl}`, contact, '', '— Nusuh Books'].join('\n\n');
  const p = (x: string) => `<p style="margin:0 0 14px">${esc(x).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')}</p>`;
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#14213d;line-height:1.55;max-width:600px">
${paragraphs.map(p).join('')}<p style="margin:18px 0"><a href="${esc(appUrl)}" style="background:#0F766E;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;display:inline-block;font-weight:600">${esc(buttonText)}</a></p>
${p(contact)}<p style="color:#5b6b7b">— Nusuh Books</p></body></html>`;
  return { subject, text, html };
}

function priceSentence(pr: Price): string {
  const by = (k: string) => pr.lines.find((l) => l.key === k);
  const imp = by('implementation'), yr = by('annualCore'), mod = by('perModule');
  if (!imp || !yr || !mod) return '';
  return `Prices (before VAT, in ${pr.currency}): ${imp.name} ${money(imp.amount, pr.currency)} once; ${yr.name} ${money(yr.amount, pr.currency)} each year; ${mod.name} ${money(mod.amount, pr.currency)} each year.`;
}
const buy = (c: Ctx) => `To buy, see ${SUPPORT.website}/pricing/ and pay by bank transfer as shown at ${SUPPORT.website}/how-to-pay/. ${priceSentence(c.prices)}`.trim();

function modulesSentence(c: Ctx): string {
  const mod = c.prices.lines.find((l) => l.key === 'perModule');
  const on = c.modules.length ? `The optional modules switched on in your trial are: ${c.modules.join(', ')}. ` : 'No optional modules are switched on in your trial. ';
  return `${on}The six core modules stay on when you buy. Each optional module stays on only if you buy it${mod ? ` (${money(mod.amount, c.prices.currency)} each year)` : ''}; the others are switched off.`;
}

/** The e-mail for one reminder. Every one says what happens next, gives the date, and has the button, the how-to-buy links and our contact details. */
export function buildNotice(n: Notice, c: Ctx): Mail {
  const last = fmtDay(n.lastDay), graceEnd = fmtDay(n.graceEndsOn);
  const hello = `Hello ${c.name},`;
  const keep = `If you buy before the trial ends, or within ${LIFECYCLE.graceDays} days after it (until ${graceEnd}), you keep the same company and all your data and carry on.`;
  const locks = 'If you do not, the software locks when the trial ends: you can still sign in, buy, and export your data, but you cannot post or change anything.';
  const days = n.daysAfterToday ?? 0;
  const inDays = days === 1 ? 'tomorrow' : days === 0 ? 'today' : `in ${days} days`;
  switch (n.key) {
    case 'welcome':
      return plainMail(`Welcome to Nusuh Books: your ${LIFECYCLE.trialDays}-day free trial has started`, [hello,
        `Your free trial of Nusuh Books for ${c.firm} has started. You can use the full software until 23:59 Saudi time on ${last}. No payment card is needed.`,
        'What to try first: open Getting started on your home page. It lists the first steps, such as adding your bank account, bringing in your customers and suppliers, and issuing your first invoice.',
        `${keep} ${locks}`, buy(c)], c.appUrl, 'Open Nusuh Books');
    case 'five_days':
      return plainMail(`Your Nusuh Books trial ends ${inDays}`, [hello,
        `Your free trial for ${c.firm} ends at 23:59 Saudi time on ${last}, ${inDays}.`, `${keep} ${locks}`, buy(c)], c.appUrl, 'Open Nusuh Books');
    case 'two_days':
      return plainMail('Your Nusuh Books trial ends in 2 days', [hello,
        `Your free trial for ${c.firm} ends at 23:59 Saudi time on ${last}, in 2 days.`, modulesSentence(c), `${keep} ${locks}`, buy(c)], c.appUrl, 'Open Nusuh Books');
    case 'last_notice':
      return plainMail(`Your Nusuh Books trial ends ${days === 0 ? 'today' : 'tomorrow'}`, [hello,
        `This is the last reminder before access stops. Your free trial for ${c.firm} ends at 23:59 Saudi time ${days === 0 ? 'today' : 'tomorrow'}, ${last}.`,
        modulesSentence(c), `${keep} ${locks}`, buy(c)], c.appUrl, 'Open Nusuh Books');
    case 'trial_ended':
      if (n.softDay) return plainMail('Last day: buy today to keep working in Nusuh Books', [hello,
        `Your free trial for ${c.firm} ended yesterday, but we have kept the software open for one more day. Today is your last day: at 23:59 Saudi time tonight it locks.`,
        `Nothing is deleted. Your data is kept until ${graceEnd}. If you buy by then, your company opens again exactly as you left it, and you can export your data at any time.`, buy(c)], c.appUrl, 'Open Nusuh Books');
      return plainMail('Your Nusuh Books trial has ended', [hello,
        `Your free trial for ${c.firm} ended on ${last}, so the software is locked. Nothing has been deleted: your data is kept until ${graceEnd}.`,
        `You can still sign in to export your data. If you buy by 23:59 Saudi time on ${graceEnd}, your company opens again exactly as you left it.`, buy(c)], c.appUrl, 'Open Nusuh Books');
    case 'grace_week': {
      return plainMail(`Your Nusuh Books data is kept until ${graceEnd}`, [hello,
        `Your free trial for ${c.firm} ended on ${last}. We are keeping your company and data until 23:59 Saudi time on ${graceEnd}. If you buy by then, you carry on as before.`,
        'If you decide not to buy, you do not need to do anything. You can export your data at any time while you can still sign in.', buy(c)], c.appUrl, 'Open Nusuh Books');
    }
    case 'closing_soon': {
      const exportUntil = fmtDay(addDays(n.graceEndsOn, LIFECYCLE.exportWindowDays)), deleteOn = fmtDay(addDays(n.graceEndsOn, LIFECYCLE.deleteAfterDays));
      return plainMail(`Your Nusuh Books company will be closed after ${graceEnd}`, [hello,
        `Unless you buy by 23:59 Saudi time on ${graceEnd}, your company ${c.firm} will be closed.`,
        `After it is closed you can still sign in to export your data until ${exportUntil}. Your data is deleted ${LIFECYCLE.deleteAfterDays} days after closing, from ${deleteOn}, and cannot be brought back after that.`,
        'If you buy before the company is deleted, it opens again with all your data.', buy(c)], c.appUrl, 'Open Nusuh Books');
    }
  }
}

export interface SendResult {
  enabled: boolean;
  sent: { firmId: string; template: NoticeKey; to: string; copied: boolean }[];
  skipped: { firmId: string; reason: string }[];
  failed: { firmId: string; error: string }[];
}

/**
 * The daily job's work, safe to run at any time and as often as you like: for each unpaid trial, queues the reminder that is
 * current if it has not been sent. One customer's failure never stops the others (each is its own savepoint, so a failed one is
 * tried again next run). `enabled` false (TRIAL_EMAILS is not "on") queues nothing at all.
 */
export async function sendTrialEmails(db: { query: Db['query'] }, now: Date, o: { enabled: boolean; appUrl: string; copyTo?: string; firmId?: string }): Promise<SendResult> {
  const out: SendResult = { enabled: o.enabled, sent: [], skipped: [], failed: [] };
  if (!o.enabled) return out;
  const prices = (await db.query('SELECT public_site_data() AS d')).rows[0].d as Price;
  const targets = (await db.query('SELECT * FROM trial_mail_targets()')).rows as (Parameters<typeof stateOf>[0] & { firm_id: string; firm_name: string; admin_name: string | null; admin_email: string | null; modules: string[] })[];
  for (const t of targets.filter((x) => !o.firmId || x.firm_id === o.firmId)) {
    const n = currentNotice(stateOf(t), now);
    if (!n) continue;
    if (!t.admin_email) { out.skipped.push({ firmId: t.firm_id, reason: 'no active Administrator to write to' }); continue; }
    await db.query('SAVEPOINT trial_mail');
    try {
      const log = (await db.query('SELECT trial_email_claim($1, $2, $3) AS id', [t.firm_id, n.key, t.admin_email])).rows[0].id as string | null;
      if (!log) { await db.query('RELEASE SAVEPOINT trial_mail'); continue; }   // already sent
      const mail = buildNotice(n, { name: t.admin_name ?? 'there', firm: t.firm_name, appUrl: o.appUrl, prices, modules: t.modules });
      const id = await queue(db, { firmId: t.firm_id, kind: 'trial', to: t.admin_email, toName: t.admin_name, replyTo: SUPPORT.email, mail });
      const copied = COPY_TO_OWNER.includes(n.key) && Boolean(o.copyTo);
      const copy = copied ? await queue(db, { firmId: t.firm_id, kind: 'trial', to: o.copyTo!, mail: { ...mail, subject: `Copy to Nusuh Books: ${mail.subject} (${t.firm_name})` } }) : null;
      await db.query('SELECT trial_email_attach($1, $2, $3)', [log, id, copy]);
      await db.query('RELEASE SAVEPOINT trial_mail');
      out.sent.push({ firmId: t.firm_id, template: n.key, to: t.admin_email, copied });
    } catch (e) {
      await db.query('ROLLBACK TO SAVEPOINT trial_mail');
      await db.query('RELEASE SAVEPOINT trial_mail');
      out.failed.push({ firmId: t.firm_id, error: (e as Error).message });
    }
  }
  return out;
}
