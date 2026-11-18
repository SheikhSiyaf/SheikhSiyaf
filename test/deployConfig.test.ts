// render.yaml describes how the clients' copy is built and started, so a mistake in it is a broken deployment
// rather than a failed test. These checks hold it to the code it deploys.
//
// They exist because preparing to host turned up two faults that a reader would not notice. "npm start" runs the
// TypeScript through tsx, and tsx is a devDependency: a host that installs with NODE_ENV=production leaves it out,
// so the server could not start at all. And `npm ci` under NODE_ENV=production skips devDependencies, which is
// where typescript and vite live, so the build needs --include=dev or it fails looking for tsc.
//
// The file is read as text on purpose. A YAML library would be another dependency for one small file of our own.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const blueprint = readFileSync('render.yaml', 'utf8');
const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;

/** The value of a top-level field in the single service, e.g. startCommand. */
const field = (name: string): string => {
  const m = new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm').exec(blueprint);
  expect(m, `render.yaml has no ${name}`).toBeTruthy();
  return m![1]!.trim();
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('render.yaml, the deployment', () => {
  it('names only scripts that exist', () => {
    const named = [...blueprint.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(2);
    expect(named.filter((n) => !scripts[n])).toEqual([]);
  });

  it('starts compiled JavaScript, never TypeScript through tsx', () => {
    const start = field('startCommand');
    expect(start).toBe('npm run start:prod');
    // Follow it through to the real command: nothing in the chain may rely on tsx or ts-node, because neither is
    // installed when the host installs without devDependencies.
    const chain = (cmd: string, seen = new Set<string>()): string => {
      for (const m of cmd.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
        const name = m[1]!;
        if (seen.has(name)) continue;
        seen.add(name);
        cmd += ' ' + chain(scripts[name] ?? '', seen);
      }
      return cmd;
    };
    expect(chain(start)).not.toMatch(/\btsx\b|\bts-node\b/);
    expect(scripts['start:prod']).toMatch(/^node /);
  });

  it('installs devDependencies for the build, which needs typescript and vite', () => {
    // NODE_ENV=production is set on the service, and npm then skips devDependencies unless told otherwise.
    expect(blueprint).toMatch(/NODE_ENV\s*\n\s*value:\s*production/);
    expect(field('buildCommand')).toMatch(/--include=dev/);
    for (const tool of ['typescript', 'vite']) {
      const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies: Record<string, string> };
      expect(pkg.devDependencies[tool], `${tool} is expected to be a devDependency`).toBeTruthy();
    }
  });

  it('builds the server as well as the web app, or there would be nothing for node to run', () => {
    const build = scripts['build:prod'] ?? '';
    expect(build).toContain('build:server');
    expect(scripts['build:server']).toContain('tsconfig.build.json');
    expect(scripts['start:prod']).toContain('dist/api/main.js');
  });

  it('runs the migrations before the new version serves', () => {
    expect(field('preDeployCommand')).toBe('npm run db:migrate:prod');
    expect(scripts['db:migrate:prod']).toBe('node dist/db/migrate.js');
  });

  it('is not on a plan that sleeps, because the background jobs must keep running', () => {
    // Email goes out every minute and simplified e-invoices every two minutes. On a plan that stops when idle,
    // both stop with it and nobody is told.
    expect(field('plan')).not.toBe('free');
    expect(field('healthCheckPath')).toBe('/health');
  });

  it('declares no environment variable the code does not read, and no secret value', () => {
    const read = new Set(
      sourceFiles('src').flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/env\.([A-Z_]{3,})/g)].map((m) => m[1]!)),
    );
    const keys = [...blueprint.matchAll(/^\s*-\s*key:\s*([A-Z_]+)\s*$/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(8);
    expect(keys.filter((k) => !read.has(k)), 'declared in render.yaml but never read by the code').toEqual([]);
    // Every credential is asked for by the host and kept there. A value in this file would be a secret in the
    // repository, which is the one thing this must never contain.
    for (const secret of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'APP_DB_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'RESEND_API_KEY']) {
      expect(new RegExp(`key:\\s*${secret}\\s*\\n\\s*sync:\\s*false`).test(blueprint), `${secret} must be sync: false`).toBe(true);
    }
  });

  it('keeps the unsafe settings off, so the start-up checks cannot be satisfied by accident', () => {
    // A comment may sit between the key and its value, as it does for TRUST_PROXY.
    const setTo = (key: string, value: string) =>
      new RegExp(`key:\\s*${key}\\s*\\n(?:\\s*#.*\\n)*\\s*value:\\s*"?${value}"?\\s*\\n`).test(blueprint);
    expect(setTo('DEMO_LOGINS', 'false'), 'DEMO_LOGINS must be false').toBe(true);
    expect(setTo('COOKIE_SECURE', 'true'), 'COOKIE_SECURE must be true').toBe(true);
    expect(setTo('TRUST_PROXY', '1'), 'TRUST_PROXY must be 1 behind Render\'s proxy').toBe(true);
  });
});
