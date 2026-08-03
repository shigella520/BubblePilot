#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf '%s\n' "Usage: scripts/verify-postgres-backup.sh <backup.dump>" >&2
  exit 2
fi

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
BACKUP_PATH=$1
RESTORE_DATABASE="bubblepilot_restore_check_$(date -u +%Y%m%d%H%M%S)_$$"

case "$BACKUP_PATH" in
  /*) ;;
  *) BACKUP_PATH="$(pwd)/$BACKUP_PATH" ;;
esac

case "$RESTORE_DATABASE" in
  bubblepilot_restore_check_[0-9]*) ;;
  *)
    printf '%s\n' "Unsafe restore database name." >&2
    exit 1
    ;;
esac

if [ ! -f "$BACKUP_PATH" ] || [ ! -s "$BACKUP_PATH" ]; then
  printf '%s\n' "Backup file is missing or empty: $BACKUP_PATH" >&2
  exit 1
fi

CHECKSUM_PATH="$BACKUP_PATH.sha256"
if [ ! -f "$CHECKSUM_PATH" ] || [ ! -s "$CHECKSUM_PATH" ]; then
  printf '%s\n' "Backup checksum is missing or empty: $CHECKSUM_PATH" >&2
  exit 1
fi

EXPECTED_CHECKSUM=$(awk 'NR == 1 { print $1 }' "$CHECKSUM_PATH")
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_CHECKSUM=$(sha256sum "$BACKUP_PATH" | awk '{ print $1 }')
else
  ACTUAL_CHECKSUM=$(shasum -a 256 "$BACKUP_PATH" | awk '{ print $1 }')
fi
if [ -z "$EXPECTED_CHECKSUM" ] || [ "$EXPECTED_CHECKSUM" != "$ACTUAL_CHECKSUM" ]; then
  printf '%s\n' "Backup checksum verification failed: $BACKUP_PATH" >&2
  exit 1
fi

cd "$PROJECT_DIR"
docker compose config >/dev/null

cleanup() {
  docker compose exec -T postgres sh -c \
    'dropdb --if-exists -U "$POSTGRES_USER" "$1"' -- "$RESTORE_DATABASE" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker compose exec -T postgres sh -c \
  'createdb -U "$POSTGRES_USER" "$1"' -- "$RESTORE_DATABASE"
docker compose exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --no-privileges' \
  -- "$RESTORE_DATABASE" <"$BACKUP_PATH"
docker compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -c "SELECT name, applied_at FROM schema_migrations ORDER BY name;"' \
  -- "$RESTORE_DATABASE"
REQUIRED_TABLES=$(docker compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -At -U "$POSTGRES_USER" -d "$1" -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '\''public'\'' AND table_name IN ('\''messages'\'', '\''workflow_executions'\'', '\''ai_providers'\'', '\''admin_sessions'\'', '\''data_export_jobs'\'');"' \
  -- "$RESTORE_DATABASE")

if [ "$REQUIRED_TABLES" -ne 5 ]; then
  printf '%s\n' "Restore verification failed: required tables are missing." >&2
  exit 1
fi

printf '%s\n' "Backup restored and queried successfully in $RESTORE_DATABASE."
