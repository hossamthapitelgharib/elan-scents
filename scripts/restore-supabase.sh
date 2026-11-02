#!/usr/bin/env bash
set -Eeuo pipefail

: "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL to the target direct PostgreSQL connection string}"
DUMP="${1:?Usage: scripts/restore-supabase.sh backups/supabase-<timestamp>.dump}"
command -v pg_restore >/dev/null || { echo 'pg_restore is required' >&2; exit 1; }
[ -f "$DUMP" ] || { echo "dump not found: $DUMP" >&2; exit 1; }

if [ "${CONFIRM_RESTORE:-}" != "YES" ]; then
  echo 'Refusing to restore without CONFIRM_RESTORE=YES.' >&2
  echo 'This operation can overwrite database objects and data.' >&2
  exit 2
fi

SHA_FILE="${DUMP%.dump}.sha256"
if [ -f "$SHA_FILE" ]; then
  (cd "$(dirname "$DUMP")" && sha256sum -c "$(basename "$SHA_FILE")")
else
  echo "warning: checksum file not found: $SHA_FILE" >&2
fi

pg_restore "$SUPABASE_DB_URL" --clean --if-exists --no-owner --no-acl --exit-on-error "$DUMP"
printf 'restore completed from %s\n' "$DUMP"
