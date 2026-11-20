-- Existing executions retain their original arrival-order boundary. Only newly
-- created executions opt in; the pending marker contains no message content.
ALTER TABLE workflow_executions ADD COLUMN history_boundary JSONB;
ALTER TABLE workflow_executions ALTER COLUMN history_boundary
  SET DEFAULT '{"contract":"sent-time-v1"}'::jsonb;

-- Acquire the chat lock before the execution lock, matching archive ingestion.
-- next_message_index is transactional: all earlier allocations are committed
-- before this lock is obtained. No network operation runs in this transaction.
CREATE FUNCTION freeze_execution_history(execution UUID) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE boundary JSONB; chat UUID; upper_bound BIGINT; trigger_row public.messages%ROWTYPE;
BEGIN
  SELECT e.history_boundary,m.chat_id INTO boundary,chat
    FROM public.workflow_executions e JOIN public.messages m ON m.id=e.source_message_id
    WHERE e.id=execution;
  IF boundary IS NULL OR boundary ? 'upperIndex' THEN RETURN boundary; END IF;
  SELECT next_message_index INTO upper_bound FROM public.chats
    WHERE id=chat AND enabled AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'History chat unavailable'; END IF;
  SELECT history_boundary INTO boundary FROM public.workflow_executions WHERE id=execution FOR UPDATE;
  IF boundary ? 'upperIndex' THEN RETURN boundary; END IF;
  SELECT m.* INTO trigger_row FROM public.messages m JOIN public.workflow_executions e ON e.source_message_id=m.id
    WHERE e.id=execution AND m.content_redacted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'History trigger unavailable'; END IF;
  boundary := jsonb_build_object('contract','sent-time-v1','upperIndex',upper_bound::text,
    'triggerIndex',trigger_row.message_index::text,
    'beforeSentAt',to_char(trigger_row.sent_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  UPDATE public.workflow_executions SET history_boundary=boundary WHERE id=execution;
  RETURN boundary;
END $$;

-- Shared by raw history, statistical queries, retrieval and attachment access.
-- Equal timestamps use the stable arrival index; the trigger is never history.
CREATE FUNCTION execution_history_allows(execution UUID, message UUID, include_current BOOLEAN DEFAULT false)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN execution IS NULL THEN true ELSE EXISTS(
    SELECT 1 FROM public.workflow_executions e
    JOIN public.messages m ON m.id=message
    LEFT JOIN public.messages t ON t.id=e.source_message_id
    WHERE e.id=execution AND (
      (t.id IS NOT NULL AND t.chat_id=m.chat_id AND t.provider=m.provider AND (
        (include_current AND m.id=t.id) OR
        CASE WHEN e.history_boundary ? 'upperIndex' THEN
          m.message_index < (e.history_boundary->>'upperIndex')::bigint
          AND (m.sent_at,m.message_index) < ((e.history_boundary->>'beforeSentAt')::timestamptz,(e.history_boundary->>'triggerIndex')::bigint)
        ELSE m.message_index<t.message_index END))
      OR (t.id IS NULL AND e.target_chat_id=m.chat_id
        AND e.trigger_event->>'schemaVersion' IN ('chat-idle-v1','scheduled-task-v1','scheduled-task-v2')
        AND m.message_index<(COALESCE(e.trigger_event->'idle'->>'upperMessageIndex',e.trigger_event->'scheduled'->>'upperMessageIndex'))::bigint)
    )
  ) END
$$;

CREATE FUNCTION execution_reply_preview(source UUID, execution UUID, lower_bound BIGINT, upper_bound BIGINT, window_only BOOLEAN DEFAULT false)
RETURNS JSONB LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM public.messages s JOIN public.messages t
      ON t.chat_id=s.chat_id AND t.provider=s.provider AND t.provider_message_id=s.reply_target_guid
    WHERE s.id=source AND (NOT execution_history_allows(execution,t.id)
      OR (EXISTS(SELECT 1 FROM public.workflow_executions e WHERE e.id=execution AND e.history_boundary ? 'upperIndex')
        AND (t.sent_at,t.message_index)>=(s.sent_at,s.message_index))
      OR (window_only AND NOT EXISTS(SELECT 1 FROM public.workflow_executions e WHERE e.id=execution
        AND (e.history_boundary->'window'->'messageIds') ? t.id::text)))
  ) THEN '{"status":"unavailable"}'::jsonb
  ELSE message_reply_preview(source,lower_bound,CASE WHEN EXISTS(
    SELECT 1 FROM public.workflow_executions e WHERE e.id=execution AND e.history_boundary ? 'upperIndex'
  ) THEN upper_bound ELSE LEAST(upper_bound,(SELECT message_index FROM public.messages WHERE id=source)) END) END
$$;
