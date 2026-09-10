#!/bin/sh
# Destructive operations below are restricted to uniquely named disposable fixture containers.
set -eu
old_name="bubblepilot-memory-old-$$"
new_name="bubblepilot-memory-new-$$"
cleanup() {
  docker rm -f -v "$old_name" "$new_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
wait_database() {
  counter=0
  until docker exec "$1" pg_isready -U fixture -d fixture >/dev/null 2>&1; do
    counter=$((counter + 1))
    if [ "$counter" -ge 60 ]; then return 1; fi
    sleep 1
  done
}
docker run -d --name "$old_name" -e POSTGRES_USER=fixture -e POSTGRES_DB=fixture -e POSTGRES_PASSWORD=fictional-ci-only postgres:16-alpine >/dev/null
wait_database "$old_name"
for migration in migrations/*.sql; do
  docker exec -i "$old_name" psql -v ON_ERROR_STOP=1 -U fixture -d fixture < "$migration" >/dev/null
done
docker exec "$old_name" psql -v ON_ERROR_STOP=1 -U fixture -d fixture -c "INSERT INTO chats(id,provider,provider_chat_id,type,enabled) VALUES('00000000-0000-4000-8000-000000000099','bluebubbles','fictional-upgrade-chat','group',false)" >/dev/null
docker run -d --name "$new_name" -e POSTGRES_USER=fixture -e POSTGRES_DB=fixture -e POSTGRES_PASSWORD=fictional-ci-only pgvector/pgvector:0.8.0-pg16 >/dev/null
wait_database "$new_name"
# Custom-format dump makes pg_restore check corruption and schema errors explicitly.
docker exec "$old_name" pg_dump -Fc -U fixture fixture | docker exec -i "$new_name" pg_restore --exit-on-error -U fixture -d fixture
docker exec "$new_name" psql -v ON_ERROR_STOP=1 -U fixture -d fixture -c "CREATE EXTENSION vector; SELECT '[1,0]'::vector <=> '[1,0]'::vector; DO \$\$ BEGIN IF NOT EXISTS(SELECT 1 FROM chats WHERE provider_chat_id='fictional-upgrade-chat') THEN RAISE EXCEPTION 'fixture missing after restore'; END IF; END \$\$;" >/dev/null
printf '%s\n' 'PostgreSQL 16 Alpine dump restored on pgvector PostgreSQL 16; fixture and vector distance verified.'
