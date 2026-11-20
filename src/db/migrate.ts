// Applies db/migrations/*.sql in name order, once each, as the owner role.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { clientConfig } from './ssl.js';
import { config } from '../config.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

export async function migrate(adminUrl: string, appPassword?: string): Promise<string[]> {
  const client = new pg.Client(clientConfig(adminUrl, config.databaseCa));
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    if (appPassword) {
      try {
        await client.query(`ALTER ROLE nusuh_app PASSWORD ${client.escapeLiteral(appPassword)}`);
      } catch (err) {
        // PostgreSQL 16 onwards, a connection that is not a superuser may set another role's password only if it
        // holds ADMIN OPTION on that role, which it gets automatically for a role it created itself. On a managed
        // host such as Supabase the administrator connection is NOT a superuser, so if nusuh_app was created by
        // some other role — a hand-run script, an earlier setup, a restored backup — this fails with a permission
        // error that says nothing about what to do. Say it here instead of leaving an operator guessing.
        const e = err as { code?: string; message: string };
        if (e.code === '42501') {
          throw new Error(
            'The database role nusuh_app exists but this connection may not set its password: on PostgreSQL 16 and '
            + 'later that needs ADMIN OPTION on the role, which only a superuser or the role\'s creator has. '
            + 'Run this once as the database owner (on Supabase, in the SQL editor): '
            + 'GRANT nusuh_app TO CURRENT_USER WITH ADMIN OPTION;  — then run the migration again. '
            + `The database said: ${e.message}`);
        }
        throw err;
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { config } = await import('../config.js');   // loads .env
  migrate(config.databaseAdminUrl, config.appDbPassword)
    .then((applied) => console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Up to date.'))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
