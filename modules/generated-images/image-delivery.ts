import { randomUUID, createHash } from "node:crypto";
import type { Pool } from "pg";
import type { SettingsCipher } from "../integrations/bluebubbles/settings-cipher.js";
import type {
  ReplyGateway,
  DeliveryResult,
} from "../integrations/bluebubbles/reply-gateway.js";
import { GeneratedImageError, type GeneratedImageRef } from "./image-policy.js";
import type { GeneratedImageStore, ImageArtifact } from "./image-store.js";
interface Plan {
  id: string;
  execution_id: string;
  node_id: string;
  artifact_id: string;
  text_delivery_id: string | null;
  image_delivery_id: string;
  encrypted_text: string | null;
}
interface Part {
  id: string;
  execution_id: string;
  kind: string;
  status: string;
  provider_message_id: string | null;
  provider_chat_id: string;
  provider_temp_guid: string;
  idempotency_key: string;
  error_code: string | null;
  error_summary: string | null;
  retryable: boolean | null;
  closed_at: Date | null;
}
export class GeneratedImageDelivery {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private stopped = true;
  constructor(
    private readonly pool: Pool,
    readonly store: GeneratedImageStore,
    private readonly gateway: ReplyGateway,
    private readonly cipher: SettingsCipher,
  ) {}
  async plan(input: {
    executionId: string;
    nodeId: string;
    chatId: string;
    text: string;
    image: GeneratedImageRef;
  }) {
    const client = await this.pool.connect();
    const key = `${input.executionId}:${input.nodeId}`;
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [key],
      );
      const existing = (
        await client.query<Plan>(
          "SELECT * FROM outbound_reply_plans WHERE execution_id=$1 AND node_id=$2",
          [input.executionId, input.nodeId],
        )
      ).rows[0];
      if (existing) {
        await client.query("COMMIT");
        return existing;
      }
      const asset = (
        await client.query<ImageArtifact>(
          "SELECT * FROM generated_image_artifacts WHERE id=$1 FOR UPDATE",
          [input.image.id],
        )
      ).rows[0];
      if (
        !asset ||
        asset.execution_id !== input.executionId ||
        input.image.executionId !== input.executionId ||
        asset.sha256 !== input.image.sha256 ||
        asset.provider_chat_id !== input.chatId ||
        asset.state !== "ready" ||
        asset.expires_at.getTime() <= Date.now()
      )
        throw new GeneratedImageError("GENERATED_IMAGE_UNAVAILABLE");
      const execution = await client.query(
        "SELECT id FROM workflow_executions WHERE id=$1 AND status='running' AND source_message_id IS NOT NULL",
        [input.executionId],
      );
      if (!execution.rowCount)
        throw new GeneratedImageError("IMAGE_EXECUTION_CLOSED");
      const textId = input.text.trim() ? randomUUID() : null,
        imageId = randomUUID(),
        planId = randomUUID();
      if (textId)
        await client.query(
          `INSERT INTO outbound_deliveries(id,execution_id,node_id,idempotency_key,provider,provider_chat_id,body_hash,provider_temp_guid,status,kind) VALUES($1,$2,$3,$4,'bluebubbles',$5,$6,$7,'pending','text')`,
          [
            textId,
            input.executionId,
            input.nodeId,
            key,
            input.chatId,
            createHash("sha256").update(input.text).digest("hex"),
            randomUUID(),
          ],
        );
      await client.query(
        `INSERT INTO outbound_deliveries(id,execution_id,node_id,idempotency_key,provider,provider_chat_id,body_hash,provider_temp_guid,status,kind,generated_image_id,file_hash,parent_delivery_id) VALUES($1,$2,$3,$4,'bluebubbles',$5,$6,$7,'pending','generated_image',$8,$6,$9)`,
        [
          imageId,
          input.executionId,
          input.nodeId,
          `${key}:generated-image`,
          input.chatId,
          asset.sha256,
          randomUUID(),
          asset.id,
          textId,
        ],
      );
      const plan = (
        await client.query<Plan>(
          `INSERT INTO outbound_reply_plans(id,execution_id,node_id,artifact_id,encrypted_text,text_delivery_id,image_delivery_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            planId,
            input.executionId,
            input.nodeId,
            asset.id,
            textId ? this.cipher.encrypt(input.text) : null,
            textId,
            imageId,
          ],
        )
      ).rows[0]!;
      await client.query(
        "UPDATE generated_image_artifacts SET state='bound' WHERE id=$1",
        [asset.id],
      );
      await client.query("COMMIT");
      return plan;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  private result(part: Part | undefined): DeliveryResult {
    if (part?.status === "confirmed")
      return {
        status: "confirmed",
        providerMessageId: part.provider_message_id,
      };
    if (part?.status === "failed")
      return {
        status: "failed",
        code: part.error_code ?? "IMAGE_SEND_FAILED",
        summary: part.error_summary ?? "Image reply failed.",
        retryable: !!part.retryable && !part.closed_at,
      };
    return {
      status: "unknown",
      code: "IMAGE_DELIVERY_NOT_SENDABLE",
      summary: "Delivery requires verification; do not resend.",
    };
  }
  async send(
    id: string,
    correlationId: string,
    retry = false,
  ): Promise<DeliveryResult> {
    const client = await this.pool.connect();
    let part: Part | undefined;
    let plan: Plan | undefined;
    try {
      await client.query("BEGIN");
      plan = (
        await client.query<Plan>(
          "SELECT * FROM outbound_reply_plans WHERE text_delivery_id=$1 OR image_delivery_id=$1",
          [id],
        )
      ).rows[0];
      if (!plan) throw new GeneratedImageError("IMAGE_PLAN_MISSING");
      const asset = (
        await client.query<ImageArtifact>(
          "SELECT * FROM generated_image_artifacts WHERE id=$1 FOR UPDATE",
          [plan.artifact_id],
        )
      ).rows[0];
      if (asset?.state === "bound" && asset.expires_at.getTime() > Date.now())
        part = (
          await client.query<Part>(
            `UPDATE outbound_deliveries d SET status='sending',attempt_count=attempt_count+1,send_lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=$1 AND closed_at IS NULL AND EXISTS(SELECT 1 FROM workflow_executions e WHERE e.id=d.execution_id AND e.status<>'closed') AND (status='pending' OR ($2 AND status='failed' AND retryable)) AND (parent_delivery_id IS NULL OR EXISTS(SELECT 1 FROM outbound_deliveries parent WHERE parent.id=d.parent_delivery_id AND parent.status='confirmed')) RETURNING *`,
            [id, retry],
          )
        ).rows[0];
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!part)
      return this.result(
        (
          await this.pool.query<Part>(
            "SELECT * FROM outbound_deliveries WHERE id=$1",
            [id],
          )
        ).rows[0],
      );
    const started = Date.now();
    let result: DeliveryResult;
    let dispatched = false;
    const checkLease = async () => {
      const valid = await this.pool.query(
        "SELECT d.id FROM outbound_deliveries d JOIN workflow_executions e ON e.id=d.execution_id WHERE d.id=$1 AND d.status='sending' AND d.closed_at IS NULL AND d.send_lease_until>now() AND e.status<>'closed'",
        [id],
      );
      if (!valid.rowCount)
        throw new GeneratedImageError("IMAGE_EXECUTION_CLOSED");
    };
    try {
      if (part.kind === "text") {
        if (!plan.encrypted_text)
          throw new GeneratedImageError("IMAGE_PLAN_MISSING");
        const text = this.cipher.decrypt(plan.encrypted_text);
        await checkLease();
        dispatched = true;
        result = await this.gateway.sendReply({
          providerChatId: part.provider_chat_id,
          providerTempGuid: part.provider_temp_guid,
          idempotencyKey: part.idempotency_key,
          correlationId,
          text,
          replyToProviderMessageId: null,
        });
      } else {
        const { bytes } = await this.store.read(
          plan.artifact_id,
          part.execution_id,
        );
        if (!this.gateway.sendAttachment)
          throw new GeneratedImageError("IMAGE_GATEWAY_UNAVAILABLE");
        await checkLease();
        dispatched = true;
        result = await this.gateway.sendAttachment({
          providerChatId: part.provider_chat_id,
          providerTempGuid: part.provider_temp_guid,
          idempotencyKey: part.idempotency_key,
          correlationId,
          filename: "chart.png",
          mimeType: "image/png",
          bytes,
        });
      }
    } catch (error) {
      result = dispatched
        ? {
            status: "unknown",
            code: "IMAGE_DELIVERY_RESULT_UNKNOWN",
            summary: "The image reply receipt could not be confirmed.",
          }
        : {
            status: "failed",
            code:
              error instanceof GeneratedImageError
                ? error.code
                : "GENERATED_IMAGE_UNAVAILABLE",
            summary: "The image reply could not be prepared for sending.",
            retryable: false,
          };
    }
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
    return persisted.rowCount === 1
      ? result
      : {
          status: "unknown",
          code: "IMAGE_DELIVERY_LEASE_EXPIRED",
          summary: "The delivery lease expired; late result was isolated.",
        };
  }
  async deliver(
    input: Parameters<GeneratedImageDelivery["plan"]>[0],
    correlationId: string,
  ) {
    const plan = await this.plan(input);
    const text = plan.text_delivery_id
      ? await this.send(plan.text_delivery_id, correlationId, true)
      : null;
    const image =
      !text || text.status === "confirmed"
        ? await this.send(plan.image_delivery_id, correlationId, true)
        : null;
    return {
      planId: plan.id,
      textDeliveryId: plan.text_delivery_id,
      imageDeliveryId: plan.image_delivery_id,
      text,
      image,
    };
  }
  async recover() {
    await this.pool.query(
      `UPDATE outbound_deliveries SET status='unknown',retryable=false,error_code='IMAGE_SEND_INTERRUPTED',error_summary='Interrupted image reply requires verification.',updated_at=now(),send_lease_until=NULL WHERE status='sending' AND send_lease_until<now() AND id IN (SELECT image_delivery_id FROM outbound_reply_plans UNION SELECT text_delivery_id FROM outbound_reply_plans)`,
    );
    await this.store.cleanup();
    const pending = await this.pool.query<{ id: string }>(
      `SELECT d.id FROM outbound_deliveries d JOIN outbound_reply_plans p ON d.id=p.image_delivery_id OR d.id=p.text_delivery_id JOIN workflow_executions e ON e.id=d.execution_id WHERE d.status='pending' AND d.closed_at IS NULL AND e.status<>'closed' AND d.created_at<now()-interval '30 seconds' AND (d.parent_delivery_id IS NULL OR EXISTS(SELECT 1 FROM outbound_deliveries parent WHERE parent.id=d.parent_delivery_id AND parent.status='confirmed')) ORDER BY d.created_at LIMIT 10`,
    );
    for (const row of pending.rows) await this.send(row.id, randomUUID());
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
