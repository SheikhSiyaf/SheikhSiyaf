// Starts the API, and serves the built web app from web/dist when it exists.
import { existsSync } from 'node:fs';
import { config, validateConfig } from '../config.js';
import { createPool } from '../db/session.js';
import { buildServer, WEB_DIST } from './server.js';
import { startFxJobs } from '../books/fxJobs.js';
import { startMailer } from '../email/mailer.js';
import { startToolJobs } from '../books/toolsJobs.js';
import { startBillingJob } from '../books/billingService.js';
import { startBankFeedJob } from '../books/bankFeedService.js';
import { startAuthPurgeJob } from '../auth/throttle.js';
import { startEInvoiceSender } from '../books/einvoiceSender.js';

// Unsafe settings stop the server in production; elsewhere they are warnings (src/config.ts validateConfig).
const problems = validateConfig(process.env);
if (problems.length) {
  const list = problems.map((p) => `  - ${p}`).join('\n');
  if (config.production) {
    console.error(`Nusuh Books will not start in production until these are fixed:\n${list}\n`);
    process.exit(1);
  }
  console.warn(`Settings that must be fixed before production (NODE_ENV=production refuses to start with them):\n${list}\n`);
}
const apiOnly = process.argv.includes('--api-only') || process.env.SERVE_WEB === 'false';
const serveWeb = !apiOnly && existsSync(WEB_DIST);
const pool = createPool(config.databaseUrl);
// The server connects as nusuh_app, which row-level security applies to: never as a superuser or a role that bypasses it.
{
  const r = (await pool.query(`SELECT current_user AS u, rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname = current_user`)).rows[0];
  if (r.s || r.b) {
    const msg = `DATABASE_URL connects as "${r.u}", a superuser or a role that bypasses row-level security.`;
    if (config.production) { console.error(`Nusuh Books will not start in production: ${msg}`); process.exit(1); }
    console.warn(`${msg} Use nusuh_app before production.`);
  }
}
const app = buildServer({
  pool,
  sessionSecret: config.sessionSecret,
  // No fallback to SESSION_SECRET in production (validateConfig has refused to start without ENCRYPTION_KEY there).
  encryptionKey: config.production ? config.encryptionKey : config.encryptionKey || config.sessionSecret,
  production: config.production,
  publicUrl: config.publicUrl,
  cookieSecure: config.cookieSecure,
  demoLogins: config.demoLogins,
  trustProxy: config.trustProxy,
  staticDir: serveWeb ? WEB_DIST : undefined,
  logger: true,
});

await app.listen({ port: config.port, host: config.host });
// Daily exchange rates and the automatic month-end revaluation (FX_JOBS=off turns them off; FX_RATES_URL sets the provider).
startFxJobs(pool, (m) => app.log.info(m));
// Sending queued emails every minute (EMAIL_PROVIDER chooses the provider; EMAIL_JOBS=off turns it off).
startMailer(pool, (m) => app.log.info(m));
// Recurring sales invoices and automatic payment reminders, hourly (TOOL_JOBS=off turns them off).
startToolJobs(pool, (m) => app.log.info(m));
// Billing the platform's customers for their subscriptions, every six hours (BILLING_JOBS=off turns it off).
startBillingJob(pool, (m) => app.log.info(m));
// Direct bank feeds, synced every six hours (BANK_FEED_JOBS=off turns it off).
startBankFeedJob(pool, (m) => app.log.info(m));
// Simplified e-invoices reported to ZATCA every 2 minutes, with retries and warnings (EINVOICE_JOBS=off turns it off).
startEInvoiceSender(pool, config.publicUrl ?? '', (m) => app.log.info(m));
// Sign-in attempts older than 24 hours are deleted every hour.
startAuthPurgeJob(pool, (m) => app.log.info(m));
console.log(serveWeb
  ? `\n  Nusuh Books is running: open http://localhost:${config.port}\n`
  : apiOnly
    ? `\n  API running on port ${config.port}. Open the app at http://localhost:5173\n`
    : `\n  API running on http://localhost:${config.port}, but the web app is not built yet: run "npm run build" first.\n`);
