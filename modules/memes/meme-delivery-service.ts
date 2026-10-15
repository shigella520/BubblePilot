import { randomUUID, createHash } from "node:crypto";
import type { Pool } from "pg";
import type { SettingsCipher } from "../integrations/bluebubbles/settings-cipher.js";
import type {
  ReplyGateway,
  DeliveryResult,
} from "../integrations/bluebubbles/reply-gateway.js";
import type { MemeService } from "./meme-service.js";
import type { SelectedMeme } from "./meme-types.js";
interface Part {
  id: string;
  kind: "text" | "meme";
  status: "pending" | "sending" | "confirmed" | "failed" | "unknown";
  provider_chat_id: string;
  provider_temp_guid: string;
  idempotency_key: string;
  meme_id: string | null;
  file_hash: string | null;
  parent_delivery_id: string | null;
  closed_at: Date | null;
  retryable: boolean | null;
  error_code: string | null;
}
export class MemeDeliveryService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private stopped = true;
  constructor(
    private readonly pool: Pool,
    private readonly library: MemeService,
    private readonly gateway: ReplyGateway,
    private readonly cipher: SettingsCipher,
  ) {}
  async plan(input: {
    executionId: string;
    nodeId: string;
    chatId: string;
    text: string;
    meme: SelectedMeme;
  }) {
    const client = await this.pool.connect();
    const key = `${input.executionId}:${input.nodeId}`;
    const textHash = createHash("sha256").update(input.text).digest("hex");
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [key],
      );
      const existing = await client.query<Part>(
        "SELECT * FROM outbound_deliveries WHERE idempotency_key=$1",
        [key],
      );
      if (existing.rows[0]) {
        const part = await client.query<Part>(
          "SELECT * FROM outbound_deliveries WHERE parent_delivery_id=$1 AND kind='meme'",
          [existing.rows[0].id],
        );
        if (!part.rows[0]) throw new Error("MEME_PLAN_CONFLICT");
        await client.query("COMMIT");
        return { textId: existing.rows[0].id, memeId: part.rows[0].id };
      }
      const textId = randomUUID(),
        memeId = randomUUID();
      await client.query(
        "INSERT INTO outbound_deliveries(id,execution_id,node_id,idempotency_key,provider,provider_chat_id,body_hash,provider_temp_guid,status,kind) VALUES($1,$2,$3,$4,'bluebubbles',$5,$6,$7,'pending','text')",
        [
          textId,
          input.executionId,
          input.nodeId,
          key,
          input.chatId,
          textHash,
          randomUUID(),
        ],
      );
      await client.query(
        "INSERT INTO outbound_deliveries(id,execution_id,node_id,idempotency_key,provider,provider_chat_id,body_hash,provider_temp_guid,status,kind,meme_id,meme_name,file_hash,parent_delivery_id) VALUES($1,$2,$3,$4,'bluebubbles',$5,$6,$7,'pending','meme',$8,$9,$6,$10)",
        [
          memeId,
          input.executionId,
          input.nodeId,
          `${key}:meme`,
          input.chatId,
          input.meme.hash,
          randomUUID(),
          input.meme.id,
          input.meme.name,
          textId,
        ],
      );
      await client.query(
        "INSERT INTO meme_reply_plans(text_delivery_id,encrypted_text) VALUES($1,$2)",
        [textId, this.cipher.encrypt(input.text)],
      );
      await client.query("COMMIT");
      return { textId, memeId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async send(
    id: string,
    correlationId: string,
    retry = false,
  ): Promise<DeliveryResult> {
    const claim = await this.pool.query<Part>(
      `UPDATE outbound_deliveries d SET status='sending',attempt_count=attempt_count+1,send_lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=$1 AND closed_at IS NULL AND EXISTS(SELECT 1 FROM workflow_executions e WHERE e.id=d.execution_id AND e.status<>'closed') AND (status='pending' OR ($2 AND status='failed' AND retryable)) AND (kind='text' OR EXISTS(SELECT 1 FROM outbound_deliveries parent WHERE parent.id=d.parent_delivery_id AND parent.status='confirmed')) RETURNING *`,
      [id, retry],
    );
    const part = claim.rows[0];
    if (!part) {
      const row = (
        await this.pool.query<Part>(
          "SELECT * FROM outbound_deliveries WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (row?.status === "confirmed")
        return { status: "confirmed", providerMessageId: null };
      return {
        status: "unknown",
        code: "MEME_DELIVERY_NOT_SENDABLE",
        summary: "Delivery is not eligible for sending.",
      };
    }
    const started = Date.now();
    let result: DeliveryResult;
    try {
      if (part.kind === "text") {
        const plan = (
          await this.pool.query<{ encrypted_text: string }>(
            "SELECT encrypted_text FROM meme_reply_plans WHERE text_delivery_id=$1",
            [id],
          )
        ).rows[0];
        if (!plan) throw new Error("MISSING_PLAN");
        result = await this.gateway.sendReply({
          providerChatId: part.provider_chat_id,
          text: this.cipher.decrypt(plan.encrypted_text),
          replyToProviderMessageId: null,
          idempotencyKey: part.idempotency_key,
          providerTempGuid: part.provider_temp_guid,
          correlationId,
        });
      } else {
        const asset = part.meme_id
          ? await this.library.repository.get(part.meme_id)
          : null;
        if (!asset?.enabled || asset.hash !== part.file_hash)
          result = {
            status: "failed",
            code: "MEME_ASSET_UNAVAILABLE",
            summary: "The selected meme is disabled or deleted.",
            retryable: false,
          };
        else if (!this.gateway.sendAttachment)
          result = {
            status: "failed",
            code: "MEME_GATEWAY_UNAVAILABLE",
            summary: "Attachment gateway unavailable.",
            retryable: true,
          };
        else {
          let bytes: Buffer | null = null;
          try {
            bytes = await this.library.files.read(asset.storageKey);
          } catch {
            /* Clearly no request has been sent. */
          }
          result = bytes
            ? await this.gateway.sendAttachment({
                providerChatId: part.provider_chat_id,
                providerTempGuid: part.provider_temp_guid,
                idempotencyKey: part.idempotency_key,
                correlationId,
                filename: `meme.${asset.mimeType.split("/")[1]}`,
                mimeType: asset.mimeType,
                bytes,
              })
            : {
                status: "failed",
                code: "MEME_FILE_MISSING",
                summary: "The meme file is unavailable.",
                retryable: true,
              };
        }
      }
    } catch {
      result = {
        status: "unknown",
        code: "MEME_DELIVERY_RESULT_UNKNOWN",
        summary: "The delivery could not be confirmed.",
      };
    }
    // Never let a response arriving after recovery or manual closure overwrite evidence.
    const persisted = await this.pool.query(
      `UPDATE outbound_deliveries SET status=$2,provider_message_id=$3,error_code=$4,error_summary=$5,retryable=$6,duration_ms=$7,confirmed_at=CASE WHEN $2='confirmed' THEN now() ELSE NULL END,updated_at=now(),send_lease_until=NULL WHERE id=$1 AND status='sending' AND closed_at IS NULL AND send_lease_until>now()`,
      [
        id,
        result.status,
        result.status === "confirmed" ? result.providerMessageId : null,
        result.status === "confirmed" ? null : result.code,
        result.status === "confirmed" ? null : result.summary,
        result.status === "failed" ? result.retryable : false,
        Date.now() - started,
      ],
    );
    if (persisted.rowCount !== 1)
      return {
        status: "unknown",
        code: "MEME_DELIVERY_LEASE_EXPIRED",
        summary: "Delivery lease expired; late response was isolated.",
      };
    return result;
  }
  async deliver(
    input: Parameters<MemeDeliveryService["plan"]>[0],
    correlationId: string,
  ) {
    const plan = await this.plan(input);
    const text = await this.send(plan.textId, correlationId, true);
    if (text.status !== "confirmed") return { text, image: null, ...plan };
    let image: DeliveryResult;
    try {
      image = await this.send(plan.memeId, correlationId);
    } catch {
      image = {
        status: "unknown",
        code: "MEME_DELIVERY_STATE_UNAVAILABLE",
        summary: "Text confirmed; image delivery state requires verification.",
      };
    }
    return { text, image, ...plan };
  }
  async thumbnail(id: string) {
    const row = (
      await this.pool.query<{ storage_key: string }>(
        "SELECT a.storage_key FROM outbound_deliveries d JOIN meme_assets a ON a.id=d.meme_id WHERE d.id=$1 AND d.kind='meme'",
        [id],
      )
    ).rows[0];
    if (!row) return null;
    try {
      return await this.library.files.read(row.storage_key, true);
    } catch {
      return null;
    }
  }
  async list(executionId?: string) {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id,execution_id AS "executionId",node_id AS "nodeId",meme_id AS "memeId",meme_name AS "memeName",(SELECT p.status FROM outbound_deliveries p WHERE p.id=outbound_deliveries.parent_delivery_id) AS "textStatus",kind,status,error_code AS "errorCode",error_summary AS "errorSummary",duration_ms AS "durationMs",retryable,closed_at AS "closedAt",provider_message_id AS "providerMessageId" FROM outbound_deliveries WHERE kind='meme' AND ($1::uuid IS NULL OR execution_id=$1) AND ($1::uuid IS NOT NULL OR (closed_at IS NULL AND status IN ('failed','unknown') AND EXISTS(SELECT 1 FROM outbound_deliveries p WHERE p.id=outbound_deliveries.parent_delivery_id AND p.status='confirmed') AND EXISTS(SELECT 1 FROM workflow_executions e WHERE e.id=outbound_deliveries.execution_id AND e.status<>'closed'))) ORDER BY created_at DESC LIMIT 100`,
      [executionId ?? null],
    );
    return result.rows;
  }
  async retry(id: string, correlationId: string) {
    const part = (
      await this.pool.query<Part>(
        "SELECT * FROM outbound_deliveries WHERE id=$1 AND kind='meme' AND status='failed' AND retryable AND closed_at IS NULL",
        [id],
      )
    ).rows[0];
    if (!part) return null;
    return this.send(id, correlationId, true);
  }
  async close(id: string) {
    return (
      (
        await this.pool.query(
          "UPDATE outbound_deliveries SET closed_at=now(),updated_at=now() WHERE id=$1 AND kind='meme' AND status IN ('failed','unknown') AND closed_at IS NULL",
          [id],
        )
      ).rowCount === 1
    );
  }
  async recover() {
    await this.pool.query(
      "UPDATE outbound_deliveries SET status='unknown',retryable=false,error_code='MEME_SEND_INTERRUPTED',error_summary='Interrupted delivery requires manual confirmation.',updated_at=now() WHERE send_lease_until<now() AND status='sending'",
    );
    const pendingText = await this.pool.query<{ id: string }>(
      "SELECT d.id FROM outbound_deliveries d JOIN meme_reply_plans p ON p.text_delivery_id=d.id JOIN workflow_executions e ON e.id=d.execution_id WHERE d.status='pending' AND e.status<>'closed' AND d.created_at<now()-interval '30 seconds' ORDER BY d.created_at LIMIT 10",
    );
    for (const part of pendingText.rows) await this.send(part.id, randomUUID());
    const parts = await this.pool.query<{ id: string }>(
      "SELECT d.id FROM outbound_deliveries d JOIN outbound_deliveries p ON p.id=d.parent_delivery_id JOIN workflow_executions e ON e.id=d.execution_id WHERE e.status<>'closed' AND d.kind='meme' AND d.status='pending' AND d.closed_at IS NULL AND p.status='confirmed' AND d.created_at<now()-interval '30 seconds' ORDER BY d.created_at LIMIT 10",
    );
    for (const part of parts.rows) await this.send(part.id, randomUUID());
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      this.active = this.recover()
        .catch(() => undefined)
        .finally(() => {
          this.active = undefined;
          if (!this.stopped) this.timer = setTimeout(tick, 10_000);
        });
    };
    tick();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }
}
