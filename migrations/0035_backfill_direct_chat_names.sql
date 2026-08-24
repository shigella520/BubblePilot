UPDATE chats
SET display_name = split_part(provider_chat_id, ';', 3)
WHERE provider = 'bluebubbles'
  AND type = 'direct'
  AND display_name IS NULL
  AND split_part(provider_chat_id, ';', 3) <> '';
