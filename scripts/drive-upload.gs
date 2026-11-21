// The receiving end of the Google Drive backup. This is NOT run by the project: you paste it into a Google Apps Script
// project that belongs to the Drive account, deploy it as a web app, and keep its address and password in GitHub's
// secrets. It lets the backup job on GitHub drop a file into one of five folders, and do nothing else.
//
// What it can and cannot do, by design:
//   - It only writes into the five folders listed below. It cannot read, list, download or delete anything in Drive.
//   - A file with the same name is never overwritten silently: it is reported as "exists". Only a request that asks to
//     replace a file moves the old copy to Drive's trash (kept for 30 days, so it can be put back).
//   - Every request must carry the password stored in Script Properties (UPLOAD_SECRET). Wrong password: nothing is
//     written. The password is never sent back in an answer.
//   - Every file is checked: the sender's SHA-256 must equal the one computed here on the bytes received.
//
// Set-up (about ten minutes, once):
//   1. script.google.com > New project. Delete the sample code and paste this whole file. Save.
//   2. Project settings (gear) > Script properties > Add: name UPLOAD_SECRET, value = a long random password, 40+
//      letters and digits. Keep a copy for step 5.
//   3. Deploy > New deployment > type Web app. Execute as: Me. Who has access: Anyone. Deploy, then Authorize and allow
//      Drive access (Google warns the app is not verified: it is your own script, choose Advanced > Go to project).
//   4. Copy the Web app URL (ends in /exec).
//   5. In GitHub > Settings > Secrets and variables > Actions: secrets DRIVE_UPLOAD_URL (the URL) and
//      DRIVE_UPLOAD_SECRET (the password), and a repository VARIABLE DRIVE_BACKUP_ENABLED = true.
// After changing this file, Deploy > Manage deployments > edit > New version, or the old code keeps running.
//
// "Anyone" only means the address does not need a Google sign-in: the password in every request is what protects it.
const FOLDERS = {
  software: '1uL9Bl1jWeqLoGjmdFfomRkf2N8H9lBwP',     // Nusuh Books / 1 Software
  marketing: '1icMcMuO_AzNYVHeKw5ky_Q15mRL8okVr',    // Nusuh Books / 2 Marketing Website
  per_version: '1sVNc4C9KxAGQkBU_3wy_UcEDqNkC-LuU',  // Nusuh Books / 3 Backups / Per version
  monthly: '1wHCJegreHrs7H5qiX0kOmMg-NrJdjTJG',      // Nusuh Books / 3 Backups / Monthly
  documents: '1bQiIeR8zt-AYQ4rOSdEZCm8aukP8ICpq',    // Nusuh Books / 4 Documents
};

function doGet() {
  return reply({ ok: true, service: 'nusuh-books-drive-upload' });
}

function doPost(e) {
  try {
    return reply(handle(e));
  } catch (err) {
    return reply({ ok: false, error: 'the upload failed inside Apps Script' });
  }
}

function handle(e) {
  const body = JSON.parse(e.postData.contents);
  const secret = PropertiesService.getScriptProperties().getProperty('UPLOAD_SECRET');
  if (!secret || secret.length < 24) return { ok: false, error: 'not set up: UPLOAD_SECRET is missing or too short' };
  if (!same(String(body.secret || ''), secret)) return { ok: false, error: 'refused' };

  // Own keys only: a plain FOLDERS[x] would also answer for names like "constructor" or "__proto__".
  const key = String(body.folder);
  const folderId = Object.prototype.hasOwnProperty.call(FOLDERS, key) ? FOLDERS[key] : '';
  if (!folderId) return { ok: false, error: 'unknown folder' };
  const name = String(body.name || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(name)) return { ok: false, error: 'bad file name' };

  const bytes = Utilities.base64Decode(String(body.data || ''));
  const hash = hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
  if (hash !== String(body.sha256 || '').toLowerCase()) return { ok: false, error: 'hash mismatch: the file was damaged on the way' };

  const folder = DriveApp.getFolderById(folderId);
  const found = [];
  const it = folder.getFilesByName(name);
  while (it.hasNext()) found.push(it.next());
  let status = 'created';
  if (found.length) {
    if (!body.replace) return { ok: true, status: 'exists', id: found[0].getId(), size: found[0].getSize() };
    found.forEach(function (f) { f.setTrashed(true); });
    status = 'replaced';
  }
  const file = folder.createFile(Utilities.newBlob(bytes, 'application/octet-stream', name));
  return { ok: true, status: status, id: file.getId(), size: file.getSize(), sha256: hash };
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Compares in the same time whatever the first difference is, so the password cannot be guessed letter by letter.
function same(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Apps Script returns bytes as signed numbers (-128..127).
function hex(bytes) {
  return bytes.map(function (b) { return ((b < 0 ? b + 256 : b)).toString(16).padStart(2, '0'); }).join('');
}
