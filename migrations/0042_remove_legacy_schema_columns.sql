-- Preserve the old workflow/node/execution ownership as immutable operation
-- metadata before removing columns that no longer belong to the chat-level
-- summary model. No message or summary body is copied into this event.
INSERT INTO conversation_context_compression_events (
  id, compression_id, status, error_code, metadata
)
SELECT gen_random_uuid(), operation.id, operation.status, NULL,
       jsonb_strip_nulls(jsonb_build_object(
         'source', 'legacy-origin',
         'workflowId', state.workflow_id,
         'nodeId', state.node_id,
         'executionId', operation.execution_id
       ))
FROM conversation_context_compressions operation
INNER JOIN conversation_context_states state
  ON state.id = operation.context_state_id
WHERE (state.workflow_id IS NOT NULL
       OR state.node_id IS NOT NULL
       OR operation.execution_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1
    FROM conversation_context_compression_events existing
    WHERE existing.compression_id = operation.id
      AND existing.metadata->>'source' = 'legacy-origin'
  );

-- These settings were copied to their replacement fields in 0039. Runtime
-- code has exclusively used the new message-window names since then.
ALTER TABLE conversation_summary_settings
  DROP COLUMN IF EXISTS message_limit,
  DROP COLUMN IF EXISTS compression_batch_size;

-- The search runtime uses a bounded timeout per attempt. The aggregate timeout
-- was retained only to satisfy the original table contract.
ALTER TABLE ai_web_search_settings
  DROP COLUMN IF EXISTS total_timeout_ms;

-- Chat summary state is scoped by chat and policy generation. The workflow,
-- node and semantic-profile columns only describe the retired node-level
-- implementation; 0041 has already moved those states to legacy scope.
ALTER TABLE conversation_context_states
  DROP COLUMN IF EXISTS workflow_id,
  DROP COLUMN IF EXISTS node_id,
  DROP COLUMN IF EXISTS profile_hash;

-- Background compression is never owned by a workflow execution. Historical
-- ownership was archived above and current relations are derived from the
-- immutable workflow context snapshot.
ALTER TABLE conversation_context_compressions
  DROP COLUMN IF EXISTS execution_id;

-- 0039 already normalized old load-context definitions. There is no longer an
-- editor flow or runtime behavior that consumes this transitional marker.
ALTER TABLE workflow_versions
  DROP COLUMN IF EXISTS needs_resave;
