#!/usr/bin/env bash
set -Eeuo pipefail

: "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL to the direct PostgreSQL connection string}"
OUT_DIR="${1:-backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="$OUT_DIR/supabase-$STAMP"

command -v pg_dump >/dev/null || { echo 'pg_dump is required' >&2; exit 1; }
pg_dump "$SUPABASE_DB_URL" --format=custom --file="$BASE.dump" --no-owner --no-acl
pg_restore --list "$BASE.dump" > "$BASE.manifest"
sha256sum "$BASE.dump" > "$BASE.sha256"
cat > "$BASE.json" <<EOF
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "format": "postgres-custom",
  "dump": "$(basename "$BASE.dump")",
  "manifest": "$(basename "$BASE.manifest")",
  "sha256": "$(basename "$BASE.sha256")",
  "restoreCommand": "scripts/restore-supabase.sh $(basename "$BASE.dump")"
}
EOF
printf 'backup created: %s.dump\n' "$BASE"
