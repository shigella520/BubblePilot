-- Forward-only fix: existing archived reply identifiers need no rewrite.
CREATE OR REPLACE FUNCTION message_reply_preview(source_id UUID, lower_index BIGINT, upper_index BIGINT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE target public.messages%ROWTYPE;
  source public.messages%ROWTYPE;
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
  -- BlueBubbles also returns composite identifiers such as 0:0:1.
  -- Match the complete numeric form, not a prefix or the first character.
  -- Only text part 0 is supported; preserve the supplier identifier verbatim.
  -- Suffix fields are not interpreted as text offsets or attachment positions.
  IF target.revision_state IN ('partial','unresolved') OR NOT COALESCE(source.reply_part ~ '^0(:[0-9]+:[0-9]+)?$', false)
    OR target.attachments <> '[]'::jsonb THEN
    RETURN jsonb_build_object('status','unresolved','message_id',target.provider_message_id);
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('status','available',
    'message_id',target.provider_message_id,'archive_id',target.id,'message_index',target.message_index,
    'sender_id',target.sender_id,'author',bot_message_author(target.id),'part_id',source.reply_part,
    'text_preview',left(target.body,400),'truncated',CASE WHEN target.body IS NULL THEN NULL ELSE length(target.body)>400 END));
END $$;

