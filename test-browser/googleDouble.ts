// A stand-in for Google in the browser checks: the checks never contact Google. The server is given a key made for this run (globalSetup.ts)
// as "Google's key", the page's Google script is replaced by a tiny one that draws a button (route set in harness.ts), and a click on it
// asks this file to sign a token for the person the check names. The real server code checks that token exactly as it would Google's.
import { createSign } from 'node:crypto';

export const GOOGLE_CLIENT_ID = 'browser-checks-1234.apps.googleusercontent.com';
export const GOOGLE_KEY_ENV = 'BROWSER_TEST_GOOGLE_KEY';

export interface FakeGoogleUser { email: string; name?: string; sub?: string; verified?: boolean }

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
export function signFakeGoogleToken(nonce: string, who: FakeGoogleUser): string {
  const pem = process.env[GOOGLE_KEY_ENV];
  if (!pem) throw new Error('The browser checks did not set up the test Google key.');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: 'browser-key', typ: 'JWT' });
  const body = b64({ iss: 'https://accounts.google.com', aud: GOOGLE_CLIENT_ID, sub: who.sub ?? `sub-${who.email}`, email: who.email, email_verified: who.verified ?? true, name: who.name ?? 'Test Person', nonce, iat: now, exp: now + 3600 });
  return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(pem).toString('base64url')}`;
}

/** What the page's Google script becomes: the same two calls the real one has, and a button that answers with a token for window.__gwho. */
export const FAKE_GOOGLE_SCRIPT = `window.google = { accounts: { id: {
  initialize: function (o) { window.__gcfg = o; },
  renderButton: function (el) {
    el.innerHTML = '<button id="fake-google" type="button">Continue with Google (test)</button>';
    el.firstChild.onclick = async function () { window.__gcfg.callback({ credential: await window.__googleToken(window.__gcfg.nonce, window.__gwho || {}) }); };
  } } } };`;
