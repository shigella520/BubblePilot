#!/bin/sh
# Destructive operations below are restricted to uniquely named disposable fixture containers.
set -eu
old_name="bubblepilot-memory-old-$$"
new_name="bubblepilot-memory-new-$$"
dump_path=$(mktemp "${TMPDIR:-/tmp}/bubblepilot-memory-upgrade.XXXXXX")
cleanup() {
  docker rm -f -v "$old_name" "$new_name" >/dev/null 2>&1 || true
  rm -f "$dump_path"
}
trap cleanup EXIT HUP INT TERM
wait_database() {
  counter=0
  until docker exec "$1" pg_isready -h 127.0.0.1 -U fixture -d fixture >/dev/null 2>&1; do
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
# Fictional recurring definition and instance must survive with exact schedule/counts.
docker exec -i "$old_name" psql -v ON_ERROR_STOP=1 -U fixture -d fixture >/dev/null <<'SQL'
INSERT INTO scheduled_task_deletions(task_id,creation_key,version,reason) VALUES('00000000-0000-4000-8000-000000000095','fictional-deleted-task-create',3,'manual');
INSERT INTO workflows(id,name,status) VALUES('00000000-0000-4000-8000-000000000098','fictional reminder workflow','draft');
INSERT INTO scheduled_tasks(id,chat_id,workflow_id,creator_sender_id,scheduled_at,expires_at,timezone,creation_key,schedule,consumed_count)
VALUES('00000000-0000-4000-8000-000000000097','00000000-0000-4000-8000-000000000099','00000000-0000-4000-8000-000000000098','fictional-member','2030-06-01T09:00:00Z','2030-06-01T09:30:00Z','UTC','fictional-recurring-restore','{"kind":"recurring","startsAt":"2030-06-01T09:00:00Z","rule":{"type":"daily","localTime":"09:00"},"end":{"kind":"count","count":12}}',2);
INSERT INTO scheduled_task_occurrences(id,task_id,occurrence_number,task_version,scheduled_at,expires_at,status)
VALUES('00000000-0000-4000-8000-000000000096','00000000-0000-4000-8000-000000000097',3,1,'2030-06-01T09:00:00Z','2030-06-01T09:30:00Z','pending');
SQL
docker run -d --name "$new_name" -e POSTGRES_USER=fixture -e POSTGRES_DB=fixture -e POSTGRES_PASSWORD=fictional-ci-only pgvector/pgvector:0.8.0-pg16 >/dev/null
wait_database "$new_name"
# Custom-format dump makes pg_restore check corruption and schema errors explicitly.
docker exec "$old_name" pg_dump -Fc --exclude-table-data=scheduled_task_restore_guard -U fixture fixture > "$dump_path"
docker exec -i "$new_name" pg_restore --exit-on-error -U fixture -d fixture < "$dump_path"
docker exec "$new_name" psql -v ON_ERROR_STOP=1 -U fixture -d fixture -c "CREATE EXTENSION vector; SELECT '[1,0]'::vector <=> '[1,0]'::vector; DO \$\$ BEGIN IF NOT EXISTS(SELECT 1 FROM chats WHERE provider_chat_id='fictional-upgrade-chat') THEN RAISE EXCEPTION 'fixture missing after restore'; END IF; END \$\$;" >/dev/null
docker exec -i "$new_name" psql -v ON_ERROR_STOP=1 -U fixture -d fixture >/dev/null <<'SQL'
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM scheduled_tasks t JOIN scheduled_task_occurrences o ON o.task_id=t.id WHERE t.creation_key='fictional-recurring-restore' AND t.schedule->>'kind'='recurring' AND t.consumed_count=2 AND o.occurrence_number=3 AND o.status='pending') THEN RAISE EXCEPTION 'recurring fixture missing after restore'; END IF;
 IF NOT EXISTS(SELECT 1 FROM scheduled_task_deletions WHERE creation_key='fictional-deleted-task-create' AND version=3) THEN RAISE EXCEPTION 'deleted task idempotency marker missing after restore'; END IF;
 IF EXISTS(SELECT 1 FROM scheduled_task_restore_guard) THEN RAISE EXCEPTION 'restore guard must not survive backup'; END IF;
END $$;
SQL
printf '%s\n' 'PostgreSQL 16 Alpine dump restored on pgvector PostgreSQL 16; fixture, recurring definition/instance, deleted-task tombstone, restore guard and vector distance verified.'
