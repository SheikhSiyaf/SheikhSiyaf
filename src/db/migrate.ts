// Applies db/migrations/*.sql in name order, once each, as the owner role.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

export async function migrate(adminUrl: string, appPassword?: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminUrl });
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
      await client.query(`ALTER ROLE nusuh_app PASSWORD ${client.escapeLiteral(appPassword)}`);
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
