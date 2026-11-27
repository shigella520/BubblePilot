import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  effectiveQuality,
  qualities,
  sizes,
  type Config,
  type Quality,
  type Size,
} from "./config.js";
import { ToolError, toolErrors } from "./errors.js";
import { normalizeOutput, preview } from "./images.js";
import type { DailyQuota } from "./quota.js";
import {
  NotSentError,
  type ImagesClient,
  type UpstreamImage,
} from "./upstream.js";
import { workspacePath, type Workspace } from "./workspace.js";

/** Structured operational log. Never receives prompts, image bytes or keys. */
export type Logger = (
  event: Record<string, string | number | boolean | null>,
) => void;
export const jsonLogger: Logger = (event) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));

export interface ToolDeps {
  client: ImagesClient;
  quota: DailyQuota;
  config: Pick<
    Config,
    | "IMAGE_DEFAULT_QUALITY"
    | "IMAGE_MAX_QUALITY"
    | "IMAGE_SESSION_LIMIT"
    | "IMAGE_MODEL"
  >;
  log: Logger;
}

function reply(data: Record<string, unknown>, isError = false) {
  return {
    isError,
    structuredContent: data,
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}
const guidance: Record<string, string> = {
  content_rejected:
    "The upstream safety system declined this request. Explain this to the user; do not rephrase the request to evade the policy.",
  quota_exceeded:
    "The image generation allowance is used up. Tell the user; do not retry in this run.",
  upstream_timeout:
    "The outcome is unknown and may have been billed. Do not retry automatically in this run.",
  upstream_unavailable:
    "Image generation is unavailable right now. Do not retry repeatedly.",
  input_type_unsupported:
    "Only PNG, JPEG and WebP inputs are supported for editing.",
  image_not_found:
    "Use a path returned by import_chat_attachment or a previous generate_image/edit_image call in this run.",
};
function failure(error: unknown, ws: Workspace) {
  const status =
    error instanceof ToolError && toolErrors.has(error.message)
      ? error.message
      : "image_generation_failed";
  return reply(
    {
      status,
      ...(guidance[status] ? { guidance: guidance[status] } : {}),
      sessionUsable: !ws.ended,
    },
    true,
  );
}

const prompt = z.string().trim().min(1).max(4000);
const size = z.enum(sizes).optional();
const quality = z.enum(qualities).optional();

export function registerTools(
  server: McpServer,
  ws: Workspace,
  deps: ToolDeps,
) {
  const run = async (
    operation: "generate" | "edit",
    args: { size?: Size | undefined; quality?: Quality | undefined },
    call: (
      resolved: { size: Size; quality: Quality },
      signal: AbortSignal,
    ) => Promise<UpstreamImage>,
    signal: AbortSignal,
  ) => {
    const started = Date.now();
    const resolved = {
      size: args.size ?? "1024x1024",
      quality: effectiveQuality(args.quality, deps.config),
    };
    let outcome = "failed";
    let charged = false;
    try {
      ws.check();
      if (ws.generations >= deps.config.IMAGE_SESSION_LIMIT)
        throw new ToolError("quota_exceeded");
      const release = await deps.quota.reserve();
      ws.generations += 1;
      charged = true;
      let result: UpstreamImage;
      try {
        result = await call(
          resolved,
          AbortSignal.any([signal, ws.abort.signal]),
        );
      } catch (error) {
        if (error instanceof NotSentError) {
          await release();
          ws.generations -= 1;
          charged = false;
        }
        throw error;
      }
      const output = await normalizeOutput(result.data);
      const path = ws.storeOutput(output.png, output.width, output.height);
      outcome = "generated";
      deps.log({
        event: `image_${operation}`,
        outcome,
        model: deps.config.IMAGE_MODEL,
        size: resolved.size,
        quality: resolved.quality,
        width: output.width,
        height: output.height,
        bytes: output.png.length,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        durationMs: Date.now() - started,
      });
      return reply({
        status: "generated",
        path,
        width: output.width,
        height: output.height,
        bytes: output.png.length,
        format: "png",
        sessionUsable: !ws.ended,
      });
    } catch (error) {
      outcome =
        error instanceof ToolError ? error.message : "image_generation_failed";
      deps.log({
        event: `image_${operation}`,
        outcome,
        charged,
        model: deps.config.IMAGE_MODEL,
        size: resolved.size,
        quality: resolved.quality,
        durationMs: Date.now() - started,
      });
      return failure(error, ws);
    }
  };

  server.registerTool(
    "generate_image",
    {
      description:
        "Generate ONE new image from a text prompt with the configured image model. Returns a path below /workspace/image-gen/ for this run only; send it with prepare_chat_attachment. Each call is billed and limited per day and per run: do not loop or generate drafts. Write the prompt in clear descriptive language; the outcome may take up to a few minutes.",
      inputSchema: z.strictObject({
        prompt: prompt.describe("Description of the desired image"),
        size: size.describe("Output size; default 1024x1024"),
        quality: quality.describe(
          "Quality tier; omitted uses the configured default. Higher costs more and is slower.",
        ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args, extra) =>
      run(
        "generate",
        args,
        (resolved, signal) =>
          deps.client.generate({ prompt: args.prompt, ...resolved }, signal),
        extra.signal,
      ),
  );

  server.registerTool(
    "edit_image",
    {
      description:
        "Edit images with a text instruction. images are 1-4 paths returned by import_chat_attachment (user images in this run) or by previous generate_image/edit_image calls. Returns ONE new PNG path; send it with prepare_chat_attachment. Billed and limited like generate_image. Only PNG, JPEG and WebP inputs are supported.",
      inputSchema: z.strictObject({
        prompt: prompt.describe("What to change, keep or add"),
        images: z
          .array(workspacePath)
          .min(1)
          .max(4)
          .describe("Workspace paths of the source images, first is primary"),
        size: size.describe("Output size; default 1024x1024"),
        quality: quality.describe(
          "Quality tier; omitted uses the configured default",
        ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (args, extra) => {
      let inputs;
      try {
        inputs = args.images.map((path) => {
          const file = ws.read(path);
          const extension =
            file.mime === "image/png"
              ? "png"
              : file.mime === "image/jpeg"
                ? "jpg"
                : "webp";
          return {
            data: file.data,
            mime: file.mime,
            filename: `input-${args.images.indexOf(path) + 1}.${extension}`,
          };
        });
      } catch (error) {
        return Promise.resolve(failure(error, ws));
      }
      return run(
        "edit",
        args,
        (resolved, signal) =>
          deps.client.edit(
            { prompt: args.prompt, images: inputs, ...resolved },
            signal,
          ),
        extra.signal,
      );
    },
  );

  server.registerTool(
    "view_image",
    {
      description:
        "View a bounded static preview of an image below /workspace/image-gen/ (an imported attachment or a generated result) to check it before sending. Not a delivery to the chat.",
      inputSchema: z.strictObject({ path: workspacePath }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ path }) => {
      try {
        const file = ws.read(path);
        const { data, mimeType, ...metadata } = await preview(file.data);
        return {
          isError: false,
          structuredContent: { ...metadata, sessionUsable: !ws.ended },
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...metadata,
                notice:
                  "Image preview; resizing limits apply. Tool success is not proof of model recognition.",
              }),
            },
            { type: "image" as const, mimeType, data },
          ],
        };
      } catch (error) {
        return failure(error, ws);
      }
    },
  );
}
