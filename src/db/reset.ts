// Development only: drops and recreates the database, applies migrations and loads demo data.
// (Posted entries can never be deleted, so a clean start means a new database.)
import pg from 'pg';
import { config } from '../config.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

if (process.env.NODE_ENV === 'production') {
  console.error('db:reset is for development only.');
  process.exit(1);
}
const target = new URL(config.databaseAdminUrl);
const dbName = target.pathname.slice(1);
const server = new URL(config.databaseAdminUrl);
server.pathname = '/postgres';

const c = new pg.Client({ connectionString: server.toString() });
await c.connect();
await c.query(`DROP DATABASE IF EXISTS ${c.escapeIdentifier(dbName)} WITH (FORCE)`);
await c.query(`CREATE DATABASE ${c.escapeIdentifier(dbName)}`);
await c.end();
await migrate(config.databaseAdminUrl, config.appDbPassword);
await seed(config.databaseAdminUrl);
console.log(`Database "${dbName}" recreated with demo data.`);
