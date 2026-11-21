// The Google Drive backup, tested end to end without Google: the receiving script (scripts/drive-upload.gs) is run as it
// is inside a sandbox that fakes Drive, behind a small web server that behaves like Apps Script (a POST is answered
// with a 302 that the sender must follow). The real uploader (scripts/drive-backup.ts) then talks to it. What this
// proves: the password check, that only the five listed folders can be written, that a damaged file is refused, that a
// large file arrives in pieces that join back to the exact original, that a repeat does not duplicate, that a dropped
// connection is retried, and that the real source archive never contains .env or installed packages. What it cannot
// prove: how Google itself answers. That is only known by the first real run (see the report).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { parse } from 'yaml';
import { partName, run, sendOne, split, uploadFile, type Folder } from '../scripts/drive-backup.js';

const SECRET = 'S3cretPasswordForTestsOnly0123456789abcdef';
const gs = readFileSync('scripts/drive-upload.gs', 'utf8');

type Stored = { id: string; name: string; bytes: Buffer; trashed: boolean; folder: string };
type Reply = { ok: boolean; status?: string; size?: number; error?: string; id?: string; sha256?: string };

/** The receiving script, run for real, with Drive faked. */
function receiver(secret: string | undefined = SECRET) {
  const files: Stored[] = [];
  const signed = (b: Buffer) => Array.from(b, (x) => (x > 127 ? x - 256 : x));
  const unsigned = (a: number[]) => Buffer.from(a.map((x) => (x < 0 ? x + 256 : x)));
  const wrap = (f: Stored) => ({ getId: () => f.id, getSize: () => f.bytes.length, setTrashed: (t: boolean) => { f.trashed = t; } });
  const ctx = vm.createContext({
    ContentService: { createTextOutput: (s: string) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => secret }) },
    Utilities: {
      base64Decode: (s: string) => signed(Buffer.from(s, 'base64')),
      computeDigest: (_a: string, bytes: number[]) => signed(createHash('sha256').update(unsigned(bytes)).digest()),
      DigestAlgorithm: { SHA_256: 'sha256' },
      newBlob: (bytes: number[], _mime: string, name: string) => ({ bytes, name }),
    },
    DriveApp: {
      getFolderById: (folder: string) => ({
        getFilesByName: (name: string) => {
          const hits = files.filter((f) => f.folder === folder && f.name === name && !f.trashed);
          let i = 0;
          return { hasNext: () => i < hits.length, next: () => wrap(hits[i++]!) };
        },
        createFile: (blob: { bytes: number[]; name: string }) => {
          const f: Stored = { id: `id${files.length + 1}`, name: blob.name, bytes: unsigned(blob.bytes), trashed: false, folder };
          files.push(f);
          return wrap(f);
        },
      }),
    },
  });
  vm.runInContext(gs, ctx);
  const doPost = (ctx as unknown as { doPost: (e: unknown) => { s: string } }).doPost;
  const ids = vm.runInContext('FOLDERS', ctx) as Record<Folder, string>;
  const raw = (contents: string): string => doPost({ postData: { contents } }).s;
  const call = (p: Record<string, unknown>): Reply => JSON.parse(raw(JSON.stringify(p))) as Reply;
  const live = (folder: Folder) => files.filter((f) => f.folder === ids[folder] && !f.trashed);
  return { files, ids, raw, call, live };
}

const pack = (name: string, data: Buffer, over: Record<string, unknown> = {}) => ({
  secret: SECRET, folder: 'per_version', name, data: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex'), replace: false, ...over,
});

describe('the receiving script', () => {
  it('refuses a wrong or missing password and writes nothing', () => {
    const r = receiver();
    for (const secret of ['', 'wrong', SECRET.slice(0, -1), SECRET + 'x']) {
      const a = r.call(pack('a.zip', Buffer.from('hi'), { secret }));
      expect(a.ok, `secret "${secret}"`).toBe(false);
      expect(a.error).toBe('refused');
    }
    expect(r.files).toHaveLength(0);
  });

  it('refuses everything while the password is not set, or too short', () => {
    for (const set of [undefined, '', 'short']) {
      const r = receiver(set);
      const a = r.call(pack('a.zip', Buffer.from('hi'), { secret: set ?? '' }));
      expect(a.ok).toBe(false);
      expect(r.files).toHaveLength(0);
    }
  });

  it('writes a good file into the folder asked for, and never answers with the password', () => {
    const r = receiver();
    const data = randomBytes(1000);
    const raw = r.raw(JSON.stringify(pack('nusuh-books-source-2026-11-21-abc1234.zip', data, { folder: 'monthly' })));
    expect(raw).not.toContain(SECRET);
    const a = JSON.parse(raw) as Reply;
    expect(a).toMatchObject({ ok: true, status: 'created', size: 1000 });
    expect(r.live('monthly').map((f) => f.name)).toEqual(['nusuh-books-source-2026-11-21-abc1234.zip']);
    expect(r.live('monthly')[0]!.bytes.equals(data)).toBe(true);
    expect(r.live('per_version')).toHaveLength(0);
  });

  it('only knows the five folders, and only plain file names', () => {
    const r = receiver();
    for (const folder of ['root', '../x', '', '1uL9Bl1jWeqLoGjmdFfomRkf2N8H9lBwP', 'constructor', '__proto__']) {
      expect(r.call(pack('a.zip', Buffer.from('x'), { folder })).ok, folder).toBe(false);
    }
    for (const name of ['', '../x.zip', '.env', 'a/b.zip', 'a\\b.zip', ' lead.zip', 'x'.repeat(121)]) {
      expect(r.call(pack(name, Buffer.from('x'))).ok, name).toBe(false);
    }
    expect(r.files).toHaveLength(0);
  });

  it('refuses a file damaged on the way', () => {
    const r = receiver();
    const a = r.call(pack('a.zip', Buffer.from('hello'), { sha256: createHash('sha256').update('different').digest('hex') }));
    expect(a).toMatchObject({ ok: false });
    expect(a.error).toMatch(/hash mismatch/);
    expect(r.files).toHaveLength(0);
  });

  it('never overwrites silently: the same name reports "exists" and keeps the original', () => {
    const r = receiver();
    r.call(pack('a.zip', Buffer.from('first')));
    const again = r.call(pack('a.zip', Buffer.from('second!')));
    expect(again).toMatchObject({ ok: true, status: 'exists', size: 5 });
    expect(r.live('per_version')).toHaveLength(1);
    expect(r.live('per_version')[0]!.bytes.toString()).toBe('first');
  });

  it('replaces only when asked, and then moves the old copy to the trash instead of deleting it', () => {
    const r = receiver();
    r.call(pack('latest.zip', Buffer.from('old'), { folder: 'software' }));
    const a = r.call(pack('latest.zip', Buffer.from('newer'), { folder: 'software', replace: true }));
    expect(a.status).toBe('replaced');
    expect(r.live('software').map((f) => f.bytes.toString())).toEqual(['newer']);
    expect(r.files.filter((f) => f.trashed).map((f) => f.bytes.toString())).toEqual(['old']);
  });

  it('answers garbage without throwing, and the password appears in the source only inside the comparison', () => {
    const r = receiver();
    expect(JSON.parse(r.raw('not json')).ok).toBe(false);
    expect([...gs.matchAll(/body\.secret/g)]).toHaveLength(1);
    expect(gs).toMatch(/same\(String\(body\.secret/);
  });
});

/** A web server that behaves like an Apps Script web app: a POST is answered with a 302 to a page holding the answer. */
function appsScript(r: ReturnType<typeof receiver>) {
  const answers = new Map<string, string>();
  const behaviour = { drop: 0, html: false };
  const seen = { posts: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.posts++;
        if (behaviour.drop > 0) { behaviour.drop--; req.socket.destroy(); return; }
        if (behaviour.html) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>Sign in to continue</html>'); return; }
        const id = String(answers.size + 1);
        answers.set(id, r.raw(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(302, { location: `/answer/${id}` });
        res.end();
      });
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(answers.get(String(req.url).split('/').pop() ?? '') ?? '{}');
    }
  });
  return {
    behaviour, seen,
    start: () => new Promise<string>((ok) => server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(server.address() as { port: number }).port}/exec`))),
    stop: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}

describe('the uploader against the receiver', () => {
  const r = receiver();
  const app = appsScript(r);
  let cfg = { url: '', secret: SECRET };
  const fast = { wait: async () => undefined };
  beforeAll(async () => { cfg = { url: await app.start(), secret: SECRET }; });
  afterAll(async () => { await app.stop(); });

  it('cuts a large file into pieces that join back to the exact original', async () => {
    const big = randomBytes(7_300_000);
    expect(split(big).map((p) => p.length)).toEqual([3_000_000, 3_000_000, 1_300_000]);
    const line = await uploadFile(cfg, 'monthly', 'history.bundle', big, fast);
    expect(line).toMatch(/3 pieces/);
    const parts = r.live('monthly').filter((f) => f.name.startsWith('history.bundle.part')).sort((a, b) => a.name.localeCompare(b.name));
    expect(parts.map((p) => p.name)).toEqual(['history.bundle.part00', 'history.bundle.part01', 'history.bundle.part02']);
    expect(Buffer.concat(parts.map((p) => p.bytes)).equals(big)).toBe(true);
    expect(partName('a.zip', 0, 1)).toBe('a.zip');
  });

  it('keeps a small file whole, and a repeat creates no duplicate', async () => {
    const data = randomBytes(5000);
    expect(await uploadFile(cfg, 'per_version', 'one.zip', data, fast)).toMatch(/^created/);
    expect(await uploadFile(cfg, 'per_version', 'one.zip', data, fast)).toMatch(/^exists/);
    expect(r.live('per_version').filter((f) => f.name === 'one.zip')).toHaveLength(1);
  });

  it('replaces a file when asked, and refuses to replace one that needs pieces', async () => {
    await uploadFile(cfg, 'documents', 'NOTES.md', Buffer.from('v1'), { ...fast, replace: true });
    expect(await uploadFile(cfg, 'documents', 'NOTES.md', Buffer.from('version 2'), { ...fast, replace: true })).toMatch(/^replaced/);
    expect(r.live('documents').filter((f) => f.name === 'NOTES.md').map((f) => f.bytes.toString())).toEqual(['version 2']);
    await expect(uploadFile(cfg, 'documents', 'BIG.md', randomBytes(50), { ...fast, replace: true, chunk: 10 })).rejects.toThrow(/too big to replace/);
  });

  it('stops on a wrong password without leaking the password or the address', async () => {
    const before = r.files.length;
    const err = await sendOne({ ...cfg, secret: 'not-the-password-000000000000000000' }, 'per_version', 'x.zip', Buffer.from('x'), fast).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/refused/);
    expect(msg).not.toContain(SECRET);
    expect(msg).not.toContain('not-the-password');
    expect(msg).not.toContain(cfg.url);
    expect(msg).not.toContain('127.0.0.1');
    expect(r.files.length).toBe(before);
  });

  it('retries a dropped connection, and gives up after three tries without naming the host', async () => {
    app.behaviour.drop = 1;
    const posts = app.seen.posts;
    await sendOne(cfg, 'per_version', 'retry.zip', Buffer.from('r'), fast);
    expect(app.seen.posts - posts).toBe(2);
    app.behaviour.drop = 9;
    const err = (await sendOne(cfg, 'per_version', 'dead.zip', Buffer.from('d'), fast).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/after 3 tries/);
    expect(err.message).not.toContain('127.0.0.1');
    app.behaviour.drop = 0;
  });

  it('explains a web-page answer (the usual sign of "Anyone" not being set) instead of retrying', async () => {
    app.behaviour.html = true;
    const posts = app.seen.posts;
    const err = (await sendOne(cfg, 'per_version', 'html.zip', Buffer.from('h'), fast).catch((e: Error) => e)) as Error;
    app.behaviour.html = false;
    expect(err.message).toMatch(/Anyone/);
    expect(app.seen.posts - posts).toBe(1);
  });

  it('refuses a same-name file of a different size instead of calling it done', async () => {
    await uploadFile(cfg, 'per_version', 'clash.zip', Buffer.from('12345'), fast);
    await expect(uploadFile(cfg, 'per_version', 'clash.zip', Buffer.from('123456789'), fast)).rejects.toThrow(/different file with this name/);
  });
});

describe('what the backup job really sends', () => {
  const r = receiver();
  const app = appsScript(r);
  let cfg = { url: '', secret: SECRET };
  const fast = { wait: async () => undefined };
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository']).toString().trim() === 'true';
  const work = mkdtempSync(join(tmpdir(), 'drive-test-'));
  beforeAll(async () => { cfg = { url: await app.start(), secret: SECRET }; });
  afterAll(async () => { await app.stop(); rmSync(work, { recursive: true, force: true }); });

  it('push: sends the tracked source only (no .env, no installed packages), under a name with the commit, and every document', async () => {
    const lines = await run('push', cfg, { BEFORE_SHA: '' }, fast);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
    const versions = r.live('per_version');
    expect(versions).toHaveLength(1);
    expect(versions[0]!.name).toMatch(new RegExp(`^nusuh-books-source-\\d{4}-\\d{2}-\\d{2}-${sha}\\.zip$`));
    const zip = join(work, 'source.zip');
    writeFileSync(zip, versions[0]!.bytes);
    const names = execFileSync('unzip', ['-Z1', zip], { maxBuffer: 1 << 26 }).toString().split('\n').filter(Boolean);
    expect(names).toContain('package.json');
    expect(names).toContain('src/config.ts');
    expect(names.filter((n) => n === '.env' || n.startsWith('node_modules/') || n.startsWith('dist/') || n.endsWith('.pem') || n.startsWith('marketing-screens/'))).toEqual([]);
    expect(r.live('software').map((f) => f.name)).toEqual(['nusuh-books-source-latest.zip']);
    expect(r.live('documents').map((f) => f.name)).toEqual(expect.arrayContaining(['ADVISOR_BRIEF.md', 'DECISIONS.md', 'SCHEMA_CHANGES.md']));
    for (const f of r.files) expect(f.bytes.includes(SECRET)).toBe(false);
  }, 60_000);

  it('monthly: sends the whole history in pieces that rebuild a valid repository, and the screenshots by language', async () => {
    if (shallow) return; // a shallow checkout (the usual CI clone) holds no history to send; the workflow uses full depth
    const lines = await run('monthly', cfg, {}, fast);
    expect(lines.some((l) => /pieces/.test(l))).toBe(true);
    const parts = r.live('monthly').filter((f) => /\.bundle\.part\d\d$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
    expect(parts.length).toBeGreaterThan(1);
    const bundle = join(work, 'history.bundle');
    writeFileSync(bundle, Buffer.concat(parts.map((p) => p.bytes)));
    const verdict = execFileSync('git', ['bundle', 'verify', bundle], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    expect(verdict + '').toBeDefined();
    expect(execFileSync('git', ['bundle', 'list-heads', bundle]).toString()).toMatch(/refs\/heads\//);
    // Each language is one zip of about 6 to 7 MB, so it arrives in pieces; the name carries the screenshots' own hash.
    const kinds = new Set(r.live('marketing').map((f) => f.name.replace(/-[0-9a-f]{8}\.zip(\.part\d\d)?$/, '')));
    expect([...kinds].sort()).toEqual(['marketing-screens-arabic', 'marketing-screens-english']);
    const english = r.live('marketing').filter((f) => /english-[0-9a-f]{8}\.zip\.part\d\d$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
    const zip = join(work, 'english.zip');
    writeFileSync(zip, Buffer.concat(english.map((p) => p.bytes)));
    expect(execFileSync('unzip', ['-Z1', zip]).toString().split('\n').filter((n) => n.endsWith('.png')).length).toBeGreaterThan(10);
  }, 120_000);

  it('refuses a mode it does not know', async () => {
    await expect(run('everything', cfg, {}, fast)).rejects.toThrow(/mode must be/);
  });
});

describe('the workflow and the script keep the secrets out of sight', () => {
  const text = readFileSync('.github/workflows/drive-backup.yml', 'utf8');
  const wf = parse(text) as { on: { push: { branches: string[] }; schedule: Array<{ cron: string }>; workflow_dispatch: unknown }; jobs: { upload: { if: string; steps: Array<{ uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string }> } } };

  it('parses, runs on pushes to the working branch, monthly, and by hand', () => {
    expect(wf.on.push.branches).toEqual(['claude/nusuh-books-starter-kit-3vsat0']);
    expect(wf.on.schedule[0]!.cron).toMatch(/^\d+ \d+ 1 \* \*$/);
    expect(wf.on.workflow_dispatch).toBeDefined();
  });

  it('stays off until the owner switches it on, so a push never fails for lack of a login', () => {
    expect(wf.jobs.upload.if).toContain("vars.DRIVE_BACKUP_ENABLED == 'true'");
    expect(wf.jobs.upload.if).toContain('[skip backup]');
  });

  it('takes the full history, and the address and password only from repository secrets', () => {
    const steps = wf.jobs.upload.steps;
    expect(steps.find((s) => s.uses?.startsWith('actions/checkout'))?.with).toMatchObject({ 'fetch-depth': 0 });
    const upload = steps.find((s) => s.run?.includes('drive-backup.ts'))!;
    expect(upload.env).toMatchObject({ DRIVE_UPLOAD_URL: '${{ secrets.DRIVE_UPLOAD_URL }}', DRIVE_UPLOAD_SECRET: '${{ secrets.DRIVE_UPLOAD_SECRET }}' });
    expect(text).not.toMatch(/script\.google\.com|macros\/s\//);
  });

  it('the uploader never prints the address or the password', () => {
    const src = readFileSync('scripts/drive-backup.ts', 'utf8');
    const printed = src.split('\n').filter((l) => /console\.(log|error|warn)/.test(l));
    // Only the code outside quotes matters: a message may name DRIVE_UPLOAD_URL, but must not print its value.
    for (const l of printed) {
      const call = l.slice(l.indexOf('console.')).split(';')[0]!; // the printing statement only, not a condition before it
      expect(call.replace(/'[^']*'|`[^`]*`|"[^"]*"/g, ''), l).not.toMatch(/cfg|\bsecret\b|\burl\b/);
    }
    expect(src).not.toMatch(/\$\{[^}]*(cfg\.url|cfg\.secret)[^}]*\}/);
  });
});
