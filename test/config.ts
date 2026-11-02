// Test database settings. Override with TEST_PG_ADMIN_URL / TEST_DB_NAME.
export const PG_ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
export const TEST_DB = process.env.TEST_DB_NAME ?? 'nusuh_test';
export const APP_PASSWORD = 'nusuh-test-app';

function withDb(url: string, db: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

export const OWNER_URL = withDb(PG_ADMIN_URL, TEST_DB);
export const APP_URL = withDb(PG_ADMIN_URL, TEST_DB, 'nusuh_app', APP_PASSWORD);
