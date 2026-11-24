// When the site moves to its own domain, the old Render address (*.onrender.com) sends people on to the new one.
// It is off until switched on (REDIRECT_OLD_ADDRESS=on), only moves page loads (GET), and never moves /health.
import { describe, it, expect, afterAll } from 'vitest';
import Fastify from 'fastify';
import { app as appPool } from './helpers.js';
import { registerHardening } from '../src/api/hardening.js';

async function make(over: { redirectOldAddress?: boolean; publicUrl?: string }) {
  const f = Fastify();
  registerHardening(f, { pool: appPool, https: true, publicUrl: over.publicUrl ?? 'https://app.example.com', redirectOldAddress: over.redirectOldAddress });
  f.get('/page', async () => 'page');
  f.post('/api/thing', async () => 'posted');
  await f.ready();
  return f;
}
const open: { close: () => Promise<unknown> }[] = [];
afterAll(async () => { for (const f of open) await f.close(); });

describe('old Render address', () => {
  it('sends page loads on to the new address, keeping the path and query', async () => {
    const f = await make({ redirectOldAddress: true }); open.push(f);
    const r = await f.inject({ method: 'GET', url: '/page?x=1', headers: { host: 'nusuh-books.onrender.com' } });
    expect(r.statusCode).toBe(308);
    expect(r.headers.location).toBe('https://app.example.com/page?x=1');
  });
  it('does nothing when switched off', async () => {
    const f = await make({ redirectOldAddress: false }); open.push(f);
    expect((await f.inject({ method: 'GET', url: '/page', headers: { host: 'nusuh-books.onrender.com' } })).statusCode).toBe(200);
  });
  it('leaves the new address, /health and changing requests alone', async () => {
    const f = await make({ redirectOldAddress: true }); open.push(f);
    expect((await f.inject({ method: 'GET', url: '/page', headers: { host: 'app.example.com' } })).statusCode).toBe(200);
    expect((await f.inject({ method: 'GET', url: '/health', headers: { host: 'nusuh-books.onrender.com' } })).statusCode).not.toBe(308);
    expect((await f.inject({ method: 'POST', url: '/api/thing', headers: { host: 'nusuh-books.onrender.com' } })).statusCode).toBe(200);
  });
  it('never redirects to another old Render address (nothing to move to)', async () => {
    const f = await make({ redirectOldAddress: true, publicUrl: 'https://nusuh-books.onrender.com' }); open.push(f);
    expect((await f.inject({ method: 'GET', url: '/page', headers: { host: 'nusuh-books.onrender.com' } })).statusCode).toBe(200);
  });
});
