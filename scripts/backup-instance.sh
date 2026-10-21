#!/bin/sh
# Consistent database + mounted assets backup. Secrets stay in the protected deployment config.
set -eu
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
cd "$PROJECT_DIR"
umask 077
BACKUP_ROOT=${1:-"$PROJECT_DIR/backups"}
BACKUP_SET="$BACKUP_ROOT/instance-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_SET"
RUNNING=$(docker compose ps --status running -q app)
resume() { if [ -n "$RUNNING" ]; then docker compose start app >/dev/null; fi; }
trap resume EXIT
trap 'exit 130' INT TERM
docker compose stop app
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACKUP_SET/database.dump"
docker compose run --rm --no-deps -T --entrypoint tar app -C /app/data -cf - memes plugins > "$BACKUP_SET/data.tar"
docker compose run --rm --no-deps -T --entrypoint sh app -c 'cd /app/data && find memes plugins -type f -exec sha256sum {} \;' > "$BACKUP_SET/files.sha256"
[ -s "$BACKUP_SET/database.dump" ] && [ -s "$BACKUP_SET/data.tar" ]
(cd "$BACKUP_SET" && if command -v sha256sum >/dev/null 2>&1; then sha256sum database.dump data.tar files.sha256; else shasum -a 256 database.dump data.tar files.sha256; fi) > "$BACKUP_SET/SHA256SUMS"
printf '%s\n' 'Restore database.dump and data.tar together with the original SETTINGS_ENCRYPTION_KEY. Verify files.sha256 in /app/data before starting the app.' > "$BACKUP_SET/RESTORE.txt"
printf '%s\n' "$BACKUP_SET"
