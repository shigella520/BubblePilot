#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
BACKUP_PATH=${1:-}

cd "$PROJECT_DIR"
docker compose config >/dev/null
docker compose ps

if [ -n "$BACKUP_PATH" ]; then
  "$SCRIPT_DIR/verify-postgres-backup.sh" "$BACKUP_PATH"
else
  printf '%s\n' "Backup verification skipped: pass a .dump path to include a restore drill."
fi

"$SCRIPT_DIR/diagnose.sh"
printf '%s\n' "Preflight checks passed. Confirm the target image is an exact version or sha tag before upgrading."
