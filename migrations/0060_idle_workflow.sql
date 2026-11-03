-- Metadata only: proactive events are not archived user messages.
ALTER TABLE workflow_executions ADD COLUMN trigger_event JSONB;
ALTER TABLE workflow_executions ADD COLUMN target_chat_id UUID REFERENCES chats(id) ON DELETE RESTRICT;
CREATE TABLE idle_settings (
 id SMALLINT PRIMARY KEY CHECK(id=1), daily_limit INTEGER NOT NULL DEFAULT 2 CHECK(daily_limit BETWEEN 1 AND 10),
 version INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO idle_settings(id) VALUES(1);
CREATE TABLE idle_chat_activity (
 chat_id UUID PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
 generation BIGINT NOT NULL DEFAULT 0, consumed_generation BIGINT NOT NULL DEFAULT 0,
 last_activity_at TIMESTAMPTZ NOT NULL, last_human_at TIMESTAMPTZ,
 last_message_index BIGINT NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE idle_attempts (
 id UUID PRIMARY KEY, chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE RESTRICT,
 generation BIGINT NOT NULL, trigger_id UUID NOT NULL REFERENCES bot_triggers(id) ON DELETE RESTRICT,
 workflow_version_id UUID NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
 execution_id UUID UNIQUE REFERENCES workflow_executions(id) ON DELETE RESTRICT,
 trigger_updated_at TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('accepted','reserved','confirmed','unknown','released')),
 workflow_day DATE, instance_day DATE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(chat_id,generation)
);
CREATE INDEX idle_attempts_quota ON idle_attempts(chat_id,instance_day,workflow_day) WHERE state IN ('reserved','confirmed','unknown');

-- Called inside live ingestion's transaction only; historical imports never call it.
CREATE FUNCTION idle_record_activity(cid UUID, idx BIGINT, at_time TIMESTAMPTZ, human BOOLEAN) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO idle_chat_activity(chat_id,generation,last_activity_at,last_human_at,last_message_index)
 VALUES(cid,CASE WHEN human THEN 1 ELSE 0 END,at_time,CASE WHEN human THEN at_time ELSE NULL END,idx)
 ON CONFLICT(chat_id) DO UPDATE SET
 generation=idle_chat_activity.generation+CASE WHEN human THEN 1 ELSE 0 END,
 last_activity_at=at_time,
 last_human_at=CASE WHEN human THEN at_time ELSE idle_chat_activity.last_human_at END,
 last_message_index=GREATEST(idx,idle_chat_activity.last_message_index),updated_at=now()
 WHERE at_time>idle_chat_activity.last_activity_at AND idx>idle_chat_activity.last_message_index;
END $$;

CREATE FUNCTION idle_confirmed_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='confirmed' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'confirmed') THEN
   UPDATE idle_chat_activity a SET last_activity_at=GREATEST(a.last_activity_at,COALESCE(NEW.confirmed_at,now())),updated_at=now()
   FROM chats c WHERE c.id=a.chat_id AND c.provider=NEW.provider AND c.provider_chat_id=NEW.provider_chat_id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER idle_delivery_activity AFTER INSERT OR UPDATE OF status ON outbound_deliveries
 FOR EACH ROW EXECUTE FUNCTION idle_confirmed_delivery();

CREATE TABLE idle_trigger_checks (
 trigger_id UUID NOT NULL REFERENCES bot_triggers(id) ON DELETE CASCADE,
 chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
 workflow_version_id UUID NOT NULL REFERENCES workflow_versions(id) ON DELETE RESTRICT,
 generation BIGINT NOT NULL, next_check_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(trigger_id,chat_id)
);
