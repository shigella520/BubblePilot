ALTER TABLE inbound_events
  ADD COLUMN automation_outcome TEXT;

UPDATE inbound_events
SET automation_outcome = CASE
  WHEN status = 'ignored' AND error_code = 'unsupported-event'
    THEN 'unsupported-event'
  WHEN status = 'ignored'
    THEN 'chat-not-monitored'
  ELSE 'not-evaluated'
END;

ALTER TABLE inbound_events
  ALTER COLUMN automation_outcome SET NOT NULL,
  ALTER COLUMN automation_outcome SET DEFAULT 'not-evaluated',
  ADD CONSTRAINT inbound_events_automation_outcome_check CHECK (
    automation_outcome IN (
      'unsupported-event',
      'chat-not-monitored',
      'evaluation-pending',
      'not-evaluated',
      'no-active-triggers',
      'no-trigger-match',
      'matched'
    )
  );

CREATE INDEX inbound_events_automation_outcome_received_at_idx
  ON inbound_events (automation_outcome, received_at DESC);
