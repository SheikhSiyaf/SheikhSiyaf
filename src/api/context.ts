// Shared request helpers for the route modules.
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Db } from '../db/session.js';
import { HttpError } from './errors.js';
import { DEV_ENCRYPTION_KEY } from '../config.js';

export interface ServerOptions {
  pool: pg.Pool;
  sessionSecret: string;
  /** Encrypts two-factor secrets. Defaults to sessionSecret. */
  encryptionKey?: string;
  /** Base address for invitation links; empty means the address the browser is using. */
  publicUrl?: string;
  /** REDIRECT_OLD_ADDRESS=on: the old *.onrender.com address sends page loads on to publicUrl. */
  redirectOldAddress?: boolean;
  cookieSecure?: boolean;
  demoLogins?: boolean;
  /** This server IS the demo site (its own database of fictional companies, src/api/demo.ts). The secret is shared with the live app. */
  demoSite?: { linkSecret: string };
  /** The live app's way to the demo site: the demo site's https address and the shared secret (the platform owner's Demo mode button). */
  demoLink?: { url: string; secret: string };
  /** Folder with the built front end (web/dist). Served with a fallback to index.html. */
  staticDir?: string;
  logger?: import('fastify').FastifyServerOptions['logger'];
  /** NODE_ENV=production: links use only publicUrl, and the demo sign-in stays off. */
  production?: boolean;
  /** Fastify's trustProxy: when on, the client address comes from X-Forwarded-For (only behind your own proxy). */
  trustProxy?: boolean | number | string;
  /** The clock for the free-trial lock. Only code (the tests) sets it; there is no setting or address that can change it. */
  now?: () => Date;
  /** How long, in milliseconds, the trial lock remembers a person's customer. Default 15000; the tests use 0. */
  lockCacheMs?: number;
}

export interface Ctx {
  pool: pg.Pool;
  opts: ServerOptions;
  /** Runs fn as the signed-in user, inside one transaction. */
  as: <T>(req: FastifyRequest, fn: (db: Db) => Promise<T>) => Promise<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The key that encrypts stored secrets: ENCRYPTION_KEY, never the session secret. Production without it is refused. */
export function encryptionKeyOf(opts: Pick<ServerOptions, 'encryptionKey' | 'production'>): string {
  if (opts.encryptionKey) return opts.encryptionKey;
  if (opts.production) throw new Error('ENCRYPTION_KEY is required in production.');
  return DEV_ENCRYPTION_KEY;
}

export function uuidParam(v: string): string {
  if (!UUID.test(v)) throw new HttpError(404, 'Not found.', 'err.notFound');
  return v.toLowerCase();
}

/** The path of the route the server matched, filled in with its decoded parameters, in small letters. Access rules and
 *  rate limits match this, never the raw address: an ID in capitals or a letter written as %72 reaches the same route,
 *  so it must meet the same rule (security review finding 1). */
export function routePath(req: FastifyRequest): string {
  const template = req.routeOptions?.url;
  const params = (req.params ?? {}) as Record<string, string>;
  if (!template) {
    const raw = req.url.split('?')[0]!;
    try { return decodeURIComponent(raw).toLowerCase(); } catch { return raw.toLowerCase(); }
  }
  return template.replace(/:([A-Za-z0-9_]+)|\*/g, (m, k?: string) => String((k ? params[k] : params['*']) ?? m)).toLowerCase();
}

export function dateParam(v: unknown, fallback: string): string {
  if (v === undefined || v === '') return fallback;
  if (typeof v !== 'string' || !DATE.test(v)) throw new HttpError(400, 'Some values are not in the right format.', 'err.format');
  return v;
}

export const today = () => new Date().toISOString().slice(0, 10);

/** The address links in emails start with. In production only PUBLIC_URL (Host and X-Forwarded-Host can be forged);
 *  in development PUBLIC_URL, or the address the browser is using. */
export function baseUrl(req: FastifyRequest, opts: Pick<ServerOptions, 'publicUrl' | 'production'>): string {
  if (opts.production) {
    if (!opts.publicUrl) throw new HttpError(500, 'PUBLIC_URL is not set.', 'err.server');
    return opts.publicUrl.replace(/\/+$/, '');
  }
  const fromReq = `${req.headers['x-forwarded-proto'] ?? req.protocol}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
  return (opts.publicUrl || fromReq).replace(/\/+$/, '');
}
