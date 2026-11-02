// Reads settings from the environment, loading .env from the project folder if there is one.
import { randomBytes } from 'node:crypto';

try {
  process.loadEnvFile();
} catch {
  // no .env file: use the real environment
}

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '127.0.0.1',
  databaseUrl: env.DATABASE_URL ?? 'postgres://nusuh_app:change-me@localhost:5432/nusuh',
  databaseAdminUrl: env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/nusuh',
  appDbPassword: env.APP_DB_PASSWORD,
  sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
  sessionSecretFromEnv: Boolean(env.SESSION_SECRET),
  cookieSecure: env.COOKIE_SECURE === 'true',
  /** Show the demo sign-in buttons on the sign-in page. Never turn on for real client data. */
  demoLogins: env.DEMO_LOGINS === 'true',
};
