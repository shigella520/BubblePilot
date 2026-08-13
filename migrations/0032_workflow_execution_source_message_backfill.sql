UPDATE workflow_executions execution
SET source_message_id = source_message.id
FROM inbound_events source_event
INNER JOIN messages source_message ON source_message.source_event_id = source_event.id
WHERE execution.source_message_id IS NULL
  AND source_event.provider = execution.provider
  AND source_event.external_event_id = execution.external_event_id;
