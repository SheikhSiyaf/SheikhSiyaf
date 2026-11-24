// Tests the PHP form handler against a fake Resend server (no real e-mail is ever sent).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasPhp = spawnSync('php', ['-v']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-forms-'));
const sent = path.join(tmp, 'sent.jsonl');
const PORT = 18500 + Math.floor(Math.random() * 400), FAKE = PORT + 1000;
let app, fake, appNoKey;

const fakeRouter = path.join(tmp, 'fake-resend.php');
fs.writeFileSync(fakeRouter, `<?php
$body = file_get_contents('php://input');
file_put_contents(${JSON.stringify(sent)}, json_encode(['auth' => $_SERVER['HTTP_AUTHORIZATION'] ?? '', 'body' => json_decode($body, true)]) . "\\n", FILE_APPEND);
header('Content-Type: application/json'); echo '{"id":"fake"}';`);

// the handler is served from a private copy of dist/api, so a rebuild during the run cannot disturb it
const SITE = path.join(tmp, 'site');
const start = (port, router, env, docroot) => spawn('php', ['-S', `127.0.0.1:${port}`, ...(router ? [router] : []), '-t', docroot ?? SITE], { env: { ...process.env, ...env }, stdio: 'ignore' });
const wait = async (port) => { for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/`); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); };

before(async () => {
  if (!hasPhp) return;
  fs.cpSync(path.join(ROOT, 'dist', 'api'), path.join(SITE, 'api'), { recursive: true });
  fake = start(FAKE, fakeRouter, {}, tmp);
  app = start(PORT, null, { RESEND_API_KEY: 'test-key', MAIL_FROM: 'Site <site@example.test>', RESEND_API_URL: `http://127.0.0.1:${FAKE}/emails`, RATE_DIR: path.join(tmp, 'rate') });
  appNoKey = start(PORT + 2000, null, { RESEND_API_KEY: '', MAIL_FROM: '', RATE_DIR: path.join(tmp, 'rate2') });
  await Promise.all([wait(FAKE), wait(PORT), wait(PORT + 2000)]);
});
after(() => { for (const p of [app, fake, appNoKey]) p?.kill(); });

const sentMails = () => (fs.existsSync(sent) ? fs.readFileSync(sent, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const post = async (fields, { port = PORT, ip = '10.0.0.' + Math.floor(Math.random() * 250), headers = {}, files = {} } = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [k, v] of Object.entries(files)) fd.append(k, v.blob, v.name);
  const r = await fetch(`http://127.0.0.1:${port}/api/submit.php`, { method: 'POST', body: fd, headers: { 'X-Forwarded-For': ip, ...headers } });
  return { status: r.status, body: await r.json() };
};
const skip = { skip: !hasPhp && 'php is not installed' };

test('contact: a valid message is e-mailed to hello@ with the visitor as reply-to', skip, async () => {
  const n = sentMails().length;
  const r = await post({ type: 'contact', name: 'Test Person', email: 'test.person@example.com', message: 'Hello, I would like to know more.' });
  assert.deepEqual(r.body, { ok: true });
  const m = sentMails().at(-1);
  assert.equal(sentMails().length, n + 1);
  assert.equal(m.auth, 'Bearer test-key');
  assert.deepEqual(m.body.to, ['hello@nusuhbooks.com']);
  assert.equal(m.body.reply_to, 'test.person@example.com');
  assert.equal(m.body.from, 'Site <site@example.test>');
  assert.match(m.body.subject, /^Website message - Test Person$/);
  assert.match(m.body.text, /Hello, I would like to know more\./);
});

test('every form checks its fields on the server', skip, async () => {
  const n = sentMails().length;
  assert.equal((await post({ type: 'contact', name: 'A', email: 'not-an-email', message: 'hello there' })).body.field, 'email');
  assert.equal((await post({ type: 'contact', name: '', email: 'a@b.co', message: 'hello there' })).body.field, 'name');
  assert.equal((await post({ type: 'contact', name: 'A', email: 'a@b.co', message: 'x' })).body.field, 'message');
  assert.equal((await post({ type: 'demo', name: 'A', email: 'a@b.co', company: '' })).body.field, 'company');
  assert.equal((await post({ type: 'payment', company: 'C', email: 'a@b.co', invoice: '1', amount: 'lots', date: '2026-11-01' })).body.field, 'amount');
  assert.equal((await post({ type: 'payment', company: 'C', email: 'a@b.co', invoice: '1', amount: '100', date: '2026-02-31' })).body.field, 'date');
  assert.equal((await post({ type: 'nonsense', email: 'a@b.co' })).status, 422);
  assert.equal(sentMails().length, n, 'nothing may be sent for invalid input');
});

test('demo and payment confirmations carry every field; a receipt is attached', skip, async () => {
  let r = await post({ type: 'demo', name: 'Sara', email: 'sara@example.com', company: 'Hotel, hospitality', teamSize: '12' });
  assert.equal(r.body.ok, true);
  let m = sentMails().at(-1);
  assert.match(m.body.text, /Company and industry: Hotel, hospitality/);
  assert.match(m.body.text, /Team size: 12/);
  const pdf = new Blob(['%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'], { type: 'application/pdf' });
  r = await post({ type: 'payment', company: 'Gulf Steel', email: 'ap@example.com', invoice: 'INV-1001', amount: '10,500.00', date: '2026-11-20', reference: 'Bank X ref 77' }, { files: { receipt: { blob: pdf, name: 'x.pdf' } } });
  assert.equal(r.body.ok, true);
  m = sentMails().at(-1);
  assert.equal(m.body.attachments.length, 1);
  assert.match(m.body.attachments[0].filename, /^transfer-receipt\.pdf$/);
  assert.match(Buffer.from(m.body.attachments[0].content, 'base64').toString(), /^%PDF/);
  assert.match(m.body.text, /Invoice number: INV-1001/);
  const exe = new Blob(['MZ not a receipt'], { type: 'application/pdf' });
  r = await post({ type: 'payment', company: 'C', email: 'a@b.co', invoice: '1', amount: '100', date: '2026-11-01' }, { files: { receipt: { blob: exe, name: 'evil.pdf' } } });
  assert.equal(r.body.field, 'receipt');
});

test('order: totals are recomputed on the server from the price list, never taken from the browser', skip, async () => {
  const pricing = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/pricing.json'), 'utf8'));
  const r = await post({ type: 'order', company: 'Test Co', email: 'buyer@example.com', modules: 'Inventory,Rooms', cleanup: '1', total: '1', oneTimeTotal: '1' });
  assert.equal(r.body.ok, true);
  const t = sentMails().at(-1).body.text;
  const f = (n) => `SAR ${n.toLocaleString('en-US')}`;
  assert.ok(t.includes(`One-time total: ${f(pricing.implementation + pricing.cleanup)}`), t);
  assert.ok(t.includes(`Yearly total: ${f(pricing.annualCore + 2 * pricing.perModule)}`), t);
  assert.match(t, /Extra module, Inventory/); assert.match(t, /Extra module, Rooms and front desk/);
  assert.match(t, /All prices exclude VAT/);
  const bad = await post({ type: 'order', company: 'Test Co', email: 'buyer@example.com', modules: 'Inventory,Hacking' });
  assert.equal(bad.body.field, 'modules');
});

test('spam: honeypot and link-stuffed messages are dropped quietly, nothing is sent', skip, async () => {
  const n = sentMails().length;
  assert.deepEqual((await post({ type: 'contact', name: 'Bot', email: 'bot@example.com', message: 'buy now', website: 'http://spam' })).body, { ok: true });
  assert.deepEqual((await post({ type: 'contact', name: 'Bot', email: 'bot@example.com', message: 'http://a.example http://b.example http://c.example' })).body, { ok: true });
  assert.equal(sentMails().length, n);
});

test('rate limit: the sixth message in ten minutes from one visitor is refused', skip, async () => {
  const ip = '203.0.113.9';
  const ok = [];
  for (let i = 0; i < 5; i++) ok.push((await post({ type: 'contact', name: 'R', email: 'r@example.com', message: 'message ' + i }, { ip })).status);
  assert.deepEqual(ok, [200, 200, 200, 200, 200]);
  assert.equal((await post({ type: 'contact', name: 'R', email: 'r@example.com', message: 'one too many' }, { ip })).status, 429);
});

test('only POST from this site is accepted; no key means a clear refusal and no send', skip, async () => {
  const g = await fetch(`http://127.0.0.1:${PORT}/api/submit.php`);
  assert.equal(g.status, 405);
  const x = await post({ type: 'contact', name: 'A', email: 'a@b.co', message: 'hello there' }, { headers: { Origin: 'https://evil.example' } });
  assert.equal(x.status, 403);
  const n = sentMails().length;
  const nk = await post({ type: 'contact', name: 'A', email: 'a@b.co', message: 'hello there' }, { port: PORT + 2000 });
  assert.equal(nk.status, 503);
  assert.deepEqual(nk.body, { ok: false, error: 'not_configured' });
  assert.equal(sentMails().length, n);
});
