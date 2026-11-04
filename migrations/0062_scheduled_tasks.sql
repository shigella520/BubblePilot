CREATE TABLE scheduled_task_settings (
 id SMALLINT PRIMARY KEY CHECK(id=1), paused BOOLEAN NOT NULL DEFAULT false,
 pending_limit INTEGER NOT NULL DEFAULT 1000 CHECK(pending_limit BETWEEN 1 AND 10000),
 catchup_minutes INTEGER NOT NULL DEFAULT 30 CHECK(catchup_minutes BETWEEN 0 AND 1440),
 version INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO scheduled_task_settings(id) VALUES(1);
-- Only this disposable marker is omitted from supported backups. Settings remain intact.
CREATE TABLE scheduled_task_restore_guard (id SMALLINT PRIMARY KEY CHECK(id=1));
INSERT INTO scheduled_task_restore_guard(id) VALUES(1);
CREATE TABLE scheduled_tasks (
 id UUID PRIMARY KEY, chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE RESTRICT,
 workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT,
 creator_sender_id TEXT NOT NULL,
 source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
 source_execution_id UUID REFERENCES workflow_executions(id) ON DELETE SET NULL,
 request_snapshot TEXT, content TEXT,
 scheduled_at TIMESTAMPTZ NOT NULL, timezone TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','sent','cancelled','expired','failed','delivery_unknown')),
 version INTEGER NOT NULL DEFAULT 1, creation_key TEXT NOT NULL UNIQUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
 CHECK(expires_at>=scheduled_at)
);
CREATE INDEX scheduled_tasks_due ON scheduled_tasks(scheduled_at,id) WHERE status='pending';
CREATE INDEX scheduled_tasks_chat ON scheduled_tasks(chat_id,status,scheduled_at);
CREATE INDEX scheduled_tasks_owner ON scheduled_tasks(chat_id,creator_sender_id,status);
CREATE INDEX scheduled_tasks_workflow ON scheduled_tasks(workflow_id,status);
CREATE TABLE scheduled_task_runs (
 id UUID PRIMARY KEY, task_id UUID NOT NULL REFERENCES scheduled_tasks(id) ON DELETE RESTRICT,
 task_version INTEGER NOT NULL, execution_id UUID NOT NULL UNIQUE REFERENCES workflow_executions(id) ON DELETE RESTRICT,
 workflow_version_id UUID NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
 task_snapshot JSONB, history_boundary BIGINT NOT NULL,
 phase TEXT NOT NULL DEFAULT 'queued' CHECK(phase IN ('queued','generating','ready','sending','finished')),
 lease_owner UUID NOT NULL, lease_expires_at TIMESTAMPTZ NOT NULL, lease_generation INTEGER NOT NULL DEFAULT 1,
 generation_mode TEXT CHECK(generation_mode IN ('model','fallback')),
 outcome TEXT, reason_code TEXT, accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
 UNIQUE(task_id,task_version)
);
CREATE INDEX scheduled_task_runs_recover ON scheduled_task_runs(lease_expires_at) WHERE outcome IS NULL;
CREATE TABLE scheduled_task_events (
 id UUID PRIMARY KEY, task_id UUID NOT NULL REFERENCES scheduled_tasks(id) ON DELETE RESTRICT,
 event_type TEXT NOT NULL, actor_type TEXT NOT NULL CHECK(actor_type IN ('member','admin','system')),
 actor_id TEXT, source_execution_id UUID REFERENCES workflow_executions(id) ON DELETE SET NULL,
 from_version INTEGER, to_version INTEGER NOT NULL, change_data JSONB,
 reason_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_task_events_history ON scheduled_task_events(task_id,created_at,id);

-- Revoke pending/running work transactionally with configuration changes. A send
-- already fenced cannot be retracted; it retains its outcome for reconciliation.
CREATE FUNCTION scheduled_tasks_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 WITH invalid AS (
  UPDATE scheduled_tasks t SET status='cancelled',version=version+1,finished_at=now(),updated_at=now()
  WHERE t.status IN ('pending','running')
  AND NOT EXISTS(SELECT 1 FROM scheduled_task_runs r WHERE r.task_id=t.id AND r.phase='sending' AND r.outcome IS NULL)
  AND (NOT EXISTS(
   SELECT 1 FROM chats c JOIN workflows w ON w.id=t.workflow_id
   JOIN bot_triggers b ON b.workflow_version_id=w.published_version_id
   JOIN workflow_versions v ON v.id=b.workflow_version_id
   WHERE c.id=t.chat_id AND c.enabled AND c.deleted_at IS NULL AND w.status='active' AND w.deleted_at IS NULL
   AND b.enabled AND b.deleted_at IS NULL
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.definition->'nodes') n WHERE n->>'type'='message-trigger' AND n->'config'->'scheduled'->>'enabled'='true' AND (n->'config'->'scheduled'->'chatIds') ? c.provider_chat_id))
   OR (t.status='running' AND EXISTS(SELECT 1 FROM scheduled_task_runs r JOIN workflows w ON w.id=t.workflow_id WHERE r.task_id=t.id AND r.outcome IS NULL AND r.workflow_version_id<>w.published_version_id)))
  RETURNING id,version
 ) INSERT INTO scheduled_task_events(id,task_id,event_type,actor_type,to_version,reason_code)
 SELECT gen_random_uuid(),id,'cancelled','system',version,'task-configuration-changed' FROM invalid;
 UPDATE scheduled_task_runs r SET outcome='cancelled',reason_code='task-configuration-changed',phase='finished',finished_at=now()
 FROM scheduled_tasks t WHERE t.id=r.task_id AND t.status='cancelled' AND r.outcome IS NULL;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER scheduled_revoke_chat AFTER UPDATE ON chats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.enabled IS DISTINCT FROM NEW.enabled OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at) EXECUTE FUNCTION scheduled_tasks_revoke();
CREATE CONSTRAINT TRIGGER scheduled_revoke_workflow AFTER UPDATE ON workflows DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.published_version_id IS DISTINCT FROM NEW.published_version_id OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at) EXECUTE FUNCTION scheduled_tasks_revoke();
CREATE CONSTRAINT TRIGGER scheduled_revoke_trigger AFTER UPDATE ON bot_triggers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.enabled IS DISTINCT FROM NEW.enabled OR OLD.workflow_version_id IS DISTINCT FROM NEW.workflow_version_id OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at) EXECUTE FUNCTION scheduled_tasks_revoke();

CREATE FUNCTION scheduled_binding_unique() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('scheduled-task-bindings',0));
 IF EXISTS(SELECT chat_id FROM (
   SELECT DISTINCT w.id AS workflow_id,jsonb_array_elements_text(n->'config'->'scheduled'->'chatIds') AS chat_id
   FROM workflows w JOIN workflow_versions v ON v.id=w.published_version_id,
   LATERAL jsonb_array_elements(v.definition->'nodes') n
   WHERE w.status='active' AND w.deleted_at IS NULL AND n->>'type'='message-trigger'
   AND n->'config'->'scheduled'->>'enabled'='true'
 ) bindings GROUP BY chat_id HAVING count(*)>1) THEN
  RAISE EXCEPTION 'TASK_CHAT_WORKFLOW_CONFLICT' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER scheduled_binding_check AFTER INSERT OR UPDATE ON workflows DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION scheduled_binding_unique();
