import { ToolError } from "./errors.js";
import type { Quality, Size } from "./config.js";
import type { InputMime } from "./images.js";

export interface UpstreamImage {
  data: Buffer;
  usage: { inputTokens: number | null; outputTokens: number | null };
}
export interface EditInput {
  data: Buffer;
  mime: InputMime;
  filename: string;
}
export interface ImagesClient {
  generate(
    input: { prompt: string; size: Size; quality: Quality },
    signal: AbortSignal,
  ): Promise<UpstreamImage>;
  edit(
    input: {
      prompt: string;
      size: Size;
      quality: Quality;
      images: EditInput[];
    },
    signal: AbortSignal,
  ): Promise<UpstreamImage>;
}

/** Thrown when the request provably never left this process. */
export class NotSentError extends ToolError {}

const notSentCodes = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);
function causeCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (
      typeof current === "object" &&
      "code" in current &&
      typeof current.code === "string"
    )
      return current.code;
    current =
      typeof current === "object" && "cause" in current
        ? current.cause
        : undefined;
  }
  return undefined;
}

const rejectionMarkers = [
  "moderation",
  "content_policy",
  "safety",
  "policy_violation",
  "content_filter",
];

export function endpoint(base: string, path: string) {
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${prefix.endsWith("/v1") ? prefix : `${prefix}/v1`}${path}`;
  return url;
}

export interface UpstreamOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  editField: "auto" | "image" | "image[]";
  fetch?: typeof fetch;
}

/** OpenAI Images compatible client. Retries only failures before sending. */
export function imagesClient(options: UpstreamOptions): ImagesClient {
  const request = options.fetch ?? fetch;
  const send = async (
    path: string,
    init: (attempt: number) => RequestInit,
    signal: AbortSignal,
  ): Promise<UpstreamImage> => {
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(options.timeoutMs),
    ]);
    let response: Response | undefined;
    for (let attempt = 0; attempt < 2 && !response; attempt++) {
      try {
        response = await request(endpoint(options.baseUrl, path), {
          ...init(attempt),
          method: "POST",
          redirect: "error",
          signal: deadline,
        });
      } catch (error) {
        if (deadline.aborted)
          throw new ToolError(
            signal.aborted ? "upstream_unavailable" : "upstream_timeout",
          );
        const code = causeCode(error);
        if (code && notSentCodes.has(code)) {
          if (attempt === 0) continue;
          throw new NotSentError("upstream_unavailable");
        }
        // The request may have been delivered: never replay it.
        throw new ToolError("upstream_unavailable");
      }
    }
    if (!response) throw new NotSentError("upstream_unavailable");
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ToolError(
        deadline.aborted && !signal.aborted
          ? "upstream_timeout"
          : "upstream_unavailable",
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error =
        body && typeof body === "object" && "error" in body
          ? (body as { error?: { code?: unknown; type?: unknown } }).error
          : undefined;
      const field = (value: unknown) =>
        typeof value === "string" || typeof value === "number"
          ? String(value)
          : "";
      const identity =
        `${field(error?.code)} ${field(error?.type)}`.toLowerCase();
      if (rejectionMarkers.some((marker) => identity.includes(marker)))
        throw new ToolError("content_rejected");
      if (identity.includes("unsupported_file_mimetype"))
        throw new ToolError("input_type_unsupported");
      if (response.status === 400 || response.status === 422)
        throw new ToolError("invalid_arguments");
      throw new ToolError("upstream_unavailable");
    }
    const parsed = body as {
      data?: { b64_json?: unknown }[];
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    } | null;
    const b64 = parsed?.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || !b64.length)
      throw new ToolError("upstream_unavailable");
    const data = Buffer.from(b64, "base64");
    if (!data.length) throw new ToolError("upstream_unavailable");
    const tokens = (value: unknown) =>
      typeof value === "number" && Number.isSafeInteger(value) ? value : null;
    return {
      data,
      usage: {
        inputTokens: tokens(parsed?.usage?.input_tokens),
        outputTokens: tokens(parsed?.usage?.output_tokens),
      },
    };
  };
  const headers = { authorization: `Bearer ${options.apiKey}` };
  return {
    generate: (input, signal) =>
      send(
        "/images/generations",
        () => ({
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            model: options.model,
            prompt: input.prompt,
            size: input.size,
            quality: input.quality,
            n: 1,
          }),
        }),
        signal,
      ),
    edit: (input, signal) => {
      const field =
        options.editField === "auto"
          ? input.images.length > 1
            ? "image[]"
            : "image"
          : options.editField;
      return send(
        "/images/edits",
        () => {
          // A fresh FormData per attempt: bodies cannot be reused after a send.
          const form = new FormData();
          form.set("model", options.model);
          form.set("prompt", input.prompt);
          form.set("size", input.size);
          form.set("quality", input.quality);
          for (const image of input.images)
            form.append(
              field,
              new Blob([new Uint8Array(image.data)], { type: image.mime }),
              image.filename,
            );
          return { headers, body: form };
        },
        signal,
      );
    },
  };
}
