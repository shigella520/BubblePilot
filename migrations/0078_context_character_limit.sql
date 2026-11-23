-- Expand the configurable budget without changing saved settings or snapshots.
ALTER TABLE conversation_context_settings
  DROP CONSTRAINT conversation_context_settings_character_limit_check,
  ADD CONSTRAINT conversation_context_settings_character_limit_check
    CHECK (character_limit BETWEEN 100 AND 60000);
