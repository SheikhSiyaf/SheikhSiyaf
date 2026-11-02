// Creates a fresh test database and applies all migrations before the test run.
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { PG_ADMIN_URL, TEST_DB, OWNER_URL, APP_PASSWORD } from './config.js';

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(TEST_DB)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(TEST_DB)}`);
  } finally {
    await admin.end();
  }
  await migrate(OWNER_URL, APP_PASSWORD);
}
