// How the server verifies a hosted database's certificate, proved against a stand-in server that presents a certificate
// signed by a PRIVATE authority, which is how Supabase's database certificates work: its documentation tells you to
// download its CA file (prod-ca-2021.crt) to verify them, so the operating system's trusted list does not contain it.
//
// The strict rule (a public host must present a certificate we can verify) is right, but alone it would refuse to
// connect to Supabase at all. So the CA can be supplied (DATABASE_CA_CERT, a public certificate, not a secret) and is
// then the ONLY authority trusted for that connection. These tests show both halves: with the CA the handshake
// completes, and without it the connection is refused rather than silently accepted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import pg from 'pg';
import { sslFor, caFrom, clientConfig, createPool } from '../src/db/session.js';
import { validateConfig } from '../src/config.js';

const URL_PUBLIC = 'postgres://nusuh_app.abcdef@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';
let dir: string, caPem: string, server: net.Server, port = 0, handshakes = 0;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dbtls-'));
  const run = (args: string[]) => execFileSync('openssl', args, { stdio: 'pipe' });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'ca.key'), '-out', path.join(dir, 'ca.crt'), '-subj', '/CN=Private Test CA', '-days', '2']);
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 's.key'), '-out', path.join(dir, 's.csr'), '-subj', '/CN=db']);
  writeFileSync(path.join(dir, 'ext.cnf'), 'subjectAltName=IP:127.0.0.1\n');
  run(['x509', '-req', '-in', path.join(dir, 's.csr'), '-CA', path.join(dir, 'ca.crt'), '-CAkey', path.join(dir, 'ca.key'), '-CAcreateserial', '-days', '2', '-extfile', path.join(dir, 'ext.cnf'), '-out', path.join(dir, 's.crt')]);
  caPem = readFileSync(path.join(dir, 'ca.crt'), 'utf8');
  const key = readFileSync(path.join(dir, 's.key')), cert = readFileSync(path.join(dir, 's.crt'));
  // A Postgres server for one purpose: answer the SSL request with "S", then complete a TLS handshake.
  server = net.createServer((socket) => {
    socket.once('data', (d) => {
      if (d.length === 8 && d.readInt32BE(4) === 80877103) {
        socket.write('S');
        const t = new tls.TLSSocket(socket, { isServer: true, key, cert });
        t.on('secure', () => { handshakes++; t.destroy(); });
        t.on('error', () => undefined);
      } else socket.destroy();
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const connect = (ssl: pg.ClientConfig['ssl']) =>
  new pg.Client({ host: '127.0.0.1', port, user: 'u', database: 'd', ssl, connectionTimeoutMillis: 4000 }).connect().then(() => 'connected', (e: Error) => e.message);

describe('a database whose certificate is signed by a private authority', () => {
  it('is refused when no authority is supplied: the strict rule is not silently relaxed', async () => {
    const before = handshakes;
    const out = await connect(sslFor(URL_PUBLIC));
    expect(out).toMatch(/self.signed|unable to verify|certificate/i);
    expect(handshakes).toBe(before);
  });

  it('completes the handshake when that authority\'s certificate is supplied, and trusts nothing else', async () => {
    const before = handshakes;
    const ssl = sslFor(URL_PUBLIC, caPem) as tls.ConnectionOptions;
    expect(ssl).toMatchObject({ rejectUnauthorized: true, ca: caPem });
    await connect(ssl);
    expect(handshakes).toBe(before + 1);
  });

  it('a different authority\'s certificate does not make it trusted', async () => {
    const other = path.join(dir, 'other.crt');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'o.key'), '-out', other, '-subj', '/CN=Another CA', '-days', '2'], { stdio: 'pipe' });
    const before = handshakes;
    expect(await connect(sslFor(URL_PUBLIC, readFileSync(other, 'utf8')))).toMatch(/self.signed|unable to verify|certificate/i);
    expect(handshakes).toBe(before);
  });
});

describe('sslFor with a supplied authority', () => {
  it('uses it only for hosts reached across the public internet', () => {
    expect(sslFor(URL_PUBLIC, caPem)).toMatchObject({ rejectUnauthorized: true, ca: caPem });
    expect(sslFor('postgres://u@dpg-abc123-a/db', caPem)).toEqual({ rejectUnauthorized: false });   // Render's private name
    expect(sslFor('postgres://u@localhost:5432/db', caPem)).toBeUndefined();
  });
  it('adds nothing when none is supplied', () => {
    expect(sslFor(URL_PUBLIC)).toEqual({ rejectUnauthorized: true });
  });
});

describe('caFrom: the authority as it arrives in a host setting', () => {
  it('accepts a certificate pasted with real line breaks, or with the two characters \\n between lines', () => {
    expect(caFrom(caPem)).toBe(caPem.trim());
    expect(caFrom(caPem.trim().replace(/\n/g, '\\n'))).toBe(caPem.trim());
  });
  it('treats an empty setting as not set', () => {
    expect(caFrom(undefined)).toBeUndefined();
    expect(caFrom('   ')).toBeUndefined();
  });
  it('refuses something that is not a certificate, rather than connecting with nothing to verify against', () => {
    expect(() => caFrom('not a certificate')).toThrow(/certificate/i);
    expect(() => caFrom('-----BEGIN CERTIFICATE-----\nbm90LXJlYWw=\n-----END CERTIFICATE-----')).toThrow(/certificate/i);
  });
});

describe('every connection the program opens uses the same rule', () => {
  it('clientConfig (migrations, demo data, the first owner) applies it, so Supabase works for them too', () => {
    expect(clientConfig(URL_PUBLIC, caPem).ssl).toMatchObject({ rejectUnauthorized: true, ca: caPem });
    expect(clientConfig('postgres://postgres:p@localhost:5432/nusuh').ssl).toBeUndefined();
    expect(clientConfig(URL_PUBLIC, caPem).connectionString).toBe(URL_PUBLIC);
  });
});

describe('the connection pool', () => {
  it('ends a stuck connect attempt, recycles idle connections and keeps them alive across a host\'s idle timeout', async () => {
    const pool = createPool('postgres://u:p@localhost:5432/d');
    const o = pool.options;
    expect(o.max).toBe(10);
    expect(o.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(o.idleTimeoutMillis).toBeGreaterThan(0);
    expect(o.keepAlive).toBe(true);
    await pool.end();
  });
  it('takes its size from the setting, within sensible bounds', async () => {
    const small = createPool('postgres://u:p@localhost:5432/d', { max: 4 }); expect(small.options.max).toBe(4); await small.end();
    const huge = createPool('postgres://u:p@localhost:5432/d', { max: 5000 }); expect(huge.options.max).toBeLessThanOrEqual(50); await huge.end();
    const zero = createPool('postgres://u:p@localhost:5432/d', { max: 0 }); expect(zero.options.max).toBeGreaterThanOrEqual(1); await zero.end();
  });
});

describe('validateConfig and the authority setting', () => {
  const ok = { NODE_ENV: 'production', DATABASE_URL: 'postgres://nusuh_app:x@host.example/db', SESSION_SECRET: 'a'.repeat(40), ENCRYPTION_KEY: 'b'.repeat(40), PUBLIC_URL: 'https://x.example' };
  it('stops a production start when DATABASE_CA_CERT is set but is not a certificate', () => {
    expect(validateConfig({ ...ok, DATABASE_CA_CERT: 'garbage' } as never).join(' ')).toMatch(/DATABASE_CA_CERT/);
  });
  it('accepts a real certificate and an unset one', () => {
    expect(validateConfig({ ...ok, DATABASE_CA_CERT: caPem } as never).join(' ')).not.toMatch(/DATABASE_CA_CERT/);
    expect(validateConfig({ ...ok } as never).join(' ')).not.toMatch(/DATABASE_CA_CERT/);
  });
});
