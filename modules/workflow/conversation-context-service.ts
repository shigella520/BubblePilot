import type { Pool, PoolClient } from "pg";
import type { MessageAuthor } from "../identity/bot-identity.js";
import type { ImageSummaryRepository } from "../ai/image-summary-repository.js";
import type { ContextMessage } from "../archive/archive-repository.js";
import type { MessageAttachment } from "../ingestion/message-envelope.js";
import {
  linkPreviewItemSchema,
  linkPreviewStatusSchema,
  type LinkPreviewBundle,
} from "../ingestion/link-preview.js";
import { createPostgresPool } from "../shared/postgres-pool.js";
import type { ContextRuntimeSettings } from "./context-settings-types.js";
interface MessageRow {
  message_index: string;
  provider_message_id: string;
  sender_id: string | null;
  sent_at: Date;
  body: string;
  is_from_me: boolean;
  author?: MessageAuthor;
  attachments: unknown;
  link_preview_status: string;
  link_previews: unknown;
  link_preview_error_code: string | null;
}

export interface IndexedContextMessage extends ContextMessage {
  messageIndex: string;
}

export interface HistoryMessageRange {
  count: number;
  firstMessageIndex: string;
  lastMessageIndex: string;
  earliestSentAt: string;
  latestSentAt: string;
}
export interface HistoryCoverage {
  retained: HistoryMessageRange | null;
  omitted: HistoryMessageRange | null;
  windowEvicted: HistoryMessageRange | null;
}
export function messageRange(
  messages: readonly IndexedContextMessage[],
): HistoryMessageRange | null {
  const first = messages[0],
    last = messages.at(-1);
  if (!first || !last) return null;
  const times = messages.map((m) => Date.parse(m.sentAt));
  return {
    count: messages.length,
    firstMessageIndex: first.messageIndex,
    lastMessageIndex: last.messageIndex,
    earliestSentAt: new Date(Math.min(...times)).toISOString(),
    latestSentAt: new Date(Math.max(...times)).toISOString(),
  };
}
export function historyCoverage(
  candidates: readonly IndexedContextMessage[],
  retained: readonly ContextMessage[],
  windowEvicted: HistoryMessageRange | null = null,
): HistoryCoverage {
  const ids = new Set(retained.map((m) => m.providerMessageId));
  return {
    retained: messageRange(
      candidates.filter((m) => ids.has(m.providerMessageId)),
    ),
    omitted: messageRange(
      candidates.filter((m) => !ids.has(m.providerMessageId)),
    ),
    windowEvicted,
  };
}
export function retainedWindowCount(
  count: number,
  base: number,
  buffer: number,
): number {
  return count < base + buffer
    ? count
    : count - Math.floor((count - base) / buffer) * buffer;
}
export interface ConversationContextSnapshot {
  contract: "raw-context-v1";
  chatId: string;
  triggerMessageIndex: string;
  afterMessageIndex: string;
  settings: ContextRuntimeSettings;
  settingsVersion: number;
  compatibilityInitialized: boolean;
}
export interface ConversationContextTrigger {
  triggerMessageIndex: string;
  contextSnapshot: ConversationContextSnapshot;
}
export interface ConversationContextLoadInput {
  executionId: string | null;
  provider: string;
  providerChatId: string;
  beforeProviderMessageId: string;
  settings: ContextRuntimeSettings;
  settingsVersion: number;
  contextSnapshot?: ConversationContextSnapshot | null;
}
export interface ConversationContextResult {
  messages: readonly ContextMessage[];
  contextSnapshot: ConversationContextSnapshot;
  contextCharacters: number;
  temporaryOverflowCharacters: number;
  truncatedMessageCount: number;
  contextIncomplete: boolean;
  historyCoverage: HistoryCoverage;
  contextIncompleteReasons: string[];
}
function linkPreview(row: MessageRow): LinkPreviewBundle {
  const status = linkPreviewStatusSchema.safeParse(row.link_preview_status);
  const items = Array.isArray(row.link_previews)
    ? row.link_previews.flatMap((item) => {
        const parsed = linkPreviewItemSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  return {
    status: status.success ? status.data : "failed",
    errorCode: row.link_preview_error_code,
    items,
  };
}

function attachments(value: unknown): readonly MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.providerAttachmentId !== "string") return [];
    return [
      {
        providerAttachmentId: record.providerAttachmentId,
        mimeType: typeof record.mimeType === "string" ? record.mimeType : null,
        fileName: typeof record.fileName === "string" ? record.fileName : null,
        sizeBytes:
          typeof record.sizeBytes === "number" ? record.sizeBytes : null,
      },
    ];
  });
}

function contextMessage(row: MessageRow): IndexedContextMessage {
  return {
    messageIndex: row.message_index,
    providerMessageId: row.provider_message_id,
    senderId: row.sender_id,
    sentAt: row.sent_at.toISOString(),
    body: row.body,
    isFromMe: row.is_from_me,
    ...(row.author ? { author: row.author } : {}),
    attachments: attachments(row.attachments),
    linkPreview: linkPreview(row),
  };
}

function messageCharacters(message: ContextMessage): number {
  const previewCharacters = message.linkPreview.items.reduce(
    (total, item) =>
      total +
      item.url.length +
      (item.title?.length ?? 0) +
      (item.summary?.length ?? 0) +
      (item.siteName?.length ?? 0),
    0,
  );
  const attachmentCharacters = message.attachments.reduce(
    (total, attachment) =>
      total +
      attachment.providerAttachmentId.length +
      (attachment.mimeType?.length ?? 0) +
      (attachment.fileName?.length ?? 0),
    0,
  );
  const imageSummaryCharacters = (message.imageSummaries ?? []).reduce(
    (total, summary) =>
      total +
      (summary.status === "succeeded" ? (summary.summary?.length ?? 0) : 0),
    0,
  );
  return (
    message.body.length +
    previewCharacters +
    attachmentCharacters +
    imageSummaryCharacters
  );
}

/**
 * Apply the context-extraction character budget without splitting messages.
 * The returned value is the newest contiguous suffix that fits. If the
 * newest message is itself larger than the budget it is retained so callers
 * can surface `contextIncomplete` instead of silently dropping current data.
 */
export function fitContextMessages(
  messages: readonly ContextMessage[],
  characterLimit: number,
): readonly ContextMessage[] {
  const selected: ContextMessage[] = [];
  let characters = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const size = messageCharacters(message);
    if (characters + size > characterLimit) {
      if (selected.length === 0) selected.unshift(message);
      break;
    }
    selected.unshift(message);
    characters += size;
  }
  return selected;
}

export class ConversationContextService {
  private readonly pool: Pool;
  constructor(
    databaseUrl: string,
    queryTimeoutMs?: number,
    private readonly imageSummaries?: Pick<
      ImageSummaryRepository,
      "listForProviderMessageIds"
    >,
  ) {
    this.pool = createPostgresPool(databaseUrl, 5, queryTimeoutMs);
  }
  close() {
    return this.pool.end();
  }
  private eligible() {
    return `c.enabled AND c.deleted_at IS NULL AND ($3::boolean OR NOT m.is_from_me)
 AND ((m.body IS NOT NULL AND m.body<>'') OR m.link_preview_status='available' OR m.attachments<>'[]'::jsonb)`;
  }
  async snapshotForMessage(input: {
    provider: string;
    providerChatId: string;
    providerMessageId: string;
    settings: ContextRuntimeSettings;
    settingsVersion: number;
    compatibilityInitialized?: boolean;
  }): Promise<ConversationContextTrigger> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const chat = (
        await db.query<{ id: string }>(
          `SELECT id FROM chats WHERE provider=$1 AND provider_chat_id=$2 AND enabled AND deleted_at IS NULL FOR UPDATE`,
          [input.provider, input.providerChatId],
        )
      ).rows[0];
      if (!chat) throw new Error("Context chat unavailable.");
      const boundary = (
        await db.query<{ message_index: string }>(
          `SELECT message_index::text FROM messages WHERE chat_id=$1 AND provider_message_id=$2`,
          [chat.id, input.providerMessageId],
        )
      ).rows[0];
      if (!boundary) throw new Error("Context trigger unavailable.");
      const trigger = boundary.message_index;
      const saved = (
        await db.query<{ snapshot: ConversationContextSnapshot }>(
          `SELECT snapshot FROM conversation_context_windows WHERE chat_id=$1 AND trigger_message_index=$2`,
          [chat.id, trigger],
        )
      ).rows[0];
      if (saved) {
        await db.query("COMMIT");
        return {
          triggerMessageIndex: trigger,
          contextSnapshot: saved.snapshot,
        };
      }
      const previous = (
        await db.query<{ snapshot: ConversationContextSnapshot }>(
          `SELECT snapshot FROM conversation_context_windows WHERE chat_id=$1 AND trigger_message_index<$2 ORDER BY trigger_message_index DESC LIMIT 1`,
          [chat.id, trigger],
        )
      ).rows[0]?.snapshot;
      const settings = {
        includeFromMe: input.settings.includeFromMe,
        baseMessageWindow: input.settings.baseMessageWindow,
        redundancyMessageWindow: input.settings.redundancyMessageWindow,
        characterLimit: input.settings.characterLimit,
      };
      const same =
        !input.compatibilityInitialized &&
        previous &&
        previous.settings.baseMessageWindow === settings.baseMessageWindow &&
        previous.settings.redundancyMessageWindow ===
          settings.redundancyMessageWindow &&
        previous.settings.includeFromMe === settings.includeFromMe;
      const after = same ? previous.afterMessageIndex : "0";
      const values = [chat.id, trigger, settings.includeFromMe, after];
      const count = Number(
        (
          await db.query<{ count: string }>(
            `SELECT count(*)::text FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.chat_id=$1 AND m.message_index<$2 AND m.message_index>$4 AND ${this.eligible()}`,
            values,
          )
        ).rows[0]?.count ?? 0,
      );
      const keep = same
        ? retainedWindowCount(
            count,
            settings.baseMessageWindow,
            settings.redundancyMessageWindow,
          )
        : Math.min(count, settings.baseMessageWindow);
      // Find the last omitted actual row, rather than treating index gaps as messages.
      const omitted = (
        await db.query<{ message_index: string }>(
          `SELECT m.message_index::text FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.chat_id=$1 AND m.message_index<$2 AND m.message_index>$4 AND ${this.eligible()} ORDER BY m.message_index DESC OFFSET $5 LIMIT 1`,
          [...values, keep],
        )
      ).rows[0];
      const snapshot: ConversationContextSnapshot = {
        contract: "raw-context-v1",
        chatId: chat.id,
        triggerMessageIndex: trigger,
        afterMessageIndex: omitted?.message_index ?? after,
        settings,
        settingsVersion: input.settingsVersion,
        compatibilityInitialized: input.compatibilityInitialized ?? false,
      };
      await db.query(
        `INSERT INTO conversation_context_windows(chat_id,trigger_message_index,snapshot) VALUES($1,$2,$3::jsonb)`,
        [chat.id, trigger, JSON.stringify(snapshot)],
      );
      await db.query("COMMIT");
      return { triggerMessageIndex: trigger, contextSnapshot: snapshot };
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  async load(
    input: ConversationContextLoadInput,
  ): Promise<ConversationContextResult> {
    // Store the fallback before reading evidence so subsequent retries keep its boundary.
    const snapshot =
      input.contextSnapshot?.contract === "raw-context-v1"
        ? input.contextSnapshot
        : (
            await this.snapshotForMessage({
              provider: input.provider,
              providerChatId: input.providerChatId,
              providerMessageId: input.beforeProviderMessageId,
              settings: input.settings,
              settingsVersion: input.settingsVersion,
              compatibilityInitialized: true,
            })
          ).contextSnapshot;
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const authorized = await db.query(
        `SELECT 1 FROM chats c JOIN messages m ON m.chat_id=c.id WHERE c.id=$1 AND c.provider=$2 AND c.provider_chat_id=$3 AND c.enabled AND c.deleted_at IS NULL AND m.provider_message_id=$4 AND m.message_index=$5`,
        [
          snapshot.chatId,
          input.provider,
          input.providerChatId,
          input.beforeProviderMessageId,
          snapshot.triggerMessageIndex,
        ],
      );
      if (!authorized.rowCount)
        throw new Error("Context authorization or trigger unavailable.");
      const values = [
        snapshot.chatId,
        snapshot.triggerMessageIndex,
        snapshot.settings.includeFromMe,
        snapshot.afterMessageIndex,
      ];
      const rows = await db.query<MessageRow>(
        `SELECT m.message_index::text,m.provider_message_id,m.sender_id,m.sent_at,COALESCE(m.body,'') AS body,m.is_from_me,bot_message_author(m.id) AS author,m.attachments,m.link_preview_status,m.link_previews,m.link_preview_error_code FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.chat_id=$1 AND m.message_index<$2 AND m.message_index>$4 AND ${this.eligible()} ORDER BY m.message_index`,
        values,
      );
      const windowEvicted = await this.evictedRange(db, values);
      await db.query("COMMIT");
      const raw = rows.rows.map(contextMessage);
      const images = await this.imageSummaries?.listForProviderMessageIds(
        raw.map((m) => m.providerMessageId),
      );
      const candidates = raw.map((m) => ({
        ...m,
        imageSummaries: images?.get(m.providerMessageId) ?? [],
      }));
      const messages = fitContextMessages(
        candidates,
        snapshot.settings.characterLimit,
      );
      const characters = messages.reduce((n, m) => n + messageCharacters(m), 0);
      const reasons = [
        ...(windowEvicted ? ["window-evicted"] : []),
        ...(messages.length < candidates.length ? ["history-trimmed"] : []),
        ...(characters > snapshot.settings.characterLimit
          ? ["character-overflow"]
          : []),
      ];
      return {
        messages,
        contextSnapshot: snapshot,
        contextCharacters: characters,
        temporaryOverflowCharacters: Math.max(
          0,
          characters - snapshot.settings.characterLimit,
        ),
        truncatedMessageCount: candidates.length - messages.length,
        contextIncomplete: reasons.length > 0,
        historyCoverage: historyCoverage(candidates, messages, windowEvicted),
        contextIncompleteReasons: reasons,
      };
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  private async evictedRange(
    db: PoolClient,
    values: unknown[],
  ): Promise<HistoryMessageRange | null> {
    const row = (
      await db.query<{
        count: string;
        first: string | null;
        last: string | null;
        earliest: Date | null;
        latest: Date | null;
      }>(
        `SELECT count(*)::text,min(m.message_index)::text AS first,max(m.message_index)::text AS last,min(m.sent_at) AS earliest,max(m.sent_at) AS latest FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.chat_id=$1 AND m.message_index<$2 AND m.message_index<=$4 AND ${this.eligible()}`,
        values,
      )
    ).rows[0];
    return row?.first && row.last && row.earliest && row.latest
      ? {
          count: Number(row.count),
          firstMessageIndex: row.first,
          lastMessageIndex: row.last,
          earliestSentAt: row.earliest.toISOString(),
          latestSentAt: row.latest.toISOString(),
        }
      : null;
  }
}
