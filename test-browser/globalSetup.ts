// Starts everything the browser checks need: a fresh database with every migration and the demo data, and the real
// server serving the built web app. Dropped again at the end. The server is built in this process rather than
// started as a child, so there is nothing to wait for and nothing left running if a check fails.
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { buildServer, WEB_DIST } from '../src/api/server.js';
import { createPool } from '../src/db/session.js';
import { existsSync } from 'node:fs';

const ADMIN = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const DB = process.env.BROWSER_TEST_DB ?? 'nusuh_browser_test';
const PORT = Number(process.env.BROWSER_TEST_PORT ?? 3177);
const APP_PASSWORD = 'nusuh-browser-test';
const url = (user?: string, password?: string) => {
  const u = new URL(ADMIN);
  u.pathname = `/${DB}`;
  if (user) { u.username = user; u.password = password ?? ''; }
  return u.toString();
};

export default async function setup(): Promise<() => Promise<void>> {
  if (!existsSync(WEB_DIST)) {
    throw new Error(`The web app is not built: ${WEB_DIST} is missing. Run "npm run build" first (npm run test:browser does).`);
  }
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(DB)} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(DB)}`);
  await admin.end();

  await migrate(url(), APP_PASSWORD);
  await seed(url());

  const pool = createPool(url('nusuh_app', APP_PASSWORD));
  const server = buildServer({
    pool,
    sessionSecret: 'browser-checks-session-secret-0123456789abcdef',
    // No encryptionKey on purpose: the demo seed encrypted its ZATCA device key with the development default, so the
    // server has to read it with the same one. Passing a different key here made issuing an invoice fail with
    // "encrypted with a different ENCRYPTION_KEY", which is the right error and the wrong setup.
    production: false,
    publicUrl: `http://127.0.0.1:${PORT}`,
    cookieSecure: false,
    demoLogins: true,
    staticDir: WEB_DIST,
  });
  await server.listen({ port: PORT, host: '127.0.0.1' });

  return async () => {
    await server.close();
    await pool.end();
    const a = new pg.Client({ connectionString: ADMIN });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${a.escapeIdentifier(DB)} WITH (FORCE)`);
    await a.end();
  };
}
