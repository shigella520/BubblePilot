-- New events opt in at ingestion; existing pending events keep their old policy.
ALTER TABLE inbound_events
  ADD COLUMN reply_wake_policy TEXT CHECK (reply_wake_policy IN ('v1')),
  ADD COLUMN reply_wake_status TEXT CHECK (reply_wake_status IN
    ('resolved', 'unmatched', 'ambiguous', 'unavailable', 'from-me', 'no-reference', 'lookup-error')),
  ADD COLUMN reply_wake_workflow_id UUID REFERENCES workflows(id) ON DELETE RESTRICT,
  ADD COLUMN reply_wake_decision TEXT CHECK (reply_wake_decision IN
    ('ordinary', 'reply', 'blocked', 'not-applicable')),
  ADD COLUMN reply_wake_result TEXT CHECK (reply_wake_result IN
    ('ordinary', 'reply', 'blocked', 'not-applicable')),
  ADD COLUMN reply_wake_trigger_id UUID REFERENCES bot_triggers(id) ON DELETE RESTRICT,
  ADD COLUMN reply_wake_workflow_version_id UUID REFERENCES workflow_versions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT reply_wake_choice_consistent CHECK (
    (reply_wake_decision='reply' AND reply_wake_trigger_id IS NOT NULL AND reply_wake_workflow_version_id IS NOT NULL)
    OR (reply_wake_decision IS DISTINCT FROM 'reply' AND reply_wake_trigger_id IS NULL AND reply_wake_workflow_version_id IS NULL)
  );

ALTER TABLE workflow_executions
  ADD COLUMN message_match_source TEXT CHECK (message_match_source IN ('ordinary', 'reply'));

CREATE INDEX outbound_delivery_pending_reply_lookup
  ON outbound_deliveries (provider, provider_chat_id, updated_at DESC)
  WHERE status IN ('pending', 'sending');
