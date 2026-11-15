// What the logs and error reports may never contain: passwords, keys, secrets, sign-in and link tokens, one-time
// codes and accounting amounts. Everything written to the log goes through these.
import type { FastifyServerOptions } from 'fastify';

const SECRET_KEYS = /("?(?:password|passwd|secret|token|otp|code|key|authorization|cookie|totp|ticket)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,&}]+)/gi;

/** Masks secrets, tokens, one-time codes and amounts in free text. */
export function redactText(s: string): string {
  return String(s)
    .replace(SECRET_KEYS, '$1[hidden]')
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 [hidden]')
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[key]')
    .replace(/[A-Za-z0-9_-]{24,}={0,2}/g, (m) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m) ? m : '[token]'))
    .replace(/(?<![\w.-])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\w.-])|(?<![\w.:/-])-?\d+\.\d{1,3}(?![\w.-])/g, '[amount]')
    .replace(/(?<![\w-])\d{6}(?![\w-])/g, '[code]');
}

/** Masks the token in links that work without signing in (invitations, customer invoice links, payments, resets). */
export function redactUrl(url: string): string {
  const [path, query] = String(url ?? '').split('?');
  const p = path!.replace(/\/(invite|i|reset|pay|reset-password|documents|payments|sandbox)\/([^/]+)/g, (m, seg: string, v: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v) && seg !== 'invite' && seg !== 'i' ? m : `/${seg}/[hidden]`);
  return query ? `${p}?${query.replace(/=([^&]*)/g, '=[hidden]')}` : p;
}

/** The Fastify (pino) logger: no headers, bodies or tokens; messages and errors masked. */
export function loggerOptions(o: { level?: string; stream?: { write(s: string): void } } = {}): FastifyServerOptions['logger'] {
  return {
    level: o.level ?? process.env.LOG_LEVEL ?? 'info',
    ...(o.stream ? { stream: o.stream } : {}),
    serializers: {
      req: (req: { method?: string; url?: string; ip?: string }) => ({ method: req.method, url: redactUrl(req.url ?? ''), ip: req.ip }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      err: (e: Error & { code?: string; statusCode?: number }) => ({ type: e?.name, code: e?.code, statusCode: e?.statusCode, message: redactText(e?.message ?? ''),
        stack: redactText(e?.stack ?? '') }),
    },
    hooks: {
      logMethod(args: unknown[], method: (...a: unknown[]) => void) {
        const out = args.map((a) => (typeof a === 'string' ? redactText(a) : a));
        // An error logged on its own: pino would copy its raw message into "msg"; give it the masked one instead.
        const first = out[0] as { message?: unknown; err?: { message?: unknown } } | undefined;
        if (out.length === 1 && first && typeof first === 'object') {
          const m = first instanceof Error ? first.message : first.err instanceof Error ? first.err.message : null;
          if (typeof m === 'string') out.push(redactText(m));
        }
        method.apply(this, out);
      },
    },
  } as FastifyServerOptions['logger'];
}
