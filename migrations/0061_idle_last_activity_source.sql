-- Existing activity is deliberately unknown: upgrades never grant idle eligibility.
ALTER TABLE idle_chat_activity ADD COLUMN last_activity_source TEXT NOT NULL DEFAULT 'unknown'
 CHECK (last_activity_source IN ('human','bot','unknown'));

CREATE OR REPLACE FUNCTION idle_record_activity(cid UUID, idx BIGINT, at_time TIMESTAMPTZ, human BOOLEAN) RETURNS void LANGUAGE plpgsql AS $$
DECLARE source TEXT;
BEGIN
 source := CASE WHEN human THEN 'human' ELSE 'unknown' END;
 IF NOT human AND EXISTS (
   SELECT 1 FROM messages m JOIN chats c ON c.id=m.chat_id
   JOIN outbound_deliveries d ON d.provider=c.provider AND d.provider_chat_id=c.provider_chat_id
     AND d.provider_message_id=m.provider_message_id
   WHERE m.chat_id=cid AND m.message_index=idx
 ) THEN source := 'bot'; END IF;
 INSERT INTO idle_chat_activity(chat_id,generation,last_activity_at,last_human_at,last_message_index,last_activity_source)
 VALUES(cid,CASE WHEN human THEN 1 ELSE 0 END,at_time,CASE WHEN human THEN at_time ELSE NULL END,idx,source)
 ON CONFLICT(chat_id) DO UPDATE SET
 generation=idle_chat_activity.generation+CASE WHEN human THEN 1 ELSE 0 END,
 last_activity_at=at_time,
 last_human_at=CASE WHEN human THEN at_time ELSE idle_chat_activity.last_human_at END,
 last_message_index=idx,last_activity_source=source,updated_at=now()
 WHERE at_time>=idle_chat_activity.last_activity_at AND idx>idle_chat_activity.last_message_index;
END $$;

CREATE OR REPLACE FUNCTION idle_confirmed_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sent_time TIMESTAMPTZ;
BEGIN
 IF NEW.status='confirmed' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'confirmed') THEN
   -- Prefer the actual archived send time. Without it, use the attempt creation
   -- boundary rather than a late acknowledgement to overwrite newer human activity.
   SELECT m.sent_at INTO sent_time FROM messages m JOIN chats c ON c.id=m.chat_id
   WHERE c.provider=NEW.provider AND c.provider_chat_id=NEW.provider_chat_id
     AND m.provider_message_id=NEW.provider_message_id LIMIT 1;
   sent_time := COALESCE(sent_time,NEW.created_at);
   UPDATE idle_chat_activity a SET last_activity_at=GREATEST(a.last_activity_at,sent_time),
     last_activity_source='bot',updated_at=now()
   FROM chats c WHERE c.id=a.chat_id AND c.provider=NEW.provider AND c.provider_chat_id=NEW.provider_chat_id
     AND a.last_activity_at<=sent_time;
 END IF;
 RETURN NEW;
END $$;
