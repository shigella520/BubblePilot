import { describeReplyFile } from "./file-validation.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PluginSession } from "../plugins/plugin-session.js";
import { routeWorkspacePath } from "../plugins/plugin-transport.js";
import type { AgentToolRegistry } from "../ai/agent-tool-registry.js";
import {
  GeneratedImageError,
  type ImageReply,
  allowedReplyFileTypes,
  generatedGifLimits,
  needsFileExport,
  type ImageGeneratorBinding,
  type ReplyFileType,
} from "./image-policy.js";
import type { GeneratedImageStore, ImageArtifact } from "./image-store.js";
export interface ImageReplyInput {
  /** Sandbox attachment output; absent when only a generator is bound. */
  config?: ImageReply;
  generator?: ImageGeneratorBinding;
  executionId: string;
  nodeId: string;
  chatId: string;
}
export const imageReplyGuidance = `When the user asks for a file deliverable, use the bound sandbox to create or process it, then prepare ONE final file for the current chat. Textual conclusions do not require an attachment. view_image is optional and only for supported images; its static first-frame preview cannot verify an entire animation. Check processing success, file type and size. Use only the types declared by prepare_chat_attachment; never rename an unsupported file to bypass the limit. Reserve one tool call and time for prepare_chat_attachment after all edits. It stages one file, not an immediate send; the successful Reply node sends optional text plus the attachment. Do not output host paths, internal refs or invented download links, or claim confirmed delivery. A failed new preparation clears the previous selection. Memes and prepared attachments cannot be selected together. All tools share the existing budget; do not retry unknown remote outcomes or send an old draft.`;
const generatorReplyGuidance = `An image generator plugin is bound. Use its tools for photo-quality images and for edits of chat images; keep the sandbox for charts, diagrams, SVG and file processing. Generation is slow and billed: make one well-specified generate or edit call, check the result, and do not loop on variations. If the generator reports content_rejected or quota_exceeded, explain briefly instead of rephrasing to evade the limit. Prepare exactly one returned PNG path with prepare_chat_attachment; the Reply node sends it.`;
const generatorOnlyReplyGuidance = `An image generator plugin is bound. Use its generate tool for new images and its edit tool for chat images imported with import_chat_attachment. Generation is slow and billed: make one well-specified call, check the result, and do not loop on variations. If the generator reports content_rejected or quota_exceeded, explain briefly instead of rephrasing to evade the limit. Prepare exactly one returned PNG path with prepare_chat_attachment; it stages the image and the successful Reply node sends optional text plus the attachment. Do not output internal paths or claim confirmed delivery. Memes and prepared attachments cannot be selected together.`;
/** Sandbox-only text stays byte-identical so existing prompt caches hold. */
export function replyAttachmentGuidance(targets: {
  sandbox: boolean;
  generator: boolean;
}) {
  if (!targets.generator) return imageReplyGuidance;
  return targets.sandbox
    ? `${imageReplyGuidance}\n${generatorReplyGuidance}`
    : generatorOnlyReplyGuidance;
}
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
  private readonly targets: Array<{
    pluginId: string;
    server: string;
    workspacePrefix: string;
    allowedTypes: readonly ReplyFileType[];
    file: boolean;
    channel: {
      check: () => Promise<void>;
      export: (
        path: string,
        signal: AbortSignal,
        file: boolean,
      ) => Promise<Buffer>;
    };
  }> = [];
  constructor(
    readonly input: ImageReplyInput,
    plugins: PluginSession,
    private readonly store: GeneratedImageStore,
  ) {
    if (input.config?.enabled) {
      const channel = plugins.imageExportChannel(input.config);
      this.targets.push({
        pluginId: input.config.pluginId,
        server: input.config.server,
        workspacePrefix: channel.workspacePrefix,
        allowedTypes: allowedReplyFileTypes(input.config),
        file: needsFileExport(input.config),
        channel,
      });
    }
    if (input.generator) {
      const generator = plugins.generatorChannels(input.generator);
      this.targets.push({
        ...input.generator,
        workspacePrefix: generator.workspacePrefix,
        allowedTypes: ["png"],
        file: false,
        channel: generator.export,
      });
    }
    if (!this.targets.length)
      throw new GeneratedImageError("IMAGE_REPLY_DISABLED");
  }
  boundTargets() {
    return {
      sandbox: !!this.input.config?.enabled,
      generator: !!this.input.generator,
    };
  }
  selection() {
    return this.selected ? this.store.ref(this.selected) : null;
  }
  async validate() {
    for (const target of this.targets) await target.channel.check();
  }
  private describeTargets() {
    return this.targets
      .map((t) =>
        this.targets.length === 1
          ? `Allowed types: ${t.allowedTypes.join(", ")}.`
          : `Paths under ${t.workspacePrefix}${t.workspacePrefix === "/workspace/" ? " (sandbox)" : " (image generator)"} allow: ${t.allowedTypes.join(", ")}.`,
      )
      .join(" ");
  }
  register(registry: AgentToolRegistry) {
    registry.register({
      definition: {
        name: "prepare_chat_attachment",
        description: `Prepare one final file from this run's /workspace for reply to the current chat. ${this.describeTargets()} Images: at most 8 MiB; other files: at most 20 MiB.${this.targets.some((t) => t.allowedTypes.includes("gif")) ? ` GIF animation is preserved: at most ${generatedGifLimits.frames} frames, ${generatedGifLimits.totalPixels} total canvas pixels across all frames, 16 million pixels per frame and 8192 pixels per edge. Prepare the .gif directly; ZIP is not required.` : ""} Does not send immediately. Check the result first. A new attempt clears the previous selection; only success selects the attachment.`,
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              minLength: 1,
              maxLength: 4096,
              description:
                "Absolute file path returned in this run, e.g. /workspace/report.xlsx or an image generator output path. Its basename becomes the attachment filename; use an allowed extension matching the actual format.",
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
          const target = routeWorkspacePath(parsed.data.path, this.targets);
          if (!target) throw new GeneratedImageError("IMAGE_PATH_DENIED");
          const descriptor = describeReplyFile(
            parsed.data.path,
            target.allowedTypes,
          );
          const started = Date.now();
          const bytes = await target.channel.export(
            parsed.data.path,
            signal,
            target.file,
          );
          const exported = Date.now();
          const artifact = await this.store.save(
            {
              ...this.input,
              runId: this.runId,
              pluginId: target.pluginId,
              server: target.server,
            },
            bytes,
            signal,
            {
              filename: descriptor.filename,
              allowedTypes: target.allowedTypes,
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
