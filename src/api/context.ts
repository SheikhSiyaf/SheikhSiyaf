// Shared request helpers for the route modules.
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';

export interface ServerOptions {
  pool: pg.Pool;
  sessionSecret: string;
  /** Encrypts two-factor secrets. Defaults to sessionSecret. */
  encryptionKey?: string;
  /** Base address for invitation links; empty means the address the browser is using. */
  publicUrl?: string;
  cookieSecure?: boolean;
  demoLogins?: boolean;
  /** Folder with the built front end (web/dist). Served with a fallback to index.html. */
  staticDir?: string;
  logger?: boolean;
}

export interface Ctx {
  pool: pg.Pool;
  opts: ServerOptions;
  /** Runs fn as the signed-in user, inside one transaction. */
  as: <T>(req: FastifyRequest, fn: (db: Db) => Promise<T>) => Promise<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function uuidParam(v: string): string {
  if (!UUID.test(v)) throw new HttpError(404, 'Not found.', 'err.notFound');
  return v;
}

export function dateParam(v: unknown, fallback: string): string {
  if (v === undefined || v === '') return fallback;
  if (typeof v !== 'string' || !DATE.test(v)) throw new HttpError(400, 'Some values are not in the right format.', 'err.format');
  return v;
}

export const today = () => new Date().toISOString().slice(0, 10);
