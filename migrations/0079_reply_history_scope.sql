-- Quote previews follow the chat's history read scope and describe quoted
-- attachments. Function replacement only; no table or data changes.

-- Long-term history access for a chat: global memory enabled and the chat
-- authorized. Same predicate the attachment history authorization uses.
CREATE OR REPLACE FUNCTION chat_history_authorized(target_chat UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM public.memory_settings WHERE enabled)
     AND EXISTS(SELECT 1 FROM public.memory_chats WHERE chat_id=target_chat AND enabled)
$$;

CREATE OR REPLACE FUNCTION message_reply_preview(source_id UUID, lower_index BIGINT, upper_index BIGINT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE target public.messages%ROWTYPE;
  source public.messages%ROWTYPE;
  text_part BOOLEAN;
  files JSONB;
BEGIN
  SELECT * INTO source FROM public.messages WHERE id=source_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF source.reply_target_guid IS NULL THEN RETURN NULL; END IF;
  IF source.content_redacted_at IS NOT NULL OR source.revision_state IN ('retracted','unresolved') THEN
    RETURN jsonb_build_object('status','unavailable');
  END IF;
  SELECT m.* INTO target FROM public.messages m JOIN public.chats c ON c.id=m.chat_id
    WHERE m.provider=source.provider AND m.provider_message_id=source.reply_target_guid
    AND m.chat_id=source.chat_id AND c.enabled AND c.deleted_at IS NULL
    AND m.message_index>lower_index AND m.message_index<upper_index
    AND m.content_redacted_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  IF target.revision_state='retracted' THEN
    RETURN jsonb_build_object('status','retracted','message_id',target.provider_message_id);
  END IF;
  IF target.revision_state IN ('partial','unresolved') THEN
    RETURN jsonb_build_object('status','unresolved','message_id',target.provider_message_id);
  END IF;
  -- BlueBubbles also returns composite identifiers such as 0:0:1.
  -- Match the complete numeric form, not a prefix or the first character.
  -- Only text part 0 maps to the body; the supplier identifier is preserved
  -- verbatim and suffix fields are not interpreted as offsets or positions.
  text_part := COALESCE(source.reply_part ~ '^0(:[0-9]+:[0-9]+)?$', false);
  IF target.attachments <> '[]'::jsonb THEN
    -- Message-level attachment metadata only (no gateway identifiers). Which
    -- attachment a non-text part points at is not guessed.
    SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'index', ord - 1,
             'file_name', left(a->>'fileName', 200),
             'mime_type', a->>'mimeType')) ORDER BY ord)
      INTO files
      FROM jsonb_array_elements(target.attachments) WITH ORDINALITY AS x(a, ord)
      WHERE ord <= 10;
  ELSIF NOT text_part THEN
    RETURN jsonb_build_object('status','unresolved','message_id',target.provider_message_id);
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('status','available',
    'message_id',target.provider_message_id,'archive_id',target.id,'message_index',target.message_index,
    'sender_id',target.sender_id,'author',bot_message_author(target.id),'part_id',source.reply_part,
    'sent_at',target.sent_at,
    'text_preview',CASE WHEN text_part THEN left(target.body,400) END,
    'truncated',CASE WHEN text_part AND target.body IS NOT NULL THEN length(target.body)>400 END,
    'attachments',files,
    'attachment_count',CASE WHEN files IS NOT NULL THEN jsonb_array_length(target.attachments) END));
END $$;
