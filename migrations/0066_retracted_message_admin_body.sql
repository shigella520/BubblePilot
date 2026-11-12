-- Admin-only snapshot of the last archived text before a withdrawal.
-- Never queried by context, history tools, quote previews or vector indexing.
ALTER TABLE messages ADD COLUMN retracted_body TEXT;
COMMENT ON COLUMN messages.retracted_body IS 'Sensitive admin-only pre-withdrawal text; never model input or searchable evidence.';

-- Also enforce retention when an older application version clears content.
CREATE FUNCTION clear_retracted_message_body() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_redacted_at IS NOT NULL THEN NEW.retracted_body := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_clear_retracted_body
  BEFORE INSERT OR UPDATE OF content_redacted_at,retracted_body ON messages
  FOR EACH ROW EXECUTE FUNCTION clear_retracted_message_body();
