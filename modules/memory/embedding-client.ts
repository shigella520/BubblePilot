import { ApplicationError } from "../../app/errors.js";
import { z } from "zod";

export const embeddingConfigSchema = z.object({
  protocol: z.enum(["ollama", "openai-compatible"]),
  baseUrl: z
    .string()
    .url()
    .max(2048)
    .refine((value) => {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }, "Use an HTTP(S) endpoint without embedded credentials or query parameters"),
  model: z.string().trim().min(1).max(200),
  dimensions: z.number().int().min(1).max(16000),
  modelVersion: z.string().trim().min(1).max(200),
  queryPrefix: z.string().max(1000).default(""),
});
export type EmbeddingConfig = z.infer<typeof embeddingConfigSchema>;
/**
 * Sanitized failure facts for operators. Never holds the provider body,
 * request input, endpoint credentials or free-form upstream messages.
 */
export interface EmbeddingFailureDetail {
  kind: "timeout" | "network" | "http" | "response";
  httpStatus?: number;
  /** Upstream/gateway request identifier, for support tickets. */
  upstreamRequestId?: string;
  /** Upstream machine error code or type token, e.g. api_error. */
  upstreamCode?: string;
  elapsedMs?: number;
  timeoutMs?: number;
}
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/u;
const upstreamCodePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function embeddingFailureText(detail?: EmbeddingFailureDetail): string {
  if (!detail) return "";
  const parts = [
    detail.kind === "timeout"
      ? `超时${detail.timeoutMs ? ` ${Math.round(detail.timeoutMs / 1000)} 秒` : ""}`
      : detail.kind === "network"
        ? "连接失败"
        : undefined,
    detail.httpStatus ? `HTTP ${detail.httpStatus}` : undefined,
    detail.upstreamCode,
    detail.upstreamRequestId
      ? `上游请求 ID ${detail.upstreamRequestId}`
      : undefined,
  ].filter(Boolean);
  return parts.length ? `（${parts.join(" · ")}）` : "";
}

export class EmbeddingError extends ApplicationError {
  readonly detail?: EmbeddingFailureDetail;
  constructor(
    code: string,
    readonly httpStatus?: number,
    detail?: EmbeddingFailureDetail,
  ) {
    super(
      code,
      `Embedding 服务暂不可用或返回不符合模型合同的数据。${embeddingFailureText(detail)}`,
      503,
    );
    if (detail) this.detail = detail;
  }
}

/** Pulls only identifier-shaped tokens out of an error response. */
async function upstreamFailure(
  response: Response,
): Promise<Pick<EmbeddingFailureDetail, "upstreamRequestId" | "upstreamCode">> {
  const header = ["x-request-id", "x-oneapi-request-id", "request-id"]
    .map((name) => response.headers.get(name)?.trim())
    .find((value) => value && requestIdPattern.test(value));
  let body = "";
  try {
    if (response.body) {
      const reader =
        response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const parts: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (bytes < 16384) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          parts.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      body = Buffer.concat(parts).toString("utf8").slice(0, 16384);
    }
  } catch {
    // Detail extraction is best-effort; the status code is still recorded.
  }
  let code: string | undefined;
  let message = "";
  try {
    const parsed = JSON.parse(body) as unknown;
    const error =
      parsed && typeof parsed === "object" && "error" in parsed
        ? parsed.error
        : parsed;
    if (error && typeof error === "object") {
      const e = error as Record<string, unknown>;
      code = [e.code, e.type, e.status]
        .map((v) => (typeof v === "number" ? String(v) : v))
        .find(
          (v): v is string =>
            typeof v === "string" && upstreamCodePattern.test(v),
        );
      if (typeof e.message === "string") message = e.message;
    } else if (typeof error === "string") message = error;
  } catch {
    message = body;
  }
  const fromBody =
    /request[ _-]?id[\s:=]+["']?([A-Za-z0-9][A-Za-z0-9._:-]{3,127})/iu.exec(
      message,
    )?.[1];
  const requestId = header ?? fromBody;
  return {
    ...(requestId && requestIdPattern.test(requestId)
      ? { upstreamRequestId: requestId }
      : {}),
    ...(code ? { upstreamCode: code } : {}),
  };
}
export interface EmbeddingClient {
  encode(
    config: EmbeddingConfig,
    secret: string | null,
    input: readonly string[],
    timeoutMs?: number,
  ): Promise<number[][]>;
  identity(
    config: EmbeddingConfig,
    secret: string | null,
    timeoutMs?: number,
  ): Promise<string>;
}

/** Only administrator-saved endpoints enter this adapter. Redirects are forbidden. */
export class HttpEmbeddingClient implements EmbeddingClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async request(
    config: EmbeddingConfig,
    secret: string | null,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const url = `${config.baseUrl.replace(/\/+$/u, "")}/${path}`;
    const started = Date.now();
    const elapsed = () => ({ elapsedMs: Date.now() - started });
    try {
      const response = await this.fetcher(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        throw new EmbeddingError(
          "MEMORY_EMBEDDING_HTTP_ERROR",
          response.status,
          {
            kind: "http",
            httpStatus: response.status,
            ...(await upstreamFailure(response)),
            ...elapsed(),
          },
        );
      if (!response.body)
        throw new EmbeddingError("MEMORY_EMBEDDING_EMPTY", undefined, {
          kind: "response",
          ...elapsed(),
        });
      const reader =
        response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const parts: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 4 * 1024 * 1024)
            throw new EmbeddingError("MEMORY_EMBEDDING_TOO_LARGE", undefined, {
              kind: "response",
              ...elapsed(),
            });
          parts.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      // AbortSignal.timeout rejects with TimeoutError (also while reading).
      if (error instanceof Error && error.name === "TimeoutError")
        throw new EmbeddingError("MEMORY_EMBEDDING_TIMEOUT", undefined, {
          kind: "timeout",
          timeoutMs: Math.max(1, timeoutMs),
          ...elapsed(),
        });
      throw new EmbeddingError("MEMORY_EMBEDDING_UNAVAILABLE", undefined, {
        kind: error instanceof SyntaxError ? "response" : "network",
        ...elapsed(),
      });
    }
  }
  async encode(
    config: EmbeddingConfig,
    secret: string | null,
    input: readonly string[],
    timeoutMs = 15000,
  ): Promise<number[][]> {
    if (
      !input.length ||
      input.length > 4 ||
      input.some((text) => !text.length || text.length > 12000)
    )
      throw new EmbeddingError("MEMORY_EMBEDDING_INPUT_INVALID");
    const data = await this.request(
      config,
      secret,
      config.protocol === "ollama" ? "api/embed" : "embeddings",
      config.protocol === "ollama"
        ? { model: config.model, input, truncate: false, keep_alive: -1 }
        : { model: config.model, input, encoding_format: "float" },
      timeoutMs,
    );
    const vector = z
      .array(z.number().finite())
      .length(config.dimensions)
      .refine((values) => values.some((v) => v !== 0));
    if (config.protocol === "ollama") {
      const parsed = z
        .object({ embeddings: z.array(vector).length(input.length) })
        .safeParse(data);
      if (!parsed.success)
        throw new EmbeddingError("MEMORY_EMBEDDING_INVALID_OUTPUT");
      return parsed.data.embeddings;
    }
    const parsed = z
      .object({
        data: z
          .array(
            z.object({ index: z.number().int().min(0), embedding: vector }),
          )
          .length(input.length),
      })
      .safeParse(data);
    if (!parsed.success)
      throw new EmbeddingError("MEMORY_EMBEDDING_INVALID_OUTPUT");
    const sorted = parsed.data.data.sort((a, b) => a.index - b.index);
    if (sorted.some((row, i) => row.index !== i))
      throw new EmbeddingError("MEMORY_EMBEDDING_INVALID_ORDER");
    return sorted.map((row) => row.embedding);
  }
  async identity(
    config: EmbeddingConfig,
    secret: string | null,
    timeoutMs = 5000,
  ): Promise<string> {
    if (config.protocol !== "ollama") return config.modelVersion;
    // Prefer Ollama's model digest; older/proxied services may only expose /api/show.
    try {
      const tags = z
        .object({
          models: z.array(
            z.object({ name: z.string(), digest: z.string().min(1) }),
          ),
        })
        .parse(
          await this.request(config, secret, "api/tags", undefined, timeoutMs),
        );
      const normalized = config.model.includes(":")
        ? config.model
        : `${config.model}:latest`;
      const model = tags.models.find(
        (m) => m.name === config.model || m.name === normalized,
      );
      if (model) return `digest:${model.digest}`;
    } catch {
      // The metadata fingerprint below still prevents transparent model fallback.
    }
    const value = await this.request(
      config,
      secret,
      "api/show",
      { model: config.model },
      timeoutMs,
    );
    const { createHash } = await import("node:crypto");
    const parsed = z
      .object({
        model_info: z.record(z.string(), z.unknown()),
        modelfile: z.string().optional(),
      })
      .safeParse(value);
    if (!parsed.success)
      throw new EmbeddingError("MEMORY_MODEL_IDENTITY_UNAVAILABLE");
    return createHash("sha256")
      .update(JSON.stringify(parsed.data))
      .digest("hex");
  }
}
