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
import { parse } from 'yaml';

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

describe('the YAML files are valid YAML, not just text that looks right', () => {
  // The other checks here read render.yaml as text, so they passed while the file could not be parsed at all: an
  // unquoted ": " inside the build command made Render reject the whole blueprint, silently keeping the old service
  // settings. Every sync failed and none of the later fixes reached the live site until the owner saw the error.
  it.each(['render.yaml', '.github/workflows/ci.yml', '.github/workflows/backup.yml', '.github/workflows/hosted-db-check.yml'])('%s parses', (file) => {
    expect(() => parse(readFileSync(file, 'utf8'))).not.toThrow();
  });

  it('render.yaml, once parsed, holds the build command and variables the text checks assume', () => {
    const svc = (parse(blueprint) as { services: Array<{ buildCommand: string; envVars: Array<{ key: string }> }> }).services[0]!;
    expect(svc.buildCommand).toBe(field('buildCommand'));
    expect(svc.buildCommand).toContain('db:install:prod');
    const keys = svc.envVars.map((e) => e.key);
    for (const k of ['NODE_VERSION', 'HOST', 'DATABASE_URL', 'SESSION_SECRET', 'OWNER_EMAIL']) expect(keys).toContain(k);
  });
});

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
    // Either place is correct: preDeployCommand on a paid plan, or the end of the build on the free plan, where
    // preDeployCommand is not available. What must never happen is the new code serving against the old schema.
    const build = field('buildCommand');
    const pre = /^\s*preDeployCommand:\s*(.+)$/m.exec(blueprint)?.[1]?.trim();
    expect(build.includes('db:migrate:prod') || pre === 'npm run db:migrate:prod',
      'the migration must run either in preDeployCommand or at the end of buildCommand').toBe(true);
    expect(scripts['db:migrate:prod']).toBe('node dist/db/migrate.js');
    if (build.includes('db:migrate:prod')) {
      // It has to come after the build, or it would run node against a dist/ that does not exist yet.
      expect(build.indexOf('build:prod')).toBeLessThan(build.indexOf('db:migrate:prod'));
    }
  });

  it('names a real compute plan, and the free one only with its cost written down', () => {
    // The owner chose the free plan deliberately: nothing is paid for until the first client's fee. It is a real
    // trade — the service sleeps when idle, and while it sleeps the background jobs do not run, so queued email
    // and e-invoice reporting are late rather than lost. This check does not forbid it; it makes sure whoever
    // reads the file is told, and that the plan is one Render actually accepts.
    const plan = field('plan');
    expect(['free', '0.5c-512mb', '1c-2g', '2c-4g', '2c-8g']).toContain(plan);
    if (plan === 'free') {
      expect(blueprint, 'the free plan must carry a note of what it costs').toMatch(/sleeps|spin|wake/i);
    }
    expect(field('healthCheckPath')).toBe('/health');
  });

  it('declares no environment variable the code does not read, and no secret value', () => {
    const read = new Set(
      sourceFiles('src').flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/env\.([A-Z_]{3,})/g)].map((m) => m[1]!)),
    );
    const keys = [...blueprint.matchAll(/^\s*-\s*key:\s*([A-Z_]+)\s*$/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(8);
    // Read by the platform or the build rather than by our code: Render's Node version, and the owner's name and email,
    // which the build step reads through install.ts's ownerFrom (it receives process.env whole).
    const platform = new Set(['NODE_VERSION']);
    expect(keys.filter((k) => !read.has(k) && !platform.has(k)), 'declared in render.yaml but never read by the code').toEqual([]);
    expect(blueprint).toMatch(/key:\s*NODE_VERSION\s*\n\s*value:\s*"22"/);
    // Every credential is asked for by the host and kept there. A value in this file would be a secret in the
    // repository, which is the one thing this must never contain.
    for (const secret of ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'APP_DB_PASSWORD', 'RESEND_API_KEY']) {
      expect(new RegExp(`key:\\s*${secret}\\s*\\n\\s*sync:\\s*false`).test(blueprint), `${secret} must be sync: false`).toBe(true);
    }
    // The two keys the app makes up itself are generated by Render, which keeps them: still no value in this file.
    for (const secret of ['SESSION_SECRET', 'ENCRYPTION_KEY']) {
      expect(new RegExp(`key:\\s*${secret}\\s*\\n(?:\\s*#.*\\n)*\\s*generateValue:\\s*true`).test(blueprint), `${secret} must be generateValue: true`).toBe(true);
    }
  });

  it('keeps the unsafe settings off, so the start-up checks cannot be satisfied by accident', () => {
    // A comment may sit between the key and its value, as it does for TRUST_PROXY.
    const setTo = (key: string, value: string) =>
      new RegExp(`key:\\s*${key}\\s*\\n(?:\\s*#.*\\n)*\\s*value:\\s*"?${value}"?\\s*\\n`).test(blueprint);
    expect(setTo('DEMO_LOGINS', 'false'), 'DEMO_LOGINS must be false').toBe(true);
    expect(setTo('COOKIE_SECURE', 'true'), 'COOKIE_SECURE must be true').toBe(true);
    expect(setTo('HOST', '0.0.0.0'), 'HOST must be 0.0.0.0, or the host finds no open port').toBe(true);
    expect(setTo('TRUST_PROXY', '1'), 'TRUST_PROXY must be 1 behind Render\'s proxy').toBe(true);
  });
});

describe('the daily backup workflow', () => {
  const wf = readFileSync('.github/workflows/backup.yml', 'utf8');

  it('runs the scripts that exist, and is off until the owner turns it on', () => {
    for (const script of wf.matchAll(/bash (scripts\/[a-z-]+\.sh)/g)) expect(() => statSync(script[1]!)).not.toThrow();
    expect(wf).toMatch(/vars\.BACKUP_ENABLED == 'true'/);
    expect(wf).toMatch(/cron:/);
  });

  it('reads every credential from secrets and holds no value of its own', () => {
    for (const key of ['BACKUP_DATABASE_URL', 'BACKUP_PASSPHRASE', 'BACKUP_S3_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
      expect(wf, `${key} must come from secrets`).toMatch(new RegExp(`${key}:\\s*\\$\\{\\{\\s*secrets\\.${key}\\s*\\}\\}`));
    }
    expect(wf).not.toMatch(/postgres(ql)?:\/\/[^\s'"]*@(?!localhost)/);   // no connection string with a real host
  });

  it('rehearses the restore, so a backup that cannot be opened turns the run red', () => {
    expect(wf).toMatch(/scripts\/restore\.sh/);
  });
});

describe('the hosted database check', () => {
  const wf = readFileSync('.github/workflows/hosted-db-check.yml', 'utf8');
  const script = readFileSync('scripts/hosted-db-check.ts', 'utf8');

  it('reads every credential from secrets, holds no value of its own, and runs a script that exists', () => {
    for (const key of ['HOSTED_DATABASE_ADMIN_URL', 'HOSTED_DATABASE_URL', 'HOSTED_APP_DB_PASSWORD', 'HOSTED_DATABASE_CA_CERT']) {
      expect(wf, `${key} must come from secrets`).toMatch(new RegExp(`${key}:\\s*\\$\\{\\{\\s*secrets\\.${key}\\s*\\}\\}`));
    }
    expect(wf).not.toMatch(/postgres(ql)?:\/\/[^\s'"]*@(?!localhost)/);
    expect(() => statSync('scripts/hosted-db-check.ts')).not.toThrow();
    expect(wf).toContain('scripts/hosted-db-check.ts');
  });

  it('never prints a connection string or a password', () => {
    // Every console.log in the script goes through record() or prints a fixed sentence; none interpolates a setting.
    for (const secret of ['adminUrl', 'appUrl', 'appPassword', 'HOSTED_DATABASE_ADMIN_URL', 'HOSTED_DATABASE_URL', 'HOSTED_APP_DB_PASSWORD']) {
      const printing = script.split('\n').filter((l) => /console\.(log|error)\(|record\(/.test(l) && l.includes(secret) && !/need\(|is not set|must be at least/.test(l));
      expect(printing, `a line prints ${secret}`).toEqual([]);
    }
  });

  it('refuses a database that already holds a customer, and never loads demo data', () => {
    expect(script).toContain("kind <> 'platform'");
    expect(script).not.toMatch(/seed\(/);
  });
});
