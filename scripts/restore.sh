#!/usr/bin/env bash
# Restores an encrypted backup (made by scripts/backup.sh) into an EMPTY database.
#
#   BACKUP_PASSPHRASE=... scripts/restore.sh <backup file> <target database url>
#
# It refuses a target that already has tables, so a restore can never overwrite live books by accident. To rehearse,
# create a new empty database and point this at it. After restoring, run `npm run db:migrate` so the nusuh_app login's
# password is set for this database.
set -euo pipefail

file="${1:?usage: restore.sh <backup file> <target database url>}"
target="${2:?usage: restore.sh <backup file> <target database url>}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is not set}"
[ -s "$file" ] || { echo "No such backup: $file" >&2; exit 2; }

existing="$(psql "$target" -Atqc "select count(*) from information_schema.tables where table_schema='public'")"
if [ "$existing" != "0" ]; then
  echo "Refusing: the target database already has $existing tables. Restore into an empty database." >&2
  exit 3
fi

# The dump grants rights to the nusuh_app login, but a role belongs to the whole server, not to one database, so it is
# not in the dump. On a new server it must exist first or the grants fail. Same definition as migration 0001: no
# superuser, and no bypass of row-level security.
psql "$target" -qc "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nusuh_app') THEN CREATE ROLE nusuh_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END \$\$;"

# Decrypt to a pipe so the readable dump never touches the disk. A wrong passphrase fails here, before anything is
# written to the target.
gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$file" 3<<<"$BACKUP_PASSPHRASE" \
  | pg_restore --no-owner --exit-on-error --dbname="$target"
echo "Restored $file"
