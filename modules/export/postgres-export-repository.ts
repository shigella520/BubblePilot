import type { Pool, PoolClient } from "pg";

import { createPostgresPool } from "../shared/postgres-pool.js";

import type { DataExportRepository } from "./export-repository.js";
import type {
  DataExportContent,
  DataExportExecution,
  DataExportJob,
  DataExportJobStatus,
  DataExportMessage,
  DataExportMutationResult,
  DataExportOwner,
  DataExportPreviewResult,
  DataExportReadResult,
  DataExportScope,
} from "./export-types.js";

interface ExportJobRow {
  id: string;
  chat_id: string;
  sent_from: Date;
  sent_to: Date;
  include_messages: boolean;
  include_executions: boolean;
  snapshot_at: Date;
  message_count: number;
  execution_count: number;
  estimated_bytes: string;
  status: "awaiting-confirmation" | "ready" | "revoked";
  expires_at: Date;
  confirmed_at: Date | null;
  downloaded_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

interface CountRow {
  record_count: string;
  estimated_bytes: string;
}

interface MessageRow {
  id: string;
  provider_message_id: string;
  chat_id: string;
  provider_chat_id: string;
  chat_display_name: string | null;
  sender_id: string | null;
  sent_at: Date;
  body: string | null;
  content_type: string;
  is_from_me: boolean;
  attachments: unknown;
  link_previews: unknown;
  link_preview_status: string;
  link_preview_error_code: string | null;
  content_redacted_at: Date | null;
  created_at: Date;
}

interface ExecutionRow {
  id: string;
  source_message_id: string;
  trigger_id: string;
  trigger_name: string;
  workflow_id: string;
  workflow_name: string;
  workflow_version: number;
  correlation_id: string;
  status: string;
  current_node_id: string | null;
  error_code: string | null;
  next_retry_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

const exportJobSelect = `
  SELECT id, chat_id, sent_from, sent_to, include_messages,
         include_executions, snapshot_at, message_count, execution_count,
         estimated_bytes, status, expires_at, confirmed_at, downloaded_at,
         revoked_at, created_at
  FROM data_export_jobs`;

function ownerPredicate(offset = 1): string {
  return `actor_type = $${offset}
    AND actor_session_id IS NOT DISTINCT FROM $${offset + 1}`;
}

function ownerParameters(owner: DataExportOwner): readonly unknown[] {
  return [owner.actorType, owner.actorSessionId];
}

function jobStatus(row: ExportJobRow, now: Date): DataExportJobStatus {
  if (row.status === "revoked") return "revoked";
  return row.expires_at.getTime() <= now.getTime() ? "expired" : row.status;
}

function jobView(row: ExportJobRow, now: Date): DataExportJob {
  const types: DataExportScope["types"] = [
    ...(row.include_messages ? (["messages"] as const) : []),
    ...(row.include_executions ? (["executions"] as const) : []),
  ];
  return {
    id: row.id,
    scope: {
      chatId: row.chat_id,
      sentFrom: row.sent_from.toISOString(),
      sentTo: row.sent_to.toISOString(),
      types,
    },
    snapshotAt: row.snapshot_at.toISOString(),
    messageCount: row.message_count,
    executionCount: row.execution_count,
    recordCount: row.message_count + row.execution_count,
    estimatedBytes: Number(row.estimated_bytes),
    status: jobStatus(row, now),
    expiresAt: row.expires_at.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    downloadedAt: row.downloaded_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function messageView(row: MessageRow): DataExportMessage {
  return {
    id: row.id,
    providerMessageId: row.provider_message_id,
    chatId: row.chat_id,
    providerChatId: row.provider_chat_id,
    chatDisplayName: row.chat_display_name,
    senderId: row.sender_id,
    sentAt: row.sent_at.toISOString(),
    body: row.body,
    contentType: row.content_type,
    isFromMe: row.is_from_me,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    linkPreview: {
      status: row.link_preview_status,
      errorCode: row.link_preview_error_code,
      items: Array.isArray(row.link_previews) ? row.link_previews : [],
    },
    contentRedactedAt: row.content_redacted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function executionView(row: ExecutionRow): DataExportExecution {
  return {
    id: row.id,
    sourceMessageId: row.source_message_id,
    triggerId: row.trigger_id,
    triggerName: row.trigger_name,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    workflowVersion: row.workflow_version,
    correlationId: row.correlation_id,
    status: row.status,
    currentNodeId: row.current_node_id,
    errorCode: row.error_code,
    nextRetryAt: row.next_retry_at?.toISOString() ?? null,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export class PostgresDataExportRepository implements DataExportRepository {
  private readonly pool: Pool;

  constructor(databaseUrl: string, queryTimeoutMs?: number) {
    this.pool = createPostgresPool(databaseUrl, 5, queryTimeoutMs);
  }

  async createPreview(input: {
    id: string;
    owner: DataExportOwner;
    scope: DataExportScope;
    snapshotAt: Date;
    expiresAt: Date;
    maxRecords: number;
    maxEstimatedBytes: number;
  }): Promise<DataExportPreviewResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtext('bubblepilot-message-content'))",
      );
      const chat = await client.query<{ id: string }>(
        "SELECT id FROM chats WHERE id = $1 AND enabled = TRUE",
        [input.scope.chatId],
      );
      if (chat.rowCount === 0) {
        await client.query("ROLLBACK");
        return { status: "scope-unavailable" };
      }

      const includeMessages = input.scope.types.includes("messages");
      const includeExecutions = input.scope.types.includes("executions");
      const messageStats = includeMessages
        ? await this.messageCount(client, input.scope, input.snapshotAt)
        : { recordCount: 0, estimatedBytes: 0 };
      const executionStats = includeExecutions
        ? await this.executionCount(client, input.scope, input.snapshotAt)
        : { recordCount: 0, estimatedBytes: 0 };
      const recordCount = messageStats.recordCount + executionStats.recordCount;
      const estimatedBytes =
        messageStats.estimatedBytes + executionStats.estimatedBytes;
      if (
        recordCount > input.maxRecords ||
        estimatedBytes > input.maxEstimatedBytes
      ) {
        await client.query("ROLLBACK");
        return { status: "too-large", recordCount, estimatedBytes };
      }

      const result = await client.query<ExportJobRow>(
        `INSERT INTO data_export_jobs (
           id, actor_type, actor_session_id, chat_id, sent_from, sent_to,
           include_messages, include_executions, snapshot_at, message_count,
           execution_count, estimated_bytes, status, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           'awaiting-confirmation', $13
         )
         RETURNING id, chat_id, sent_from, sent_to, include_messages,
                   include_executions, snapshot_at, message_count,
                   execution_count, estimated_bytes, status, expires_at,
                   confirmed_at, downloaded_at, revoked_at, created_at`,
        [
          input.id,
          input.owner.actorType,
          input.owner.actorSessionId,
          input.scope.chatId,
          input.scope.sentFrom,
          input.scope.sentTo,
          includeMessages,
          includeExecutions,
          input.snapshotAt,
          messageStats.recordCount,
          executionStats.recordCount,
          estimatedBytes,
          input.expiresAt,
        ],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("The data export preview could not be read.");
      }
      return { status: "ok", value: jobView(row, input.snapshotAt) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listJobs(
    owner: DataExportOwner,
    now: Date,
    options: {
      limit: number;
      cursor: { timestamp: Date; id: string } | null;
    },
  ): Promise<readonly DataExportJob[]> {
    const result = await this.pool.query<ExportJobRow>(
      `${exportJobSelect}
       WHERE ${ownerPredicate()}
         AND (
           $3::timestamptz IS NULL
           OR (created_at, id) < ($3::timestamptz, $4::uuid)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT $5`,
      [
        ...ownerParameters(owner),
        options.cursor?.timestamp.toISOString() ?? null,
        options.cursor?.id ?? null,
        options.limit,
      ],
    );
    return result.rows.map((row) => jobView(row, now));
  }

  async confirmJob(input: {
    id: string;
    owner: DataExportOwner;
    expectedRecordCount: number;
    expectedSnapshotAt: Date;
    now: Date;
    expiresAt: Date;
  }): Promise<DataExportMutationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtext('bubblepilot-message-content'))",
      );
      const selected = await this.selectOwnedForUpdate(
        client,
        input.id,
        input.owner,
      );
      if (selected === null) {
        await client.query("ROLLBACK");
        return { status: "not-found" };
      }
      const view = jobView(selected, input.now);
      if (view.status === "expired") {
        await client.query("ROLLBACK");
        return { status: "expired" };
      }
      if (view.status !== "awaiting-confirmation") {
        await client.query("ROLLBACK");
        return {
          status: "conflict",
          reason: "The export is no longer awaiting confirmation.",
        };
      }
      if (
        view.recordCount !== input.expectedRecordCount ||
        selected.snapshot_at.getTime() !== input.expectedSnapshotAt.getTime()
      ) {
        await client.query("ROLLBACK");
        return {
          status: "conflict",
          reason: "The export preview changed; create a new preview.",
        };
      }
      const result = await client.query<ExportJobRow>(
        `UPDATE data_export_jobs
         SET status = 'ready', confirmed_at = $2, expires_at = $3
         WHERE id = $1
         RETURNING id, chat_id, sent_from, sent_to, include_messages,
                   include_executions, snapshot_at, message_count,
                   execution_count, estimated_bytes, status, expires_at,
                   confirmed_at, downloaded_at, revoked_at, created_at`,
        [input.id, input.now, input.expiresAt],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("The confirmed data export could not be read.");
      }
      return { status: "ok", value: jobView(row, input.now) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeJob(input: {
    id: string;
    owner: DataExportOwner;
    now: Date;
  }): Promise<DataExportMutationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await this.selectOwnedForUpdate(
        client,
        input.id,
        input.owner,
      );
      if (selected === null) {
        await client.query("ROLLBACK");
        return { status: "not-found" };
      }
      const view = jobView(selected, input.now);
      if (view.status === "expired") {
        await client.query("ROLLBACK");
        return { status: "expired" };
      }
      if (view.status === "revoked") {
        await client.query("ROLLBACK");
        return { status: "ok", value: view };
      }
      const result = await client.query<ExportJobRow>(
        `UPDATE data_export_jobs
         SET status = 'revoked', revoked_at = $2
         WHERE id = $1
         RETURNING id, chat_id, sent_from, sent_to, include_messages,
                   include_executions, snapshot_at, message_count,
                   execution_count, estimated_bytes, status, expires_at,
                   confirmed_at, downloaded_at, revoked_at, created_at`,
        [input.id, input.now],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error("The revoked data export could not be read.");
      }
      return { status: "ok", value: jobView(row, input.now) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readJob(input: {
    id: string;
    owner: DataExportOwner;
    now: Date;
  }): Promise<DataExportReadResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtext('bubblepilot-message-content'))",
      );
      const row = await this.selectOwnedForUpdate(
        client,
        input.id,
        input.owner,
      );
      if (row === null) {
        await client.query("ROLLBACK");
        return { status: "not-found" };
      }
      const job = jobView(row, input.now);
      if (job.status === "expired") {
        await client.query("ROLLBACK");
        return { status: "expired" };
      }
      if (job.status !== "ready") {
        await client.query("ROLLBACK");
        return { status: "not-ready" };
      }

      const chat = await client.query<{ id: string }>(
        "SELECT id FROM chats WHERE id = $1 AND enabled = TRUE",
        [job.scope.chatId],
      );
      if (chat.rowCount === 0) {
        await client.query("ROLLBACK");
        return { status: "scope-unavailable" };
      }
      const content = await this.readContent(client, job);
      if (
        content.messages.length !== job.messageCount ||
        content.executions.length !== job.executionCount
      ) {
        await client.query("ROLLBACK");
        return { status: "conflict" };
      }
      await client.query(
        `UPDATE data_export_jobs
         SET downloaded_at = COALESCE(downloaded_at, $2)
         WHERE id = $1`,
        [job.id, input.now],
      );
      await client.query("COMMIT");
      return {
        status: "ok",
        job: {
          ...job,
          downloadedAt: job.downloadedAt ?? input.now.toISOString(),
        },
        content,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async isReady(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async messageCount(
    client: PoolClient,
    scope: DataExportScope,
    snapshotAt: Date,
  ): Promise<{ recordCount: number; estimatedBytes: number }> {
    const result = await client.query<CountRow>(
      `SELECT COUNT(*)::bigint AS record_count,
              COALESCE(SUM(
                OCTET_LENGTH(COALESCE(m.body, ''))
                + OCTET_LENGTH(m.attachments::text)
                + OCTET_LENGTH(m.link_previews::text) + 512
              ), 0)::bigint AS estimated_bytes
       FROM messages m
       INNER JOIN chats c ON c.id = m.chat_id
       WHERE c.id = $1 AND c.enabled = TRUE
         AND m.sent_at >= $2 AND m.sent_at <= $3
         AND m.created_at <= $4`,
      [scope.chatId, scope.sentFrom, scope.sentTo, snapshotAt],
    );
    const row = result.rows[0];
    return {
      recordCount: Number(row?.record_count ?? 0),
      estimatedBytes: Number(row?.estimated_bytes ?? 0),
    };
  }

  private async executionCount(
    client: PoolClient,
    scope: DataExportScope,
    snapshotAt: Date,
  ): Promise<{ recordCount: number; estimatedBytes: number }> {
    const result = await client.query<CountRow>(
      `SELECT COUNT(*)::bigint AS record_count,
              (COUNT(*) * 1024)::bigint AS estimated_bytes
       FROM workflow_executions e
       INNER JOIN messages m ON m.id = e.source_message_id
       INNER JOIN chats c ON c.id = m.chat_id
       WHERE c.id = $1 AND c.enabled = TRUE
         AND m.sent_at >= $2 AND m.sent_at <= $3
         AND m.created_at <= $4 AND e.created_at <= $4`,
      [scope.chatId, scope.sentFrom, scope.sentTo, snapshotAt],
    );
    const row = result.rows[0];
    return {
      recordCount: Number(row?.record_count ?? 0),
      estimatedBytes: Number(row?.estimated_bytes ?? 0),
    };
  }

  private async selectOwnedForUpdate(
    client: PoolClient,
    id: string,
    owner: DataExportOwner,
  ): Promise<ExportJobRow | null> {
    const result = await client.query<ExportJobRow>(
      `${exportJobSelect}
       WHERE id = $1 AND ${ownerPredicate(2)}
       FOR UPDATE`,
      [id, ...ownerParameters(owner)],
    );
    return result.rows[0] ?? null;
  }

  private async readContent(
    client: PoolClient,
    job: DataExportJob,
  ): Promise<DataExportContent> {
    const messages = job.scope.types.includes("messages")
      ? await client.query<MessageRow>(
          `SELECT m.id, m.provider_message_id, m.chat_id, c.provider_chat_id,
                  c.display_name AS chat_display_name, m.sender_id, m.sent_at,
                  m.body, m.content_type, m.is_from_me, m.attachments,
                  m.link_preview_status, m.link_previews,
                  m.link_preview_error_code,
                  m.content_redacted_at, m.created_at
           FROM messages m
           INNER JOIN chats c ON c.id = m.chat_id
           WHERE c.id = $1 AND c.enabled = TRUE
             AND m.sent_at >= $2 AND m.sent_at <= $3
             AND m.created_at <= $4
           ORDER BY m.sent_at, m.id`,
          [
            job.scope.chatId,
            job.scope.sentFrom,
            job.scope.sentTo,
            job.snapshotAt,
          ],
        )
      : { rows: [] as MessageRow[] };
    const executions = job.scope.types.includes("executions")
      ? await client.query<ExecutionRow>(
          `SELECT e.id, e.source_message_id, e.trigger_id,
                  t.name AS trigger_name, w.id AS workflow_id,
                  w.name AS workflow_name, v.version AS workflow_version,
                  e.correlation_id, e.status, e.current_node_id, e.error_code,
                  e.next_retry_at, e.started_at, e.completed_at, e.created_at
           FROM workflow_executions e
           INNER JOIN messages m ON m.id = e.source_message_id
           INNER JOIN chats c ON c.id = m.chat_id
           INNER JOIN bot_triggers t ON t.id = e.trigger_id
           INNER JOIN workflow_versions v ON v.id = e.workflow_version_id
           INNER JOIN workflows w ON w.id = v.workflow_id
           WHERE c.id = $1 AND c.enabled = TRUE
             AND m.sent_at >= $2 AND m.sent_at <= $3
             AND m.created_at <= $4 AND e.created_at <= $4
           ORDER BY e.created_at, e.id`,
          [
            job.scope.chatId,
            job.scope.sentFrom,
            job.scope.sentTo,
            job.snapshotAt,
          ],
        )
      : { rows: [] as ExecutionRow[] };
    return {
      messages: messages.rows.map(messageView),
      executions: executions.rows.map(executionView),
    };
  }
}
