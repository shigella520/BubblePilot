import { describeReplyFile } from "./file-validation.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PluginSession } from "../plugins/plugin-session.js";
import type { AgentToolRegistry } from "../ai/agent-tool-registry.js";
import {
  GeneratedImageError,
  type ImageReply,
  allowedReplyFileTypes,
} from "./image-policy.js";
import type { GeneratedImageStore, ImageArtifact } from "./image-store.js";
export interface ImageReplyInput {
  config: ImageReply;
  executionId: string;
  nodeId: string;
  chatId: string;
}
export const imageReplyGuidance = `When the user asks for a file deliverable, use the bound sandbox to create or process it, then prepare ONE final file for the current chat. Textual conclusions do not require an attachment. For scripts or complex SVG, prefer write_file followed by a SHORT run_command; for simple text, an existing processed file or an authorized download, use the shortest appropriate path. Avoid nested long shell heredocs. For drawings, use native SVG and bp-render-svg with preinstalled Noto Sans CJK SC; do not use HTML foreignObject, external SVG resources or install dependencies. view_image is optional and only for supported images. Check processing success, file type and size. Use only the types declared by prepare_chat_attachment; never rename an unsupported file to bypass the limit. Reserve one tool call and time for prepare_chat_attachment after all edits. It stages one file, not an immediate send; the successful Reply node sends optional text plus the attachment. Do not output host paths, internal refs or invented download links, or claim confirmed delivery. A failed new preparation clears the previous selection. Memes and prepared attachments cannot be selected together. All tools share the existing budget; do not retry unknown remote outcomes or send an old draft.`;
const argsSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (p) =>
          p.startsWith("/workspace/") &&
          !p.includes("\\") &&
          !p.includes("\0") &&
          p
            .slice(11)
            .split("/")
            .every((v) => v && v !== "." && v !== ".."),
      ),
  })
  .strict();
export class GeneratedImageSession {
  private selected: ImageArtifact | null = null;
  private ended = false;
  private busy = false;
  private readonly abort = new AbortController();
  readonly runId = randomUUID();
  private readonly channel;
  constructor(
    readonly input: ImageReplyInput,
    plugins: PluginSession,
    private readonly store: GeneratedImageStore,
  ) {
    if (!input.config.enabled)
      throw new GeneratedImageError("IMAGE_REPLY_DISABLED");
    this.channel = plugins.imageExportChannel(input.config);
  }
  selection() {
    return this.selected ? this.store.ref(this.selected) : null;
  }
  async validate() {
    await this.channel.check();
  }
  register(registry: AgentToolRegistry) {
    registry.register({
      definition: {
        name: "prepare_chat_attachment",
        description: `Prepare one final file from this run's /workspace for reply to the current chat. Allowed types: ${allowedReplyFileTypes(this.input.config).join(", ")}. Images: at most 8 MiB; other files: at most 20 MiB. Does not send immediately. Check the result first. A new attempt clears the previous selection; only success selects the attachment.`,
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              minLength: 1,
              maxLength: 4096,
              description:
                "Absolute file path in this run's /workspace, e.g. /workspace/report.xlsx. Its basename becomes the attachment filename; use an allowed extension matching the actual format.",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      diagnostics: "metadata-only",
      execute: async (json, ctx) => {
        this.selected = null;
        if (this.busy || this.ended)
          return JSON.stringify({
            status: "failed",
            code: "IMAGE_SESSION_UNAVAILABLE",
            retryable: false,
            guidance:
              "Do not send an older draft. Check sandbox state and remaining budget.",
          });
        this.busy = true;
        const signal = AbortSignal.any([
          ctx.signal,
          this.abort.signal,
          AbortSignal.timeout(
            Math.max(1, Math.min(30_000, ctx.deadline - Date.now())),
          ),
        ]);
        try {
          const parsed = argsSchema.safeParse(JSON.parse(json));
          if (!parsed.success)
            throw new GeneratedImageError("IMAGE_PATH_DENIED");
          const descriptor = describeReplyFile(
            parsed.data.path,
            allowedReplyFileTypes(this.input.config),
          );
          const started = Date.now();
          const bytes = await this.channel.export(parsed.data.path, signal);
          const exported = Date.now();
          const artifact = await this.store.save(
            {
              ...this.input,
              runId: this.runId,
              pluginId: this.input.config.pluginId,
              server: this.input.config.server,
            },
            bytes,
            signal,
            {
              filename: descriptor.filename,
              allowedTypes: allowedReplyFileTypes(this.input.config),
            },
          );
          signal.throwIfAborted();
          await this.validate();
          return {
            text: JSON.stringify({
              status: "prepared",
              attachment_ref: "generated-attachment-1",
              filename: artifact.filename,
              mime_type: artifact.mime_type,
              width: artifact.width,
              height: artifact.height,
              bytes: artifact.size,
              delivery: "pending_reply_node",
            }),
            diagnostics: {
              artifactId: artifact.id,
              sha256: artifact.sha256,
              width: artifact.width,
              height: artifact.height,
              bytes: artifact.size,
              exportMs: exported - started,
              saveMs: Date.now() - exported,
            },
            validateCommit: async () => {
              signal.throwIfAborted();
              await this.validate();
              if (this.ended)
                throw new GeneratedImageError("IMAGE_SESSION_UNAVAILABLE");
            },
            commitResult: () => {
              signal.throwIfAborted();
              if (!this.ended) this.selected = artifact;
            },
          };
        } catch (error) {
          const code =
            error instanceof GeneratedImageError
              ? error.code
              : signal.aborted
                ? "IMAGE_EXPORT_TIMEOUT"
                : "IMAGE_PREPARATION_FAILED";
          return JSON.stringify({
            status: "failed",
            code,
            message: "The file was not selected for delivery.",
            retryable: false,
            guidance:
              "Check the file path, allowed type, actual format, size and remaining budget. Create the sandbox first if required. Do not claim the attachment was sent or reuse an older draft.",
          });
        } finally {
          this.busy = false;
        }
      },
    });
  }
  async close(success: boolean) {
    this.ended = true;
    this.abort.abort();
    await this.store.discard(
      this.runId,
      success ? this.selected?.id : undefined,
    );
  }
}
