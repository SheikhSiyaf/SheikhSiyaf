// Starts the API, and serves the built web app from web/dist when it exists.
import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { createPool } from '../db/session.js';
import { buildServer, WEB_DIST } from './server.js';
import { startFxJobs } from '../books/fxJobs.js';

if (!process.env.ENCRYPTION_KEY) {
  console.warn('ENCRYPTION_KEY is not set: two-factor secrets are encrypted with SESSION_SECRET. Set ENCRYPTION_KEY before real use.');
}
if (!config.sessionSecretFromEnv) {
  console.warn('SESSION_SECRET is not set: using a random one, so everyone is signed out when the server restarts.');
}
const apiOnly = process.argv.includes('--api-only') || process.env.SERVE_WEB === 'false';
const serveWeb = !apiOnly && existsSync(WEB_DIST);
const pool = createPool(config.databaseUrl);
const app = buildServer({
  pool,
  sessionSecret: config.sessionSecret,
  encryptionKey: config.encryptionKey || config.sessionSecret,
  publicUrl: config.publicUrl,
  cookieSecure: config.cookieSecure,
  demoLogins: config.demoLogins,
  staticDir: serveWeb ? WEB_DIST : undefined,
  logger: true,
});

await app.listen({ port: config.port, host: config.host });
// Daily exchange rates and the automatic month-end revaluation (FX_JOBS=off turns them off; FX_RATES_URL sets the provider).
startFxJobs(pool, (m) => app.log.info(m));
console.log(serveWeb
  ? `\n  Nusuh Books is running: open http://localhost:${config.port}\n`
  : apiOnly
    ? `\n  API running on port ${config.port}. Open the app at http://localhost:5173\n`
    : `\n  API running on http://localhost:${config.port}, but the web app is not built yet: run "npm run build" first.\n`);
