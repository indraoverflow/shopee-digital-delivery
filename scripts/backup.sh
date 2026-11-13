#!/usr/bin/env bash
# Nightly-shaped backup for the compose stack: database dump, uploads volume and
# the two key files that make the dump readable again.
#
# The dump alone is not a backup: Shopee tokens, activation codes and TOTP secrets
# are encrypted with APP_ENCRYPTION_KEY, so a restore without that key gives you a
# database full of unreadable rows. The script copies .env next to the dump and says
# so out loud, because the copy itself belongs in a password manager, not on the
# same disk as the dump it protects.
#
# Usage:  scripts/backup.sh [destination-dir]
# Restore: docs/deployment.md#backups
set -euo pipefail

cd "$(dirname "$0")/.."

DEST="${1:-./backups}"
KEEP="${KEEP_BACKUPS:-7}"
STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
PROJECT="${COMPOSE_PROJECT_NAME:-qansa-delivery}"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

DB_NAME="${POSTGRES_DB:-qansa_delivery}"
DB_USER="${POSTGRES_USER:-qansa}"

mkdir -p "$DEST"
DUMP="$DEST/qansa-$STAMP.dump"
UPLOADS="$DEST/qansa-uploads-$STAMP.tar.gz"

say() { printf '%-14s %s\n' "$1" "$2"; }

say "project" "$PROJECT"
say "database" "$DB_NAME"
say "destination" "$DEST"

# 1. Database, custom format so a single table can be restored later.
if ! docker compose exec -T postgres pg_dump -U "$DB_USER" -Fc "$DB_NAME" >"$DUMP"; then
  say "FAILED" "pg_dump could not read $DB_NAME"
  rm -f "$DUMP"
  exit 1
fi
say "dump" "$(du -h "$DUMP" | cut -f1) $DUMP"

# 2. Prove the dump is readable before calling it a backup.
if ! docker compose exec -T postgres pg_restore --list <"$DUMP" >/dev/null; then
  say "FAILED" "the dump cannot be listed by pg_restore, treating it as corrupt"
  exit 1
fi
TABLES="$(docker compose exec -T postgres pg_restore --list <"$DUMP" | grep -c 'TABLE DATA' || true)"
say "verified" "$TABLES tables of data, restorable"

# 3. Uploaded files (FILE deliveries). An empty volume is not an error.
if docker volume inspect "${PROJECT}_uploads" >/dev/null 2>&1; then
  docker run --rm -v "${PROJECT}_uploads:/data:ro" -v "$(cd "$DEST" && pwd):/backup" alpine \
    tar czf "/backup/$(basename "$UPLOADS")" -C /data . 2>/dev/null
  say "uploads" "$(du -h "$UPLOADS" | cut -f1) $UPLOADS"
else
  say "uploads" "volume ${PROJECT}_uploads not found, skipped"
fi

# 4. The key file, without which the dump is noise. Copied, then pointed at.
if [[ -f .env ]]; then
  cp .env "$DEST/qansa-$STAMP.env"
  chmod 600 "$DEST/qansa-$STAMP.env"
  say "keys" "$DEST/qansa-$STAMP.env (move it to a password manager, not to the same backup disk)"
fi

# 5. Prune, oldest first, keeping $KEEP complete sets.
mapfile -t OLD < <(ls -1t "$DEST"/qansa-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) || true)
for file in "${OLD[@]:-}"; do
  [[ -z "$file" ]] && continue
  base="${file%.dump}"
  rm -f "$file" "$DEST/$(basename "$base")-uploads"*.tar.gz "$base.env"
  say "pruned" "$(basename "$file")"
done

say "done" "restore with: docs/deployment.md#backups"
