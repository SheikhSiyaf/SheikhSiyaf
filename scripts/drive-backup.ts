// Copies the project to the owner's Google Drive. Run by .github/workflows/drive-backup.yml; it can also be run by
// hand: `DRIVE_UPLOAD_URL=... DRIVE_UPLOAD_SECRET=... npx tsx scripts/drive-backup.ts [push|monthly|all]`.
//
// What goes where (folder names are keys of scripts/drive-upload.gs, which holds the real Drive folder ids):
//   push     the source code as it is now  -> per_version (a new file per commit, never replaced)
//                                             and software (the same file under a fixed name, replaced each time)
//            the documents in docs/ that this push changed -> documents (replaced; the old copy goes to Drive's trash)
//   monthly  the whole history of every version (a git bundle) -> monthly, split in pieces
//            the marketing screenshots                          -> marketing
//   all      both of the above, with every document
// Only files Git tracks are packed, so .env, installed packages and build output can never end up in Drive. The live
// database is NOT sent to Drive: its backups are the encrypted ones made by .github/workflows/backup.yml.
//
// A file bigger than one piece is cut into pieces named <name>.part00, .part01, ...; put them back with
//   cat <name>.part* > <name> && git clone <name>.bundle    (for the history; zip parts are joined the same way)
// Nothing here prints the address or the password; failures say what happened without quoting either.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHUNK_BYTES = 3_000_000; // raw bytes per request (about 4 MB once encoded); the pieces are joined again by cat

export type Folder = 'software' | 'marketing' | 'per_version' | 'monthly' | 'documents';
export type Config = { url: string; secret: string };
type Answer = { ok?: boolean; status?: string; size?: number; error?: string };
export type Options = { fetch?: typeof fetch; wait?: (ms: number) => Promise<void>; replace?: boolean; chunk?: number };

class Refused extends Error {}

export function split(data: Buffer, size = CHUNK_BYTES): Buffer[] {
  if (data.length <= size) return [data];
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, i + size));
  return out;
}

export function partName(name: string, index: number, total: number): string {
  return total === 1 ? name : `${name}.part${String(index).padStart(2, '0')}`;
}

/** Sends one file piece. Retries a broken connection; never retries an answer from the receiver (it will not change). */
export async function sendOne(cfg: Config, folder: Folder, name: string, data: Buffer, o: Options = {}): Promise<Answer> {
  const doFetch = o.fetch ?? fetch;
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sha256 = createHash('sha256').update(data).digest('hex');
  const body = JSON.stringify({ secret: cfg.secret, folder, name, data: data.toString('base64'), sha256, replace: o.replace === true });
  let last = 'no answer';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await doFetch(cfg.url, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body, redirect: 'follow' });
      const text = await res.text();
      let answer: Answer;
      try { answer = JSON.parse(text) as Answer; } catch {
        // Google answers with a web page when the deployment is not set to "Anyone" or the address is wrong.
        throw new Refused(`the address did not give a JSON answer (HTTP ${res.status}); check the web app is deployed with access "Anyone" and the secret DRIVE_UPLOAD_URL ends in /exec`);
      }
      if (!answer.ok) throw new Refused(`${name}: refused by the receiver (${String(answer.error ?? 'no reason given')})`);
      if (answer.status === 'exists' && answer.size !== data.length) throw new Refused(`${name}: a different file with this name is already in Drive`);
      return answer;
    } catch (e) {
      if (e instanceof Refused) throw e;
      last = 'the connection failed'; // not e.message: it can name the host
      if (attempt < 3) await wait(attempt * 2000);
    }
  }
  throw new Error(`${name}: ${last} after 3 tries`);
}

/** Uploads one file, in pieces if it is large. Returns a plain line for the log. */
export async function uploadFile(cfg: Config, folder: Folder, name: string, data: Buffer, o: Options = {}): Promise<string> {
  const pieces = split(data, o.chunk ?? CHUNK_BYTES);
  if (pieces.length > 1 && o.replace) throw new Error(`${name} is too big to replace in place`);
  const states: string[] = [];
  for (const [i, piece] of pieces.entries()) {
    const a = await sendOne(cfg, folder, partName(name, i, pieces.length), piece, o);
    states.push(a.status ?? 'ok');
  }
  const summary = states.every((s) => s === states[0]) ? (states[0] ?? 'ok') : states.join('/');
  return `${summary.padEnd(8)} ${folder}/${name}${pieces.length > 1 ? ` (${pieces.length} pieces)` : ''}  ${(data.length / 1e6).toFixed(1)} MB`;
}

const git = (...args: string[]): Buffer => execFileSync('git', args, { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
const gitText = (...args: string[]): string => git(...args).toString().trim();

/** The documents this push changed (all of them when unknown). */
export function changedDocs(before: string | undefined, all: boolean): string[] {
  const every = readdirSync('docs').filter((f) => /\.(md|csv)$/.test(f)).map((f) => `docs/${f}`);
  if (all || !before || /^0+$/.test(before)) return every;
  try {
    const changed = gitText('diff', '--name-only', before, 'HEAD', '--', 'docs').split('\n').filter(Boolean);
    return every.filter((f) => changed.includes(f));
  } catch { return every; } // the earlier commit is not in this checkout
}

export async function run(mode: string, cfg: Config, env: NodeJS.ProcessEnv = process.env, o: Options = {}): Promise<string[]> {
  if (!['push', 'monthly', 'all'].includes(mode)) throw new Error('mode must be push, monthly or all');
  const lines: string[] = [];
  const sha = gitText('rev-parse', '--short', 'HEAD');
  const day = new Date().toISOString().slice(0, 10);
  const work = mkdtempSync(join(tmpdir(), 'drive-backup-'));
  try {
    if (mode !== 'monthly') {
      const source = git('archive', '--format=zip', 'HEAD', '--', '.', ':!marketing-screens');
      lines.push(await uploadFile(cfg, 'per_version', `nusuh-books-source-${day}-${sha}.zip`, source, o));
      lines.push(await uploadFile(cfg, 'software', 'nusuh-books-source-latest.zip', source, { ...o, replace: true })
        .catch((e: unknown) => `skipped  software/nusuh-books-source-latest.zip (${e instanceof Error ? e.message : 'failed'})`));
      for (const doc of changedDocs(env.BEFORE_SHA, mode === 'all')) {
        lines.push(await uploadFile(cfg, 'documents', doc.replace('docs/', ''), readFileSync(doc), { ...o, replace: true }));
      }
    }
    if (mode !== 'push') {
      const bundle = join(work, 'history.bundle');
      git('bundle', 'create', bundle, '--all');
      lines.push(await uploadFile(cfg, 'monthly', `nusuh-books-full-history-${day.slice(0, 7)}-${sha}.bundle`, readFileSync(bundle), o));
      const tree = gitText('rev-parse', '--short=8', 'HEAD:marketing-screens'); // changes only when a screenshot does
      const shots = gitText('ls-files', 'marketing-screens').split('\n').filter(Boolean);
      for (const [label, files] of [['english', shots.filter((f) => !f.includes('-ar-'))], ['arabic', shots.filter((f) => f.includes('-ar-'))]] as const) {
        if (files.length) lines.push(await uploadFile(cfg, 'marketing', `marketing-screens-${label}-${tree}.zip`, git('archive', '--format=zip', 'HEAD', '--', ...files), o));
      }
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  return lines;
}

async function main(): Promise<void> {
  const url = process.env.DRIVE_UPLOAD_URL ?? '';
  const secret = process.env.DRIVE_UPLOAD_SECRET ?? '';
  if (!url || !secret) { console.error('DRIVE_UPLOAD_URL and DRIVE_UPLOAD_SECRET must be set (GitHub secrets).'); process.exit(2); }
  const lines = await run(process.argv[2] ?? 'push', { url, secret });
  console.log(lines.join('\n'));
  console.log(`\n${lines.length} item(s) handled.`);
}

if (process.argv[1]?.endsWith('drive-backup.ts')) {
  main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : 'the backup failed'); process.exit(1); });
}
