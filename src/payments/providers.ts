// Payment providers for online payment of invoices. Each one makes a hosted checkout for an amount and says, when
// asked, whether it was paid. Nothing is trusted from the browser or a webhook body: the server always asks the
// provider itself before a payment is recorded.
//
//  sandbox  built in, for trying it out: a checkout page in Nusuh Books with Pay and Decline buttons. No money moves.
//  moyasar  Moyasar (Saudi Arabia: mada, Visa, Mastercard, Apple Pay) through its Invoices API with the company's
//           secret key. Confirm the API details and settlement with Moyasar before going live.
import { randomBytes } from 'node:crypto';

export type Fetch = typeof fetch;
export interface Checkout { ref: string; url: string }
export interface Check { status: 'paid' | 'failed' | 'pending'; amountMinor: bigint; currency: string; detail?: string }
export interface CheckoutInput { id: string; amountMinor: bigint; currency: string; description: string; returnUrl: string; webhookUrl: string; base: string }
export interface Provider {
  create(x: CheckoutInput, secret: string, f: Fetch): Promise<Checkout>;
  check(ref: string, secret: string, f: Fetch): Promise<Check>;
}

// ------------------------------------------------------------------ sandbox
/** Sandbox checkouts live in the server's memory: what was asked for and what the tester chose. */
const sandbox = new Map<string, { amountMinor: bigint; currency: string; outcome: 'paid' | 'failed' | null; returnUrl: string }>();
export const sandboxCheckout = (ref: string) => sandbox.get(ref) ?? null;
export function sandboxDecide(ref: string, outcome: 'paid' | 'failed') {
  const s = sandbox.get(ref);
  if (!s || s.outcome) return null;
  s.outcome = outcome;
  return s;
}
const sandboxProvider: Provider = {
  async create(x) {
    const ref = `sbx_${randomBytes(12).toString('hex')}`;
    sandbox.set(ref, { amountMinor: x.amountMinor, currency: x.currency, outcome: null, returnUrl: x.returnUrl });
    return { ref, url: `${x.base}/pay/sandbox/${ref}` };
  },
  async check(ref) {
    const s = sandbox.get(ref);
    if (!s) return { status: 'failed', amountMinor: 0n, currency: '', detail: 'Sandbox checkout not found (the server restarted).' };
    return { status: s.outcome ?? 'pending', amountMinor: s.amountMinor, currency: s.currency };
  },
};

// ------------------------------------------------------------------ Moyasar
const MOYASAR = 'https://api.moyasar.com/v1';
const basic = (secret: string) => `Basic ${Buffer.from(`${secret}:`).toString('base64')}`;
const moyasarProvider: Provider = {
  async create(x, secret, f) {
    const r = await f(`${MOYASAR}/invoices`, { method: 'POST', headers: { authorization: basic(secret), 'content-type': 'application/json' },
      body: JSON.stringify({ amount: Number(x.amountMinor), currency: x.currency, description: x.description.slice(0, 250), success_url: x.returnUrl, back_url: x.returnUrl,
        callback_url: x.webhookUrl, metadata: { online_payment_id: x.id } }) });
    const j = await r.json().catch(() => ({})) as { id?: string; url?: string; message?: string };
    if (!r.ok || !j.id || !j.url) throw new Error(`Moyasar: ${j.message ?? r.status}`);
    return { ref: j.id, url: j.url };
  },
  async check(ref, secret, f) {
    const r = await f(`${MOYASAR}/invoices/${encodeURIComponent(ref)}`, { headers: { authorization: basic(secret) } });
    const j = await r.json().catch(() => ({})) as { status?: string; amount?: number; currency?: string; message?: string };
    if (!r.ok) throw new Error(`Moyasar: ${j.message ?? r.status}`);
    const status = j.status === 'paid' ? 'paid' : ['failed', 'expired', 'canceled', 'void'].includes(String(j.status)) ? 'failed' : 'pending';
    return { status, amountMinor: BigInt(j.amount ?? 0), currency: String(j.currency ?? '').toUpperCase(), detail: j.status };
  },
};

export const PROVIDERS: Record<string, Provider> = { sandbox: sandboxProvider, moyasar: moyasarProvider };
export const PROVIDER_NAMES = Object.keys(PROVIDERS);
