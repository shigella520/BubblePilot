ALTER TABLE scheduled_tasks
 ADD COLUMN schedule JSONB,
 ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','paused','completed','cancelled')),
 ADD COLUMN consumed_count INTEGER NOT NULL DEFAULT 0 CHECK(consumed_count>=0),
 ADD COLUMN occurrence_sequence BIGINT NOT NULL DEFAULT 0,
 ADD COLUMN resume_after TIMESTAMPTZ;
UPDATE scheduled_tasks SET schedule=jsonb_build_object('kind','once','scheduledAt',to_char(scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 lifecycle=CASE WHEN status IN ('pending','running') THEN 'active' WHEN status='cancelled' THEN 'cancelled' ELSE 'completed' END;
ALTER TABLE scheduled_tasks ALTER COLUMN schedule SET NOT NULL;
ALTER TABLE scheduled_tasks DROP CONSTRAINT scheduled_tasks_status_check;
ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_status_check CHECK(status IN ('pending','running','sent','cancelled','expired','failed','delivery_unknown','paused','completed'));
ALTER TABLE scheduled_task_settings ADD COLUMN paused_at TIMESTAMPTZ;
UPDATE scheduled_task_settings SET paused_at=now() WHERE paused;

CREATE TABLE scheduled_task_occurrences (
 id UUID PRIMARY KEY, task_id UUID NOT NULL REFERENCES scheduled_tasks(id) ON DELETE RESTRICT,
 occurrence_number BIGINT NOT NULL, task_version INTEGER NOT NULL,
 scheduled_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 snapshot JSONB, status TEXT NOT NULL CHECK(status IN ('pending','running','sent','cancelled','expired','failed','delivery_unknown','skipped')),
 reason_code TEXT, consumed BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
 UNIQUE(task_id,occurrence_number), CHECK(expires_at>=scheduled_at)
);
ALTER TABLE scheduled_task_runs ADD COLUMN occurrence_id UUID REFERENCES scheduled_task_occurrences(id) ON DELETE RESTRICT;
INSERT INTO scheduled_task_occurrences(id,task_id,occurrence_number,task_version,scheduled_at,expires_at,snapshot,status,consumed,created_at,finished_at)
 SELECT r.id,r.task_id,row_number() OVER(PARTITION BY r.task_id ORDER BY r.accepted_at,r.id),r.task_version,
 COALESCE((r.task_snapshot->>'scheduledAt')::timestamptz,t.scheduled_at),
 greatest(t.expires_at,COALESCE((r.task_snapshot->>'scheduledAt')::timestamptz,t.scheduled_at)),r.task_snapshot,
 CASE WHEN r.outcome IN ('sent','cancelled','expired','failed','delivery_unknown') THEN r.outcome WHEN r.outcome IS NULL THEN 'running' ELSE 'failed' END,true,r.accepted_at,r.finished_at
 FROM scheduled_task_runs r JOIN scheduled_tasks t ON t.id=r.task_id;
UPDATE scheduled_task_runs SET occurrence_id=id;
UPDATE scheduled_tasks t SET occurrence_sequence=(SELECT count(*) FROM scheduled_task_occurrences o WHERE o.task_id=t.id),consumed_count=(SELECT count(*) FROM scheduled_task_occurrences o WHERE o.task_id=t.id);
-- Preserve every historical run; terminal tasks without runs also get an explainable instance.
INSERT INTO scheduled_task_occurrences(id,task_id,occurrence_number,task_version,scheduled_at,expires_at,snapshot,status,consumed,finished_at)
 SELECT gen_random_uuid(),t.id,t.occurrence_sequence+1,t.version,t.scheduled_at,t.expires_at,jsonb_build_object('content',t.content,'requestSnapshot',t.request_snapshot,'schedule',t.schedule),t.status,t.status NOT IN ('pending','running'),t.finished_at
 FROM scheduled_tasks t WHERE NOT EXISTS(SELECT 1 FROM scheduled_task_occurrences o WHERE o.task_id=t.id AND o.task_version=t.version);
UPDATE scheduled_tasks t SET occurrence_sequence=(SELECT max(o.occurrence_number) FROM scheduled_task_occurrences o WHERE o.task_id=t.id),consumed_count=(SELECT count(*) FROM scheduled_task_occurrences o WHERE o.task_id=t.id AND o.consumed);
ALTER TABLE scheduled_task_runs ALTER COLUMN occurrence_id SET NOT NULL;
ALTER TABLE scheduled_task_runs DROP CONSTRAINT scheduled_task_runs_task_id_task_version_key;
ALTER TABLE scheduled_task_runs ADD CONSTRAINT scheduled_task_runs_occurrence_unique UNIQUE(occurrence_id);
CREATE UNIQUE INDEX scheduled_occurrence_active ON scheduled_task_occurrences(task_id) WHERE status IN ('pending','running');
CREATE INDEX scheduled_occurrence_history ON scheduled_task_occurrences(task_id,occurrence_number DESC);
CREATE INDEX scheduled_task_active_due ON scheduled_tasks(scheduled_at,id) WHERE lifecycle='active';
CREATE TABLE scheduled_task_operations (
 operation_key TEXT PRIMARY KEY, task_id UUID NOT NULL REFERENCES scheduled_tasks(id), result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Configuration revocation cancels future work, but never rewrites a send already submitted.
CREATE OR REPLACE FUNCTION scheduled_tasks_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 WITH invalid AS (
 UPDATE scheduled_tasks t SET lifecycle='cancelled',status='cancelled',version=version+1,finished_at=now(),updated_at=now()
 WHERE t.lifecycle IN ('active','paused') AND NOT EXISTS(
 SELECT 1 FROM chats c JOIN workflows w ON w.id=t.workflow_id
 JOIN bot_triggers b ON b.workflow_version_id=w.published_version_id
 JOIN workflow_versions v ON v.id=b.workflow_version_id
 WHERE c.id=t.chat_id AND c.enabled AND c.deleted_at IS NULL AND w.status='active' AND w.deleted_at IS NULL
 AND b.enabled AND b.deleted_at IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.definition->'nodes') n WHERE n->>'type'='message-trigger' AND n->'config'->'scheduled'->>'enabled'='true' AND (n->'config'->'scheduled'->'chatIds') ? c.provider_chat_id))
 RETURNING id,version
 ) INSERT INTO scheduled_task_events(id,task_id,event_type,actor_type,to_version,reason_code)
 SELECT gen_random_uuid(),id,'cancelled','system',version,'task-configuration-changed' FROM invalid;
 UPDATE scheduled_task_occurrences o SET status='cancelled',reason_code='task-configuration-changed',finished_at=now()
 FROM scheduled_tasks t WHERE o.task_id=t.id AND t.lifecycle='cancelled' AND o.status IN ('pending','running')
 AND NOT EXISTS(SELECT 1 FROM scheduled_task_runs r WHERE r.occurrence_id=o.id AND r.phase='sending' AND r.outcome IS NULL);
 UPDATE workflow_executions e SET status='skipped',completed_at=now(),error_code='TASK_CONFIGURATION_CHANGED'
 FROM scheduled_task_runs r JOIN scheduled_task_occurrences o ON o.id=r.occurrence_id WHERE r.execution_id=e.id AND o.status='cancelled' AND r.outcome IS NULL AND e.status IN ('created','running','retrying');
 UPDATE scheduled_task_runs r SET outcome='cancelled',reason_code='task-configuration-changed',phase='finished',finished_at=now()
 FROM scheduled_task_occurrences o WHERE o.id=r.occurrence_id AND o.status='cancelled' AND r.outcome IS NULL;
 RETURN NEW;
END $$;
