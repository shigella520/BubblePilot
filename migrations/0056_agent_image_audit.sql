-- Nullable: old records have no reconstructable image association.
ALTER TABLE ai_image_inputs ADD COLUMN diagnostics jsonb;
ALTER TABLE ai_provider_attempts ADD COLUMN image_inputs jsonb;
