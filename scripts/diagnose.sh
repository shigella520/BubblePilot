#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
BASE_URL=${BUBBLEPILOT_BASE_URL:-http://127.0.0.1:8080}

cd "$PROJECT_DIR"

docker compose config >/dev/null
docker compose ps
curl --fail --silent --show-error "$BASE_URL/health/live"
printf '\n'
curl --fail --silent --show-error "$BASE_URL/health/ready"
printf '\n'

if [ -n "${BUBBLEPILOT_API_ACCESS_TOKEN:-}" ]; then
  curl --fail --silent --show-error \
    -H "Authorization: Bearer $BUBBLEPILOT_API_ACCESS_TOKEN" \
    "$BASE_URL/api/v1/operations/status"
  printf '\n'
else
  printf '%s\n' "Runtime summary skipped: set BUBBLEPILOT_API_ACCESS_TOKEN to query it."
fi
