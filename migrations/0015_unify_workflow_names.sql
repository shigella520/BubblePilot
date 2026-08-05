-- Workflow names have one source of truth. Reconcile records created while
-- the canvas header and the definition name were saved independently.
WITH preferred_definition AS (
  SELECT DISTINCT ON (workflow_id)
    workflow_id,
    definition
  FROM workflow_versions
  ORDER BY workflow_id, (status = 'published') DESC, version DESC
)
UPDATE workflows workflow
SET name = preferred.definition ->> 'name',
    updated_at = NOW()
FROM preferred_definition preferred
WHERE preferred.workflow_id = workflow.id
  AND workflow.deleted_at IS NULL
  AND jsonb_typeof(preferred.definition -> 'name') = 'string'
  AND BTRIM(preferred.definition ->> 'name') <> ''
  AND workflow.name <> preferred.definition ->> 'name';
