// Email texts. Each email carries English and Arabic, since the platform does not know the reader's language;
// the HTML version sets the Arabic part right to left. Plain words, no tracking.
export interface Mail { subject: string; text: string; html: string }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const linkify = (s: string) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
/** Builds the two-language email from English and Arabic paragraphs (the first is the greeting). */
export function bilingual(subject: string, en: string[], ar: string[], sender: string): Mail {
  const text = [...en, '', `— ${sender}`, '', '────────', '', ...ar, '', `— ${sender}`].join('\n');
  const para = (xs: string[]) => xs.map((x) => `<p style="margin:0 0 12px">${linkify(x).replace(/\n/g, '<br>')}</p>`).join('');
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#14213d;line-height:1.5;max-width:600px">
<div>${para(en)}<p style="color:#5b6b7b">— ${esc(sender)}</p></div>
<hr style="border:0;border-top:1px solid #d5dde5;margin:20px 0">
<div dir="rtl" lang="ar" style="text-align:right;font-family:Tahoma,Arial,sans-serif">${para(ar)}<p style="color:#5b6b7b">— ${esc(sender)}</p></div>
</body></html>`;
  return { subject, text, html };
}

export const invitation = (name: string, link: string, firm: string, reset = false): Mail => reset
  ? bilingual(`Reset your Nusuh Books password · إعادة تعيين كلمة المرور`,
    [`Hello ${name},`, 'Someone (we hope you) asked to reset your Nusuh Books password. Open this link within one hour to choose a new one:', link, 'If it was not you, ignore this email: your password stays as it is.'],
    [`مرحباً ${name}،`, 'طُلبت إعادة تعيين كلمة مرورك في نُصح. افتح هذا الرابط خلال ساعة لاختيار كلمة جديدة:', link, 'إن لم تطلب ذلك فتجاهل هذه الرسالة؛ تبقى كلمة مرورك كما هي.'], 'Nusuh Books')
  : bilingual(`You are invited to Nusuh Books · دعوة إلى نُصح`,
    [`Hello ${name},`, `${firm} has invited you to Nusuh Books. Open this link to choose your password and sign in (it works for 7 days):`, link],
    [`مرحباً ${name}،`, `دعتك ${firm} إلى نُصح. افتح هذا الرابط لاختيار كلمة المرور والدخول (صالح لسبعة أيام):`, link], firm);

export interface DocMailInput { kind: 'invoice' | 'credit_note' | 'quotation'; number: string; customer: string; company: string; total: string; currency: string;
  dueDate: string | null; amountDue: string; link: string; message?: string | null }
const KIND = { invoice: ['Invoice', 'فاتورة'], credit_note: ['Credit note', 'إشعار دائن'], quotation: ['Quotation', 'عرض سعر'] } as const;
export function documentMail(d: DocMailInput): Mail {
  const [en, ar] = KIND[d.kind];
  const due = d.kind === 'invoice' && d.dueDate ? [`Amount due ${d.currency} ${d.amountDue} by ${d.dueDate}.`] : [];
  const dueAr = d.kind === 'invoice' && d.dueDate ? [`المبلغ المستحق ${d.amountDue} ${d.currency} بتاريخ ${d.dueDate}.`] : [];
  return bilingual(`${en} ${d.number} from ${d.company} · ${ar} ${d.number}`,
    [`Dear ${d.customer},`, ...(d.message ? [d.message] : []), `Please find ${en.toLowerCase()} ${d.number} for ${d.currency} ${d.total}.`, ...due,
      `View, print or save it as PDF${d.kind === 'invoice' ? ', and pay online where offered' : ''}:`, d.link],
    [`السادة ${d.customer}،`, ...(d.message ? [d.message] : []), `مرفق ${ar} رقم ${d.number} بمبلغ ${d.total} ${d.currency}.`, ...dueAr,
      `للاطلاع والطباعة أو الحفظ PDF${d.kind === 'invoice' ? ' والدفع الإلكتروني إن كان متاحاً' : ''}:`, d.link], d.company);
}

export const approvalMail = (who: string, what: string, company: string, by: string, link: string): Mail =>
  bilingual(`Waiting for your approval: ${what} · بانتظار اعتمادك`,
    [`Hello ${who},`, `${by} sent ${what} at ${company} for approval.`, `Open Nusuh Books to approve or reject it: ${link}`],
    [`مرحباً ${who}،`, `أرسل ${by} ${what} في ${company} للاعتماد.`, `افتح نُصح للاعتماد أو الرفض: ${link}`], 'Nusuh Books');
