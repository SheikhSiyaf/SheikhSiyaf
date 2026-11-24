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
# Same trimming as backup.sh: a hidden line break pasted at the end of the passphrase must not change it.
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then BACKUP_PASSPHRASE="$(printf '%s' "$BACKUP_PASSPHRASE" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"; export BACKUP_PASSPHRASE; fi
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

# Supabase gives its standard logins rights on our tables, and the copy remembers them. On a server that is not Supabase
# those logins do not exist, so they are created empty (no password, no sign-in, no powers) for the rights to land on.
# On a new Supabase project they already exist and this does nothing.
# (RESTORE_PLATFORM_ROLES overrides the list, space separated; the tests use it so they do not touch shared server logins.)
for r in ${RESTORE_PLATFORM_ROLES:-anon authenticated service_role authenticator supabase_admin dashboard_user}; do
  psql "$target" -qc "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$r') THEN CREATE ROLE $r NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END \$\$;" >/dev/null
done

# Supabase keeps extensions in a schema called extensions; the copy may point at it. Harmless where it is not needed.
PGOPTIONS='-c client_min_messages=warning' psql "$target" -qc "CREATE SCHEMA IF NOT EXISTS extensions" >/dev/null

decrypt() { gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$file" 3<<<"$BACKUP_PASSPHRASE"; }

# A wrong passphrase or a damaged file must fail here, before anything is changed in the target.
decrypt > /dev/null 2>&1 || { echo "Could not open the backup (wrong passphrase or damaged file)." >&2; exit 4; }

# The copy holds a "create the public section" step, and a new database already has an empty one. The target was checked
# above to have no tables, so the empty section is removed (no CASCADE: if anything is still in it, this stops and says so)
# and the copy puts its own back, with its own rights.
psql "$target" -qc "DROP SCHEMA IF EXISTS public" >/dev/null

# Decrypt to a pipe so the readable dump never touches the disk.
decrypt | pg_restore --no-owner --exit-on-error --dbname="$target"
echo "Restored $file"
