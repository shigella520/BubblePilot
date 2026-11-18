import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PluginSession } from "../plugins/plugin-session.js";
import type { AgentToolRegistry } from "../ai/agent-tool-registry.js";
import { GeneratedImageError, type ImageReply } from "./image-policy.js";
import type { GeneratedImageStore, ImageArtifact } from "./image-store.js";
export interface ImageReplyInput {
  config: ImageReply;
  executionId: string;
  nodeId: string;
  chatId: string;
}
export const imageReplyGuidance = `When the current user asks for a drawing, generate a PNG in the bound sandbox. Prefer ONE run_command containing a Python script that writes native SVG, calls bp-render-svg, and checks its success, dimensions and size. Use the preinstalled Noto Sans CJK SC font. Do not use HTML foreignObject, external SVG resources or install dependencies. view_image is optional for checking complex layouts; only claim visual inspection if a real preview was supplied. Reserve one tool call and sufficient time for prepare_chat_image after all edits. It safely stages one PNG for the current chat; it does NOT send immediately. Its prepared result becomes a reply attachment only after this run succeeds. Do not output paths, internal refs, invented links or claim confirmed delivery. If another preparation attempt fails the previous selection is cleared. Generated images and memes cannot be selected together. Search, import, render, view and prepare all share the existing tool budget. On failure use the explicit error; never silently send an old draft. No arbitrary file return: only prepare_chat_image PNG output is supported.`;
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
        name: "prepare_chat_image",
        description:
          "Prepare one final PNG from this run's /workspace for reply to the current chat. Does not send immediately. Call after rendering and optional visual checks. A new attempt clears the previous selection; only a successful preparation selects an image.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              minLength: 1,
              maxLength: 4096,
              description:
                "Absolute PNG path in this run's /workspace, e.g. /workspace/chart.png.",
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
          );
          signal.throwIfAborted();
          await this.validate();
          return {
            text: JSON.stringify({
              status: "prepared",
              image_ref: "generated-image-1",
              mime_type: "image/png",
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
            message: "The PNG was not selected for delivery.",
            retryable: false,
            guidance:
              "Check the file path, PNG validity, size and remaining budget. Create the sandbox first if required. Do not claim the image was sent or reuse an older draft.",
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
