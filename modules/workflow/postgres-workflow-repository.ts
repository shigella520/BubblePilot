import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { parseTriggerConditions } from "./trigger-matcher.js";
import { parseWorkflowDefinition } from "./workflow-definition.js";
import type {
  ExecutionCloseResult,
  ExecutionDetail,
  ExecutionRecoveryClaim,
  MessageExecutionLink,
  NodeExecutionRecord,
  OutboundDeliveryRecord,
  TriggerBinding,
  TriggerRecord,
  WorkflowExecutionRecord,
  WorkflowExecutionStatus,
  WorkflowRecord,
  WorkflowRepository,
  WorkflowRuntimeSummary,
  WorkflowVersionRecord,
  WorkflowVersionStatus,
} from "./workflow-repository.js";
import type { MessageEnvelope } from "../ingestion/message-envelope.js";
import type { TriggerConditions } from "./trigger-matcher.js";
import type {
  WorkflowDefinition,
  WorkflowNode,
} from "./workflow-definition.js";

interface IdentifierRow {
  id: string;
}

interface WorkflowVersionRow {
  id: string;
  workflow_id: string;
  workflow_name: string;
  version: number;
  status: WorkflowVersionStatus;
  definition: unknown;
  created_at: Date;
  published_at: Date | null;
}

interface WorkflowRow {
  id: string;
  name: string;
  status: "draft" | "active" | "inactive";
  published_version: number | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface TriggerRow {
  id: string;
  name: string;
  workflow_id: string;
  workflow_version_id: string;
  workflow_version: number;
  conditions: unknown;
  include_from_me: boolean;
  enabled: boolean;
  definition?: unknown;
  created_at: Date;
  updated_at: Date;
}

interface ExecutionRow {
  id: string;
  provider: string;
  external_event_id: string;
  source_provider_message_id: string | null;
  trigger_id: string;
  trigger_name: string;
  workflow_id: string;
  workflow_name: string;
  workflow_version_id: string;
  workflow_version: number;
  retry_of_execution_id: string | null;
  recovery_attempt: number;
  correlation_id: string;
  status: WorkflowExecutionRecord["status"];
  current_node_id: string | null;
  error_code: string | null;
  error_summary: string | null;
  next_retry_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

interface RecoveryEnvelopeRow {
  provider_message_id: string;
  sender_id: string | null;
  sent_at: Date;
  body: string | null;
  content_type: MessageEnvelope["message"]["contentType"];
  is_from_me: boolean;
  content_hash: string;
  attachments: unknown;
  provider_chat_id: string;
  chat_type: MessageEnvelope["chat"]["type"];
  display_name: string | null;
  payload_hash: string;
  event_type: string;
  trigger_name: string;
  workflow_id: string;
  workflow_version_id: string;
  workflow_version: number;
  conditions: unknown;
  include_from_me: boolean;
  trigger_enabled: boolean;
  trigger_created_at: Date;
  trigger_updated_at: Date;
  definition: unknown;
}

interface NodeExecutionRow {
  id: string;
  node_id: string;
  node_type: string;
  node_version: number;
  attempt: number;
  status: NodeExecutionRecord["status"];
  input_summary: Record<string, unknown>;
  output_summary: Record<string, unknown>;
  error_code: string | null;
  error_summary: string | null;
  retryable: boolean | null;
  started_at: Date;
  completed_at: Date | null;
  duration_ms: number | null;
}

interface DeliveryRow {
  id: string;
  execution_id: string;
  node_id: string;
  idempotency_key: string;
  provider_chat_id: string;
  reply_to_provider_message_id: string | null;
  body_hash: string;
  provider_temp_guid: string;
  provider_message_id: string | null;
  status: OutboundDeliveryRecord["status"];
  attempt_count: number;
  error_code: string | null;
  error_summary: string | null;
  retryable: boolean | null;
  created_at: Date;
  updated_at: Date;
  confirmed_at: Date | null;
}

const versionSelect = `SELECT
  v.id, v.workflow_id, w.name AS workflow_name, v.version, v.status,
  v.definition, v.created_at, v.published_at
FROM workflow_versions v
INNER JOIN workflows w ON w.id = v.workflow_id`;

const triggerSelect = `SELECT
  t.id, t.name, v.workflow_id, t.workflow_version_id,
  v.version AS workflow_version, t.conditions, t.include_from_me, t.enabled,
  t.created_at, t.updated_at, t.deleted_at`;

const executionSelect = `SELECT
  e.id, e.provider, e.external_event_id,
  (SELECT m.provider_message_id FROM messages m WHERE m.id = e.source_message_id)
    AS source_provider_message_id,
  e.trigger_id,
  t.name AS trigger_name, v.workflow_id, w.name AS workflow_name,
  e.workflow_version_id, v.version AS workflow_version,
  e.retry_of_execution_id, e.recovery_attempt, e.correlation_id,
  e.status, e.current_node_id, e.error_code, e.error_summary, e.next_retry_at,
  e.started_at, e.completed_at, e.created_at
FROM workflow_executions e
INNER JOIN bot_triggers t ON t.id = e.trigger_id
INNER JOIN workflow_versions v ON v.id = e.workflow_version_id
INNER JOIN workflows w ON w.id = v.workflow_id`;

function versionRecord(row: WorkflowVersionRow): WorkflowVersionRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    version: row.version,
    status: row.status,
    definition: parseWorkflowDefinition(row.definition),
    createdAt: row.created_at.toISOString(),
    publishedAt: row.published_at?.toISOString() ?? null,
  };
}

function triggerRecord(row: TriggerRow): TriggerRecord {
  return {
    id: row.id,
    name: row.name,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    workflowVersion: row.workflow_version,
    conditions: parseTriggerConditions(row.conditions),
    includeFromMe: row.include_from_me,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function executionRecord(row: ExecutionRow): WorkflowExecutionRecord {
  return {
    id: row.id,
    provider: row.provider,
    externalEventId: row.external_event_id,
    triggerId: row.trigger_id,
    triggerName: row.trigger_name,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    workflowVersionId: row.workflow_version_id,
    workflowVersion: row.workflow_version,
    retryOfExecutionId: row.retry_of_execution_id,
    recoveryAttempt: row.recovery_attempt,
    correlationId: row.correlation_id,
    status: row.status,
    currentNodeId: row.current_node_id,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    nextRetryAt: row.next_retry_at?.toISOString() ?? null,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function workflowRecord(row: WorkflowRow): WorkflowRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    publishedVersion: row.published_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function nodeExecutionRecord(row: NodeExecutionRow): NodeExecutionRecord {
  return {
    id: row.id,
    nodeId: row.node_id,
    nodeType: row.node_type,
    nodeVersion: row.node_version,
    attempt: row.attempt,
    status: row.status,
    inputSummary: row.input_summary,
    outputSummary: row.output_summary,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    retryable: row.retryable,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    durationMs: row.duration_ms,
  };
}

function deliveryRecord(row: DeliveryRow): OutboundDeliveryRecord {
  return {
    id: row.id,
    executionId: row.execution_id,
    nodeId: row.node_id,
    idempotencyKey: row.idempotency_key,
    providerChatId: row.provider_chat_id,
    replyToProviderMessageId: row.reply_to_provider_message_id,
    providerTempGuid: row.provider_temp_guid,
    providerMessageId: row.provider_message_id,
    status: row.status,
    attemptCount: row.attempt_count,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    retryable: row.retryable,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
  };
}

function summary(value: string): string {
  return value.slice(0, 500);
}

export class PostgresWorkflowRepository implements WorkflowRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }

  async createWorkflow(
    name: string,
    definition: WorkflowDefinition,
  ): Promise<WorkflowVersionRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const workflowId = randomUUID();
      const versionId = randomUUID();
      await client.query(
        `INSERT INTO workflows (id, name, status) VALUES ($1, $2, 'draft')`,
        [workflowId, name],
      );
      await client.query(
        `INSERT INTO workflow_versions (
           id, workflow_id, version, status, definition
         ) VALUES ($1, $2, 1, 'validated', $3::jsonb)`,
        [versionId, workflowId, JSON.stringify(definition)],
      );
      const result = await client.query<WorkflowVersionRow>(
        `${versionSelect} WHERE v.id = $1`,
        [versionId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("The created workflow version could not be read.");
      }
      return versionRecord(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createWorkflowVersion(
    workflowId: string,
    definition: WorkflowDefinition,
  ): Promise<WorkflowVersionRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const workflow = await client.query<IdentifierRow>(
        "SELECT id FROM workflows WHERE id = $1 FOR UPDATE",
        [workflowId],
      );
      if (workflow.rowCount === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      const next = await client.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM workflow_versions WHERE workflow_id = $1`,
        [workflowId],
      );
      const version = next.rows[0]?.version;
      if (version === undefined) {
        throw new Error("The next workflow version could not be allocated.");
      }
      const versionId = randomUUID();
      await client.query(
        `INSERT INTO workflow_versions (
           id, workflow_id, version, status, definition
         ) VALUES ($1, $2, $3, 'validated', $4::jsonb)`,
        [versionId, workflowId, version, JSON.stringify(definition)],
      );
      const result = await client.query<WorkflowVersionRow>(
        `${versionSelect} WHERE v.id = $1`,
        [versionId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row === undefined ? null : versionRecord(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async publishWorkflowVersion(
    workflowId: string,
    version: number,
  ): Promise<WorkflowVersionRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<IdentifierRow>(
        `SELECT id FROM workflow_versions
         WHERE workflow_id = $1 AND version = $2
           AND status IN ('validated', 'published')
         FOR UPDATE`,
        [workflowId, version],
      );
      const selectedId = selected.rows[0]?.id;
      if (selectedId === undefined) {
        await client.query("ROLLBACK");
        return null;
      }
      const previous = await client.query<IdentifierRow>(
        `SELECT id FROM workflow_versions
         WHERE workflow_id = $1 AND status = 'published' AND id <> $2
         FOR UPDATE`,
        [workflowId, selectedId],
      );
      await client.query(
        `UPDATE workflow_versions
         SET status = 'superseded'
         WHERE workflow_id = $1 AND status = 'published' AND id <> $2`,
        [workflowId, selectedId],
      );
      await client.query(
        `UPDATE workflow_versions
         SET status = 'published', published_at = COALESCE(published_at, NOW())
         WHERE id = $1`,
        [selectedId],
      );
      await client.query(
        `UPDATE workflows
         SET status = 'active', published_version_id = $2, updated_at = NOW()
         WHERE id = $1`,
        [workflowId, selectedId],
      );
      for (const row of previous.rows) {
        await client.query(
          `UPDATE bot_triggers
           SET workflow_version_id = $2, updated_at = NOW()
           WHERE workflow_version_id = $1 AND deleted_at IS NULL`,
          [row.id, selectedId],
        );
      }
      const result = await client.query<WorkflowVersionRow>(
        `${versionSelect} WHERE v.id = $1`,
        [selectedId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row === undefined ? null : versionRecord(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getWorkflowVersion(
    workflowId: string,
    version: number,
  ): Promise<WorkflowVersionRecord | null> {
    const result = await this.pool.query<WorkflowVersionRow>(
      `${versionSelect} WHERE v.workflow_id = $1 AND v.version = $2`,
      [workflowId, version],
    );
    const row = result.rows[0];
    return row === undefined ? null : versionRecord(row);
  }

  async listWorkflowVersions(
    workflowId: string,
  ): Promise<readonly WorkflowVersionRecord[]> {
    const result = await this.pool.query<WorkflowVersionRow>(
      `${versionSelect}
       WHERE v.workflow_id = $1
       ORDER BY v.version DESC`,
      [workflowId],
    );
    return result.rows.map(versionRecord);
  }

  async listWorkflows(): Promise<readonly WorkflowRecord[]> {
    const result = await this.pool.query<WorkflowRow>(
      `SELECT w.id, w.name, w.status, v.version AS published_version,
              w.created_at, w.updated_at
       FROM workflows w
       LEFT JOIN workflow_versions v ON v.id = w.published_version_id
       ORDER BY w.updated_at DESC, w.id DESC`,
    );
    return result.rows.map(workflowRecord);
  }

  async setWorkflowEnabled(
    workflowId: string,
    enabled: boolean,
  ): Promise<WorkflowRecord | null> {
    const result = await this.pool.query<WorkflowRow>(
      `UPDATE workflows w
       SET status = CASE WHEN $2 THEN 'active' ELSE 'inactive' END,
           updated_at = NOW()
       FROM workflow_versions v
       WHERE w.id = $1 AND w.published_version_id = v.id
       RETURNING w.id, w.name, w.status, v.version AS published_version,
                 w.created_at, w.updated_at`,
      [workflowId, enabled],
    );
    const row = result.rows[0];
    return row === undefined ? null : workflowRecord(row);
  }

  async deleteWorkflow(
    workflowId: string,
  ): Promise<"deleted" | "not-found" | "referenced"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const exists = await client.query(
        "SELECT 1 FROM workflows WHERE id = $1 FOR UPDATE",
        [workflowId],
      );
      if (exists.rowCount === 0) {
        await client.query("ROLLBACK");
        return "not-found";
      }
      const refs = await client.query<{ referenced: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM bot_triggers t JOIN workflow_versions v ON v.id = t.workflow_version_id WHERE v.workflow_id = $1)
           OR EXISTS (SELECT 1 FROM workflow_executions e JOIN workflow_versions v ON v.id = e.workflow_version_id WHERE v.workflow_id = $1) AS referenced`,
        [workflowId],
      );
      if (refs.rows[0]?.referenced === true) {
        await client.query("ROLLBACK");
        return "referenced";
      }
      await client.query(
        "UPDATE workflows SET published_version_id = NULL WHERE id = $1",
        [workflowId],
      );
      await client.query(
        "DELETE FROM workflow_versions WHERE workflow_id = $1",
        [workflowId],
      );
      await client.query("DELETE FROM workflows WHERE id = $1", [workflowId]);
      await client.query("COMMIT");
      return "deleted";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createTrigger(input: {
    name: string;
    workflowId: string;
    workflowVersion: number;
    conditions: TriggerConditions;
    includeFromMe: boolean;
    enabled: boolean;
  }): Promise<TriggerRecord | null> {
    const result = await this.pool.query<IdentifierRow>(
      `INSERT INTO bot_triggers (
         id, name, workflow_version_id, conditions, include_from_me, enabled
       )
       SELECT $1, $2, v.id, $5::jsonb, $6, $7
       FROM workflow_versions v
       INNER JOIN workflows w ON w.id = v.workflow_id
       WHERE v.workflow_id = $3 AND v.version = $4
         AND v.status = 'published' AND w.status = 'active'
       RETURNING id`,
      [
        randomUUID(),
        input.name,
        input.workflowId,
        input.workflowVersion,
        JSON.stringify(input.conditions),
        input.includeFromMe,
        input.enabled,
      ],
    );
    const id = result.rows[0]?.id;
    return id === undefined ? null : this.getTrigger(id);
  }

  async updateTriggerEnabled(
    triggerId: string,
    enabled: boolean,
  ): Promise<TriggerRecord | null> {
    const result = await this.pool.query<IdentifierRow>(
      `UPDATE bot_triggers t
       SET enabled = $2, updated_at = NOW()
       FROM workflow_versions v, workflows w
       WHERE t.id = $1 AND t.deleted_at IS NULL AND v.id = t.workflow_version_id
         AND w.id = v.workflow_id
         AND ($2 = FALSE OR (v.status = 'published' AND w.status = 'active'))
       RETURNING t.id`,
      [triggerId, enabled],
    );
    const id = result.rows[0]?.id;
    return id === undefined ? null : this.getTrigger(id);
  }

  async updateTrigger(
    triggerId: string,
    input: {
      name: string;
      conditions: TriggerConditions;
      includeFromMe: boolean;
    },
  ): Promise<TriggerRecord | null> {
    const result = await this.pool.query<IdentifierRow>(
      `UPDATE bot_triggers SET name = $2, conditions = $3::jsonb, include_from_me = $4, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [
        triggerId,
        input.name,
        JSON.stringify(input.conditions),
        input.includeFromMe,
      ],
    );
    const id = result.rows[0]?.id;
    return id === undefined ? null : this.getTrigger(id);
  }

  async deleteTrigger(
    triggerId: string,
  ): Promise<"deleted" | "not-found" | "referenced"> {
    const exists = await this.pool.query(
      "SELECT 1 FROM bot_triggers WHERE id = $1 AND deleted_at IS NULL",
      [triggerId],
    );
    if (exists.rowCount === 0) return "not-found";
    await this.pool.query(
      "UPDATE bot_triggers SET enabled = FALSE, deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL",
      [triggerId],
    );
    return "deleted";
  }

  async listTriggers(): Promise<readonly TriggerRecord[]> {
    const result = await this.pool.query<TriggerRow>(
      `${triggerSelect}
       FROM bot_triggers t
       INNER JOIN workflow_versions v ON v.id = t.workflow_version_id
       WHERE t.deleted_at IS NULL
       ORDER BY t.updated_at DESC, t.id DESC`,
    );
    return result.rows.map(triggerRecord);
  }

  async listActiveTriggerBindings(): Promise<readonly TriggerBinding[]> {
    const result = await this.pool.query<TriggerRow>(
      `${triggerSelect}, v.definition
       FROM bot_triggers t
       INNER JOIN workflow_versions v ON v.id = t.workflow_version_id
       INNER JOIN workflows w ON w.id = v.workflow_id
       WHERE t.enabled = TRUE AND t.deleted_at IS NULL AND v.status = 'published' AND w.status = 'active'
       ORDER BY t.created_at, t.id`,
    );
    return result.rows.map((row) => ({
      ...triggerRecord(row),
      definition: parseWorkflowDefinition(row.definition),
    }));
  }

  async createExecution(input: {
    envelope: MessageEnvelope;
    trigger: TriggerBinding;
  }): Promise<{ execution: WorkflowExecutionRecord; created: boolean }> {
    const id = randomUUID();
    const inserted = await this.pool.query<IdentifierRow>(
      `INSERT INTO workflow_executions (
         id, provider, external_event_id, source_message_id, trigger_id,
         workflow_version_id, correlation_id, status
       ) VALUES (
         $1, $2, $3,
         (SELECT id FROM messages WHERE provider = $2 AND provider_message_id = $4),
         $5, $6, $7, 'created'
       )
       ON CONFLICT (provider, external_event_id, trigger_id, workflow_version_id)
       DO NOTHING
       RETURNING id`,
      [
        id,
        input.envelope.provider,
        input.envelope.eventId,
        input.envelope.message.providerMessageId,
        input.trigger.id,
        input.trigger.workflowVersionId,
        input.envelope.correlationId,
      ],
    );
    const persistedId = inserted.rows[0]?.id ?? id;
    const result = await this.pool.query<ExecutionRow>(
      `${executionSelect}
       WHERE e.provider = $1 AND e.external_event_id = $2
         AND e.trigger_id = $3 AND e.workflow_version_id = $4`,
      [
        input.envelope.provider,
        input.envelope.eventId,
        input.trigger.id,
        input.trigger.workflowVersionId,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`Workflow execution '${persistedId}' could not be read.`);
    }
    return {
      execution: executionRecord(row),
      created: inserted.rowCount === 1,
    };
  }

  async createManualRetry(
    executionId: string,
    correlationId: string,
    staleRetryBefore: Date,
  ): Promise<ExecutionRecoveryClaim> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const sourceResult = await client.query<ExecutionRow>(
        `${executionSelect} WHERE e.id = $1 FOR UPDATE OF e`,
        [executionId],
      );
      const sourceRow = sourceResult.rows[0];
      if (sourceRow === undefined) {
        await client.query("ROLLBACK");
        return { status: "not-found" };
      }
      const staleRetry =
        sourceRow.status === "retrying" &&
        sourceRow.next_retry_at !== null &&
        sourceRow.next_retry_at.getTime() <= staleRetryBefore.getTime();
      if (sourceRow.status === "retrying" && !staleRetry) {
        await client.query("ROLLBACK");
        return {
          status: "conflict",
          reason: "execution-retry-still-active",
        };
      }
      if (
        !(["failed", "dead-lettered"] as WorkflowExecutionStatus[]).includes(
          sourceRow.status,
        ) &&
        !staleRetry
      ) {
        await client.query("ROLLBACK");
        return { status: "conflict", reason: "execution-not-recoverable" };
      }
      const existingRecovery = await client.query<IdentifierRow>(
        "SELECT id FROM workflow_executions WHERE retry_of_execution_id = $1",
        [executionId],
      );
      if (existingRecovery.rowCount !== 0) {
        await client.query("ROLLBACK");
        return { status: "conflict", reason: "recovery-already-created" };
      }
      const deliveryStates = await client.query<{ status: string }>(
        "SELECT status FROM outbound_deliveries WHERE execution_id = $1 FOR UPDATE",
        [executionId],
      );
      if (
        deliveryStates.rows.some((row) =>
          ["sending", "unknown"].includes(row.status),
        )
      ) {
        await client.query("ROLLBACK");
        return { status: "conflict", reason: "outbound-result-unknown" };
      }
      if (deliveryStates.rows.some((row) => row.status === "confirmed")) {
        await client.query("ROLLBACK");
        return { status: "conflict", reason: "outbound-already-confirmed" };
      }
      const contextResult = await client.query<RecoveryEnvelopeRow>(
        `SELECT
           m.provider_message_id, m.sender_id, m.sent_at, m.body,
           m.content_type, m.is_from_me, m.content_hash, m.attachments,
           c.provider_chat_id, c.type AS chat_type, c.display_name,
           i.payload_hash, i.event_type, t.name AS trigger_name,
           v.workflow_id, e.workflow_version_id, v.version AS workflow_version,
           t.conditions, t.include_from_me, t.enabled AS trigger_enabled,
           t.created_at AS trigger_created_at, t.updated_at AS trigger_updated_at,
           v.definition
         FROM workflow_executions e
         INNER JOIN messages m ON m.id = e.source_message_id
         INNER JOIN chats c ON c.id = m.chat_id
         INNER JOIN inbound_events i ON i.id = m.source_event_id
         INNER JOIN bot_triggers t ON t.id = e.trigger_id
         INNER JOIN workflow_versions v ON v.id = e.workflow_version_id
         WHERE e.id = $1`,
        [executionId],
      );
      const context = contextResult.rows[0];
      if (context === undefined) {
        await client.query("ROLLBACK");
        return { status: "conflict", reason: "source-message-unavailable" };
      }

      if (staleRetry) {
        await client.query(
          `UPDATE workflow_executions
           SET status = 'failed', current_node_id = NULL, next_retry_at = NULL,
               completed_at = NOW(), error_code = 'STALE_RETRY_RECOVERED',
               error_summary = $2
           WHERE id = $1`,
          [
            executionId,
            "The expired retry was superseded by a manual recovery execution.",
          ],
        );
      }

      const recoveryId = randomUUID();
      const syntheticEventId = `${sourceRow.external_event_id}:manual-retry:${recoveryId}`;
      await client.query(
        `INSERT INTO workflow_executions (
           id, provider, external_event_id, source_message_id, trigger_id,
           workflow_version_id, retry_of_execution_id, recovery_attempt,
           correlation_id, status
         ) SELECT
           $2, provider, $3, source_message_id, trigger_id,
           workflow_version_id, id, recovery_attempt + 1, $4, 'created'
         FROM workflow_executions WHERE id = $1`,
        [executionId, recoveryId, syntheticEventId, correlationId],
      );
      const recoveryResult = await client.query<ExecutionRow>(
        `${executionSelect} WHERE e.id = $1`,
        [recoveryId],
      );
      const recoveryRow = recoveryResult.rows[0];
      if (recoveryRow === undefined) {
        throw new Error("The recovery execution could not be read.");
      }
      const envelope: MessageEnvelope = {
        schemaVersion: "1",
        eventId: sourceRow.external_event_id,
        correlationId,
        provider: "bluebubbles",
        chat: {
          providerChatId: context.provider_chat_id,
          type: context.chat_type,
          displayName: context.display_name,
        },
        message: {
          providerMessageId: context.provider_message_id,
          senderId: context.sender_id,
          sentAt: context.sent_at.toISOString(),
          text: context.body,
          contentType: context.content_type,
          isFromMe: context.is_from_me,
          attachments: messageAttachments(context.attachments),
          contentHash: context.content_hash,
        },
        metadata: {
          isReplay: true,
          payloadHash: context.payload_hash,
          eventType: context.event_type,
          adapterVersion: "1",
        },
      };
      const trigger: TriggerBinding = {
        id: sourceRow.trigger_id,
        name: context.trigger_name,
        workflowId: context.workflow_id,
        workflowVersionId: context.workflow_version_id,
        workflowVersion: context.workflow_version,
        conditions: parseTriggerConditions(context.conditions),
        includeFromMe: context.include_from_me,
        enabled: context.trigger_enabled,
        createdAt: context.trigger_created_at.toISOString(),
        updatedAt: context.trigger_updated_at.toISOString(),
        definition: parseWorkflowDefinition(context.definition),
      };
      await client.query("COMMIT");
      return {
        status: "created",
        execution: executionRecord(recoveryRow),
        trigger,
        envelope,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async closeExecution(executionId: string): Promise<ExecutionCloseResult> {
    const updated = await this.pool.query<IdentifierRow>(
      `UPDATE workflow_executions
       SET status = 'closed', current_node_id = NULL, next_retry_at = NULL,
           completed_at = COALESCE(completed_at, NOW())
       WHERE id = $1 AND status IN ('retrying', 'failed', 'dead-lettered')
       RETURNING id`,
      [executionId],
    );
    if (updated.rowCount === 0) {
      const exists = await this.pool.query<IdentifierRow>(
        "SELECT id FROM workflow_executions WHERE id = $1",
        [executionId],
      );
      return exists.rowCount === 0
        ? { status: "not-found" }
        : { status: "conflict", reason: "execution-not-closeable" };
    }
    const execution = await this.getExecution(executionId);
    if (execution === null) {
      throw new Error("The closed workflow execution could not be read.");
    }
    return { status: "ok", execution };
  }

  async markExecutionRunning(
    executionId: string,
    nodeId: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE workflow_executions
       SET status = 'running', current_node_id = $2,
           started_at = COALESCE(started_at, NOW()), next_retry_at = NULL
       WHERE id = $1`,
      [executionId, nodeId],
    );
  }

  async markExecutionRetrying(
    executionId: string,
    nodeId: string,
    nextRetryAt: Date,
    errorCode: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE workflow_executions
       SET status = 'retrying', current_node_id = $2, next_retry_at = $3,
           error_code = $4
       WHERE id = $1`,
      [executionId, nodeId, nextRetryAt.toISOString(), errorCode],
    );
  }

  async resumeExecutionRetry(
    executionId: string,
    nodeId: string,
    expectedNextRetryAt: Date,
  ): Promise<boolean> {
    const resumed = await this.pool.query<IdentifierRow>(
      `UPDATE workflow_executions
       SET status = 'running', started_at = COALESCE(started_at, NOW()),
           next_retry_at = NULL
       WHERE id = $1 AND status = 'retrying' AND current_node_id = $2
         AND next_retry_at = $3
       RETURNING id`,
      [executionId, nodeId, expectedNextRetryAt.toISOString()],
    );
    return resumed.rowCount === 1;
  }

  async finishExecution(
    executionId: string,
    status: "succeeded" | "skipped" | "failed" | "dead-lettered",
    error?: { code: string; summary: string },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE workflow_executions
       SET status = $2, current_node_id = NULL, completed_at = NOW(),
           next_retry_at = NULL, error_code = $3, error_summary = $4
       WHERE id = $1`,
      [executionId, status, error?.code ?? null, error?.summary ?? null],
    );
  }

  async startNodeExecution(input: {
    executionId: string;
    node: WorkflowNode;
    attempt: number;
    inputSummary: Readonly<Record<string, unknown>>;
  }): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO node_executions (
         id, execution_id, node_id, node_type, node_version, attempt, status,
         input_summary
       ) VALUES ($1, $2, $3, $4, $5, $6, 'running', $7::jsonb)`,
      [
        id,
        input.executionId,
        input.node.id,
        input.node.type,
        input.node.version,
        input.attempt,
        JSON.stringify(input.inputSummary),
      ],
    );
    return id;
  }

  async finishNodeExecution(input: {
    nodeExecutionId: string;
    status: "succeeded" | "skipped" | "failed";
    outputSummary?: Readonly<Record<string, unknown>>;
    error?: { code: string; summary: string; retryable: boolean };
  }): Promise<void> {
    await this.pool.query(
      `UPDATE node_executions
       SET status = $2, output_summary = $3::jsonb, error_code = $4,
           error_summary = $5, retryable = $6, completed_at = NOW(),
           duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::integer)
       WHERE id = $1`,
      [
        input.nodeExecutionId,
        input.status,
        JSON.stringify(input.outputSummary ?? {}),
        input.error?.code ?? null,
        input.error === undefined ? null : summary(input.error.summary),
        input.error?.retryable ?? null,
      ],
    );
  }

  async claimDelivery(input: {
    executionId: string;
    nodeId: string;
    idempotencyKey: string;
    providerChatId: string;
    replyToProviderMessageId: string | null;
    bodyHash: string;
  }): Promise<{ delivery: OutboundDeliveryRecord; created: boolean }> {
    const id = randomUUID();
    const tempGuid = randomUUID();
    const inserted = await this.pool.query<IdentifierRow>(
      `INSERT INTO outbound_deliveries (
         id, execution_id, node_id, idempotency_key, provider,
         provider_chat_id, reply_to_provider_message_id, body_hash,
         provider_temp_guid, status
       ) VALUES ($1, $2, $3, $4, 'bluebubbles', $5, $6, $7, $8, 'pending')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        id,
        input.executionId,
        input.nodeId,
        input.idempotencyKey,
        input.providerChatId,
        input.replyToProviderMessageId,
        input.bodyHash,
        tempGuid,
      ],
    );
    const result = await this.pool.query<DeliveryRow>(
      "SELECT * FROM outbound_deliveries WHERE idempotency_key = $1",
      [input.idempotencyKey],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("The outbound delivery could not be read.");
    }
    if (row.body_hash !== undefined && row.body_hash !== input.bodyHash) {
      throw new Error(
        "The outbound idempotency key was reused with different content.",
      );
    }
    return { delivery: deliveryRecord(row), created: inserted.rowCount === 1 };
  }

  async markDeliverySending(deliveryId: string): Promise<void> {
    await this.pool.query(
      `UPDATE outbound_deliveries
       SET status = 'sending', attempt_count = attempt_count + 1,
           error_code = NULL, error_summary = NULL, retryable = NULL,
           updated_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'failed')`,
      [deliveryId],
    );
  }

  async confirmDelivery(
    deliveryId: string,
    providerMessageId: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE outbound_deliveries
       SET status = 'confirmed', provider_message_id = $2, confirmed_at = NOW(),
           updated_at = NOW(), error_code = NULL, error_summary = NULL,
           retryable = NULL
       WHERE id = $1`,
      [deliveryId, providerMessageId],
    );
  }

  async failDelivery(
    deliveryId: string,
    status: "failed" | "unknown",
    error: { code: string; summary: string; retryable: boolean },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE outbound_deliveries
       SET status = $2, error_code = $3, error_summary = $4,
           retryable = $5, updated_at = NOW()
       WHERE id = $1`,
      [deliveryId, status, error.code, summary(error.summary), error.retryable],
    );
  }

  async listExecutions(
    limit: number,
    statuses: readonly WorkflowExecutionStatus[] = [],
  ): Promise<readonly WorkflowExecutionRecord[]> {
    const result = await this.pool.query<ExecutionRow>(
      `${executionSelect}
       WHERE ($2::text[] = ARRAY[]::text[] OR e.status = ANY($2::text[]))
       ORDER BY e.created_at DESC, e.id DESC LIMIT $1`,
      [limit, statuses],
    );
    return result.rows.map(executionRecord);
  }

  async listExecutionsForMessages(
    providerMessageIds: readonly string[],
  ): Promise<readonly MessageExecutionLink[]> {
    if (providerMessageIds.length === 0) return [];
    const result = await this.pool.query<ExecutionRow>(
      `${executionSelect}
       WHERE e.source_message_id IN (
         SELECT m.id FROM messages m
         WHERE m.provider = 'bluebubbles'
           AND m.provider_message_id = ANY($1::text[])
       )
       ORDER BY e.created_at, e.id`,
      [providerMessageIds],
    );
    return result.rows.flatMap((row) =>
      row.source_provider_message_id === null
        ? []
        : [
            {
              providerMessageId: row.source_provider_message_id,
              execution: executionRecord(row),
            },
          ],
    );
  }

  async getExecution(executionId: string): Promise<ExecutionDetail | null> {
    const [execution, nodes, deliveries] = await Promise.all([
      this.pool.query<ExecutionRow>(`${executionSelect} WHERE e.id = $1`, [
        executionId,
      ]),
      this.pool.query<NodeExecutionRow>(
        `SELECT * FROM node_executions
         WHERE execution_id = $1 ORDER BY started_at, id`,
        [executionId],
      ),
      this.pool.query<DeliveryRow>(
        `SELECT * FROM outbound_deliveries
         WHERE execution_id = $1 ORDER BY created_at, id`,
        [executionId],
      ),
    ]);
    const row = execution.rows[0];
    return row === undefined
      ? null
      : {
          ...executionRecord(row),
          nodes: nodes.rows.map(nodeExecutionRecord),
          deliveries: deliveries.rows.map(deliveryRecord),
        };
  }

  async getRuntimeSummary(
    staleRetryBefore: Date,
  ): Promise<WorkflowRuntimeSummary> {
    const [executions, outbound] = await Promise.all([
      this.pool.query<{
        created: string;
        running: string;
        retrying: string;
        failed: string;
        dead_lettered: string;
        closed: string;
        stale_retrying: string;
        oldest_dead_letter_at: Date | null;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'created') AS created,
           COUNT(*) FILTER (WHERE status = 'running') AS running,
           COUNT(*) FILTER (WHERE status = 'retrying') AS retrying,
           COUNT(*) FILTER (WHERE status = 'failed') AS failed,
           COUNT(*) FILTER (WHERE status = 'dead-lettered') AS dead_lettered,
           COUNT(*) FILTER (WHERE status = 'closed') AS closed,
           COUNT(*) FILTER (
             WHERE status = 'retrying' AND next_retry_at <= $1
           ) AS stale_retrying,
           MIN(created_at) FILTER (
             WHERE status = 'dead-lettered'
           ) AS oldest_dead_letter_at
         FROM workflow_executions`,
        [staleRetryBefore.toISOString()],
      ),
      this.pool.query<{ sending: string; unknown: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'sending') AS sending,
           COUNT(*) FILTER (WHERE status = 'unknown') AS unknown
         FROM outbound_deliveries`,
      ),
    ]);
    const execution = executions.rows[0];
    const delivery = outbound.rows[0];
    return {
      executions: {
        created: Number(execution?.created ?? 0),
        running: Number(execution?.running ?? 0),
        retrying: Number(execution?.retrying ?? 0),
        failed: Number(execution?.failed ?? 0),
        deadLettered: Number(execution?.dead_lettered ?? 0),
        closed: Number(execution?.closed ?? 0),
        staleRetrying: Number(execution?.stale_retrying ?? 0),
      },
      outbound: {
        sending: Number(delivery?.sending ?? 0),
        unknown: Number(delivery?.unknown ?? 0),
      },
      oldestDeadLetterAt:
        execution?.oldest_dead_letter_at?.toISOString() ?? null,
    };
  }

  async isReady(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ ready: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM schema_migrations WHERE name = '0006_execution_recovery.sql'
         ) AS ready`,
      );
      return result.rows[0]?.ready === true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async getTrigger(triggerId: string): Promise<TriggerRecord | null> {
    const result = await this.pool.query<TriggerRow>(
      `${triggerSelect}
       FROM bot_triggers t
       INNER JOIN workflow_versions v ON v.id = t.workflow_version_id
       WHERE t.id = $1 AND t.deleted_at IS NULL`,
      [triggerId],
    );
    const row = result.rows[0];
    return row === undefined ? null : triggerRecord(row);
  }
}

function messageAttachments(
  value: unknown,
): MessageEnvelope["message"]["attachments"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return typeof record.providerAttachmentId === "string"
      ? [
          {
            providerAttachmentId: record.providerAttachmentId,
            mimeType:
              typeof record.mimeType === "string" ? record.mimeType : null,
            fileName:
              typeof record.fileName === "string" ? record.fileName : null,
            sizeBytes:
              typeof record.sizeBytes === "number" ? record.sizeBytes : null,
          },
        ]
      : [];
  });
}
