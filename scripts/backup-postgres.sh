#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
BACKUP_DIR=${1:-"$PROJECT_DIR/backups"}
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_PATH="$BACKUP_DIR/bubblepilot-$TIMESTAMP.dump"

cd "$PROJECT_DIR"
umask 077
mkdir -p "$BACKUP_DIR"
docker compose config >/dev/null
docker compose exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$BACKUP_PATH"

if [ ! -s "$BACKUP_PATH" ]; then
  printf '%s\n' "Backup is empty: $BACKUP_PATH" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$BACKUP_PATH" >"$BACKUP_PATH.sha256"
else
  shasum -a 256 "$BACKUP_PATH" >"$BACKUP_PATH.sha256"
fi

printf '%s\n' "$BACKUP_PATH"
