#!/usr/bin/env bash
# Encrypted backup of the whole database: one file, safe to keep anywhere.
#
# Why this exists. The host's own restore window is short (Render: 3 days on the free workspace) and Saudi and UAE
# books are kept for years, so a copy has to live somewhere else, under our control. The copy is encrypted BEFORE it
# leaves this machine, so the storage provider only ever holds ciphertext.
#
# Settings (all from the environment; never put a value in this file or on a command line):
#   BACKUP_DATABASE_URL   the database owner's connection string (reads every row; the app's own login cannot)
#   BACKUP_PASSPHRASE     encrypts the file. Keep a copy in a password manager: without it a backup is unreadable.
#   BACKUP_DIR            where the file is written (default ./backups)
#   BACKUP_S3_BUCKET      optional. When set, the file is also uploaded to s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX
#   BACKUP_S3_PREFIX      optional folder in the bucket (default nusuh/)
#   AWS_ENDPOINT_URL      for Cloudflare R2 or Backblaze B2: their S3-compatible address
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY   the storage login (use one that can only write to this bucket)
set -euo pipefail

# A value pasted into a host's settings page often carries a hidden line break or space at the end. A database name or
# web address ending in one is a different, wrong name, so every setting is trimmed before it is used.
trim() { printf '%s' "${!1:-}" | tr -d '[:space:]'; }
for v in BACKUP_DATABASE_URL BACKUP_S3_BUCKET AWS_ENDPOINT_URL AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  if [ -n "${!v:-}" ]; then export "$v=$(trim "$v")"; fi
done
# The passphrase may hold spaces inside it, so only its ends are trimmed.
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then BACKUP_PASSPHRASE="$(printf '%s' "$BACKUP_PASSPHRASE" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"; export BACKUP_PASSPHRASE; fi

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is not set}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is not set}"
if [ "${#BACKUP_PASSPHRASE}" -lt 16 ]; then echo "BACKUP_PASSPHRASE must be at least 16 characters." >&2; exit 2; fi

dir="${BACKUP_DIR:-./backups}"
mkdir -p "$dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$dir/nusuh-$stamp.dump.gpg"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

# Custom format is compressed and lets pg_restore pick parts back. The passphrase goes in on a file descriptor, not on
# the command line, where any other process on the machine could read it.
# Only our own sections (public, and subpay: the bank-transfer payments) and the one extension our tables need are copied. On Supabase the database also holds
# the platform's own schemas (vault, auth, graphql ...): they belong to Supabase, are rebuilt by it, and cannot be restored
# anywhere else, so a copy of everything would never restore into a plain server.
pg_dump --format=custom --no-owner --schema=public --schema=subpay --extension=btree_gist --dbname="$BACKUP_DATABASE_URL" \
  | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 \
        --symmetric --cipher-algo AES256 --compress-algo none --output "$tmp" 3<<<"$BACKUP_PASSPHRASE"

# pipefail already stops on a failed dump; this catches an empty file from any other cause.
[ -s "$tmp" ] || { echo "Backup file is empty; nothing kept." >&2; exit 1; }
mv "$tmp" "$out"
echo "Backup written: $out ($(wc -c < "$out") bytes)"

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  prefix="${BACKUP_S3_PREFIX:-nusuh/}"
  aws s3 cp --only-show-errors "$out" "s3://$BACKUP_S3_BUCKET/$prefix$(basename "$out")"
  echo "Uploaded to s3://$BACKUP_S3_BUCKET/$prefix$(basename "$out")"
fi
