// A real installation (no demo data): after `npm run db:migrate`, creates the platform owner's account and prints a
// one-time link to choose a password. The owner then adds the first customer and its company in the owner console.
// See README "Starting a real installation".
//   npm run db:install -- --name "Full Name" --email owner@yourdomain.com
// It refuses a database that has the demo data in it, and never sets or prints a password.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { clientConfig } from './ssl.js';
import { config } from '../config.js';
import { hashInviteToken } from '../api/auth.js';
import { DEMO_FIRM } from './demoData.js';

export const OWNER_INVITE_DAYS = 3;
export interface InstallResult { status: 'created' | 'new_link'; link: string; userId: string }

export async function createOwner(adminUrl: string, o: { name: string; email: string; publicUrl: string }): Promise<InstallResult> {
  const name = o.name.trim(), email = o.email.trim().toLowerCase();
  if (!name) throw new Error('Give the owner\'s full name with --name.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Give the owner\'s email address with --email.');
  if (!/^https?:\/\/[^\s/]+/i.test(o.publicUrl)) throw new Error('Set PUBLIC_URL (the https:// address of the site) first: the link is built from it.');
  const c = new pg.Client(clientConfig(adminUrl, config.databaseCa));
  await c.connect();
  try {
    if (!(await c.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'users'`)).rowCount) throw new Error('Run `npm run db:migrate` first.');
    if ((await c.query('SELECT 1 FROM firms WHERE name = $1', [DEMO_FIRM])).rowCount) {
      throw new Error('This database has the demo data in it. A real installation starts from a new, empty database.');
    }
    const token = randomBytes(32).toString('base64url');
    await c.query('BEGIN');
    const existing = (await c.query(`SELECT id, email, password_hash IS NOT NULL AS ready FROM users WHERE kind = 'owner' ORDER BY created_at`)).rows;
    let userId: string, status: InstallResult['status'];
    if (existing.length) {
      const same = existing.find((u) => u.email.toLowerCase() === email);
      if (!same) throw new Error(`An owner account already exists (${existing[0].email}). Add more people from the owner console.`);
      if (same.ready) throw new Error('This owner has already chosen a password. Use "Forgot password" on the sign-in page if needed.');
      userId = same.id; status = 'new_link';
    } else {
      const platform = (await c.query(`SELECT id FROM firms WHERE kind = 'platform'`)).rows[0]?.id;
      if (!platform) throw new Error('The platform is missing: run `npm run db:migrate` on this database.');
      userId = (await c.query(`INSERT INTO users (firm_id, kind, full_name, email) VALUES ($1, 'owner', $2, $3) RETURNING id`, [platform, name, email])).rows[0].id;
      status = 'created';
    }
    await c.query(`UPDATE users SET invite_token_hash = $2, invite_expires_at = now() + make_interval(days => $3) WHERE id = $1`, [userId, hashInviteToken(token), OWNER_INVITE_DAYS]);
    await c.query('COMMIT');
    return { status, userId, link: `${o.publicUrl.replace(/\/+$/, '')}/invite/${token}` };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

/** The owner's name and email from --name / --email, or else from OWNER_NAME / OWNER_EMAIL. The settings let a host that
 *  has no shell (Render's free plan) create the owner during its build, where only environment settings can be given. */
export function ownerFrom(argv: string[], env: Record<string, string | undefined>): { name: string; email: string } {
  const arg = (k: string) => { const i = argv.indexOf(`--${k}`); return i > 0 ? argv[i + 1] ?? '' : ''; };
  return { name: arg('name') || env.OWNER_NAME || '', email: arg('email') || env.OWNER_EMAIL || '' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  createOwner(config.databaseAdminUrl, { ...ownerFrom(process.argv, process.env), publicUrl: config.publicUrl })
    .then((r) => console.log(`${r.status === 'created' ? 'Owner account created.' : 'New link for the owner.'} Open this link within ${OWNER_INVITE_DAYS} days to choose a password (it works once; do not share it):\n\n  ${r.link}\n\nThen sign in, open the owner console and add the first customer and its company.`))
    .catch((e) => { console.error((e as Error).message); process.exit(1); });
}
