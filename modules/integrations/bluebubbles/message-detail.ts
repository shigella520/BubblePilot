import { z } from "zod";
import { hashJson } from "../../../app/canonical-json.js";
import {
  revisionLimits,
  type MessageRevision,
} from "../../archive/message-revision.js";
import type { BlueBubblesSettingsService } from "./settings-service.js";

const timestamp = z
  .number()
  .int()
  .nonnegative()
  .max(8_640_000_000_000_000)
  .nullable()
  .optional();
const detailSchema = z.object({
  guid: z.string().min(1).max(1024),
  text: z.string().nullable(),
  dateEdited: timestamp,
  dateRetracted: timestamp,
  partCount: z.number().int().nonnegative().optional(),
  chats: z.array(z.object({ guid: z.string() })).min(1),
  attachments: z.array(
    z.object({
      guid: z.string(),
      mimeType: z.string().nullable().optional(),
      transferName: z.string().nullable().optional(),
      totalBytes: z.number().nonnegative().nullable().optional(),
    }),
  ),
  messageSummaryInfo: z
    .array(
      z
        .object({
          retractedParts: z.array(z.number().int().nonnegative()).optional(),
        })
        .passthrough(),
    )
    .nullable()
    .optional(),
  threadOriginatorGuid: z.string().nullable().optional(),
  threadOriginatorPart: z.string().nullable().optional(),
});

export function parseMessageDetail(input: unknown): MessageRevision {
  const data = detailSchema.parse(input);
  const parts = data.messageSummaryInfo?.[0]?.retractedParts ?? [];
  const time = Math.max(data.dateEdited ?? 0, data.dateRetracted ?? 0);
  const state =
    data.dateRetracted || (parts.length && data.partCount === 0)
      ? "retracted"
      : parts.length
        ? "partial"
        : time &&
            (data.messageSummaryInfo == null || data.partCount === undefined)
          ? "unresolved"
          : "active";
  // Unverified multipart layouts are never interpreted by attachment order.
  const visible = state === "active";
  const current = {
    providerMessageId: data.guid,
    chatGuids: data.chats.map((c) => c.guid).sort(),
    sourceTime: time ? new Date(time).toISOString() : null,
    state,
    text: visible ? data.text : null,
    attachments: visible
      ? data.attachments.map((a) => ({
          providerAttachmentId: a.guid,
          mimeType: a.mimeType ?? null,
          fileName: a.transferName ?? null,
          sizeBytes: a.totalBytes ?? null,
        }))
      : [],
    reply: data.threadOriginatorGuid
      ? {
          targetGuid: data.threadOriginatorGuid,
          part: data.threadOriginatorPart ?? null,
        }
      : null,
  } satisfies Omit<MessageRevision, "hash">;
  return { ...current, hash: hashJson(current) };
}

export interface MessageDetailClient {
  read(guid: string): Promise<MessageRevision>;
}
export class ManagedMessageDetailClient implements MessageDetailClient {
  private readonly active = new Map<string, Promise<MessageRevision>>();
  constructor(
    private readonly settings: BlueBubblesSettingsService,
    private readonly request: typeof fetch = fetch,
  ) {}
  read(guid: string): Promise<MessageRevision> {
    const existing = this.active.get(guid);
    if (existing) return existing;
    if (this.active.size >= revisionLimits.concurrentDetails)
      return Promise.reject(new Error("MESSAGE_DETAIL_BUSY"));
    const task = this.run(guid).finally(() => this.active.delete(guid));
    this.active.set(guid, task);
    return task;
  }
  private async run(guid: string): Promise<MessageRevision> {
    const settings = await this.settings.resolve();
    const url = new URL(
      `/api/v1/message/${encodeURIComponent(guid)}`,
      `${settings.serverUrl}/`,
    );
    url.searchParams.set("password", settings.accessToken);
    url.searchParams.set(
      "with",
      "chats,attachments,attributedBody,messageSummaryInfo",
    );
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(settings.requestTimeoutMs, revisionLimits.timeoutMs),
    );
    try {
      const response = await this.request(url, {
        signal: controller.signal,
        redirect: "error",
        headers: { accept: "application/json" },
      });
      if (!response.ok || !response.body)
        throw new Error("MESSAGE_DETAIL_UNAVAILABLE");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          const chunk: unknown = next.value;
          if (!(chunk instanceof Uint8Array))
            throw new Error("MESSAGE_DETAIL_INVALID_STREAM");
          size += chunk.length;
          if (size > revisionLimits.responseBytes)
            throw new Error("MESSAGE_DETAIL_TOO_LARGE");
          chunks.push(chunk);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result = parseMessageDetail(
        z.object({ data: z.unknown() }).parse(body).data,
      );
      if (result.providerMessageId !== guid)
        throw new Error("MESSAGE_DETAIL_MISMATCH");
      return result;
    } catch {
      throw new Error("MESSAGE_DETAIL_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
  }
}
