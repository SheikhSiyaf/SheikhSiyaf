// Sending one email through the provider chosen in EMAIL_PROVIDER (HTTPS APIs, no extra packages):
//   resend (RESEND_API_KEY), sendgrid (SENDGRID_API_KEY), postmark (POSTMARK_TOKEN), log (writes to the server log and
//   counts as sent: for development), none (default: emails wait in the outbox until a provider is set).
// EMAIL_FROM is the sender, e.g. "Nusuh Books <no-reply@books.example.com>".
export interface OutgoingEmail { to: string; toName?: string | null; replyTo?: string | null; subject: string; text: string; html?: string | null;
  attachments?: { fileName: string; contentType: string; base64: string }[] }
export type SendResult = { ok: true; providerId: string | null } | { ok: false; hold: boolean; error: string };
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface EmailConfig { provider: string; from: string; key?: string }
export const emailConfig = (env = process.env): EmailConfig => ({
  provider: (env.EMAIL_PROVIDER ?? 'none').toLowerCase(),
  from: env.EMAIL_FROM ?? 'Nusuh Books <no-reply@nusuhbooks.example>',
  key: env.RESEND_API_KEY ?? env.SENDGRID_API_KEY ?? env.POSTMARK_TOKEN,
});

const addr = (from: string) => { const m = /^(.*)<([^>]+)>\s*$/.exec(from); return m ? { name: m[1]!.trim().replace(/^"|"$/g, ''), email: m[2]!.trim() } : { name: '', email: from.trim() }; };

export async function sendEmail(e: OutgoingEmail, cfg: EmailConfig = emailConfig(), fetchFn: Fetch = fetch as unknown as Fetch): Promise<SendResult> {
  const att = e.attachments ?? [];
  let url: string, headers: Record<string, string>, body: unknown;
  switch (cfg.provider) {
    case 'none': return { ok: false, hold: true, error: 'No email provider is set up yet (EMAIL_PROVIDER).' };
    case 'log':
      console.log(`[email] to ${e.to}: ${e.subject} (${att.length} attachment(s))`);
      return { ok: true, providerId: 'log' };
    case 'resend':
      url = 'https://api.resend.com/emails';
      headers = { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' };
      body = { from: cfg.from, to: [e.toName ? `${e.toName} <${e.to}>` : e.to], subject: e.subject, text: e.text, html: e.html ?? undefined, reply_to: e.replyTo ?? undefined,
        attachments: att.map((a) => ({ filename: a.fileName, content: a.base64, content_type: a.contentType })) };
      break;
    case 'sendgrid': {
      const f = addr(cfg.from);
      url = 'https://api.sendgrid.com/v3/mail/send';
      headers = { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' };
      body = { personalizations: [{ to: [{ email: e.to, name: e.toName ?? undefined }] }], from: { email: f.email, name: f.name || undefined },
        reply_to: e.replyTo ? { email: e.replyTo } : undefined, subject: e.subject,
        content: [{ type: 'text/plain', value: e.text }, ...(e.html ? [{ type: 'text/html', value: e.html }] : [])],
        attachments: att.length ? att.map((a) => ({ filename: a.fileName, content: a.base64, type: a.contentType })) : undefined };
      break;
    }
    case 'postmark':
      url = 'https://api.postmarkapp.com/email';
      headers = { 'x-postmark-server-token': String(cfg.key), 'content-type': 'application/json', accept: 'application/json' };
      body = { From: cfg.from, To: e.to, ReplyTo: e.replyTo ?? undefined, Subject: e.subject, TextBody: e.text, HtmlBody: e.html ?? undefined,
        Attachments: att.map((a) => ({ Name: a.fileName, Content: a.base64, ContentType: a.contentType })) };
      break;
    default: return { ok: false, hold: true, error: `Unknown email provider "${cfg.provider}".` };
  }
  if (!cfg.key) return { ok: false, hold: true, error: `The ${cfg.provider} key is not set.` };
  try {
    const r = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) return { ok: false, hold: false, error: `${cfg.provider} answered ${r.status}: ${text.slice(0, 300)}` };
    let id: string | null = null;
    try { const j = JSON.parse(text) as { id?: string; MessageID?: string }; id = j.id ?? j.MessageID ?? null; } catch { /* sendgrid answers with no body */ }
    return { ok: true, providerId: id };
  } catch (err) { return { ok: false, hold: false, error: (err as Error).message || 'The email provider could not be reached.' }; }
}
