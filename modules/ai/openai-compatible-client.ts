import { z } from "zod";

import { sha256 } from "../../app/canonical-json.js";
import type {
  AiCallDiagnostics,
  AiCallFailure,
  AiCallResult,
  AiChatMessage,
  AiChatRequest,
  AiProviderRecord,
} from "./ai-types.js";
import {
  isProviderSecretConfigured,
  resolveProviderSecret,
  type SecretResolver,
} from "./secret-resolver.js";

const errorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.union([z.string(), z.number()]).optional(),
        type: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const chatResponseSchema = z
  .object({
    choices: z.array(
      z
        .object({
          finish_reason: z.string().nullable().optional(),
          message: z
            .object({
              content: z
                .union([
                  z.string(),
                  z.array(
                    z.object({ text: z.string().optional() }).passthrough(),
                  ),
                ])
                .nullable()
                .optional(),
              reasoning_content: z.string().nullable().optional(),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const responsesResponseSchema = z
  .object({
    status: z.string().optional(),
    output_text: z.string().optional(),
    output: z
      .array(
        z
          .object({
            content: z
              .array(
                z
                  .object({
                    text: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const tokenUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
    prompt_cache_miss_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens_details: z
      .object({
        cached_tokens: z.number().int().nonnegative().optional(),
        cache_write_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    completion_tokens_details: z
      .object({
        reasoning_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    input_tokens_details: z
      .object({
        cached_tokens: z.number().int().nonnegative().optional(),
        cache_write_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    output_tokens_details: z
      .object({
        reasoning_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const responseUsageSchema = z
  .object({ usage: tokenUsageSchema.optional() })
  .passthrough();

interface ParsedResponse {
  supported: boolean;
  text: string | null;
  finishReason: string | null;
  contentCharacters: number | null;
  reasoningCharacters: number | null;
}

function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function failure(input: Omit<AiCallFailure, "status">): AiCallFailure {
  return { status: "failed", ...input };
}

function inputMessages(messages: readonly AiChatMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function errorIdentity(value: unknown): string {
  const parsed = errorResponseSchema.safeParse(value);
  if (!parsed.success) {
    return "";
  }
  return [parsed.data.error?.code, parsed.data.error?.type]
    .filter((part) => part !== undefined)
    .join(":")
    .toLocaleLowerCase("en-US");
}

function httpFailure(
  status: number,
  body: unknown,
  durationMs: number,
  diagnostics: AiCallDiagnostics,
): AiCallFailure {
  const identity = errorIdentity(body);
  if (identity.includes("content_filter") || identity.includes("safety")) {
    return failure({
      category: "content-safety",
      code: "AI_CONTENT_SAFETY_REJECTED",
      summary: "The AI provider rejected the request for content safety.",
      retryable: false,
      fallbackAllowed: false,
      countsForDegrade: false,
      durationMs,
      diagnostics,
    });
  }
  if (status === 408) {
    return failure({
      category: "timeout",
      code: "AI_PROVIDER_TIMEOUT",
      summary: "The AI provider request timed out.",
      retryable: true,
      fallbackAllowed: true,
      countsForDegrade: true,
      durationMs,
      diagnostics,
    });
  }
  if (status === 429) {
    return failure({
      category: "rate-limit",
      code: "AI_PROVIDER_RATE_LIMITED",
      summary: "The AI provider rate-limited the request.",
      retryable: true,
      fallbackAllowed: true,
      countsForDegrade: true,
      durationMs,
      diagnostics,
    });
  }
  if (status >= 500) {
    return failure({
      category: "server-error",
      code: `AI_PROVIDER_HTTP_${status}`,
      summary: `The AI provider returned HTTP ${status}.`,
      retryable: true,
      fallbackAllowed: true,
      countsForDegrade: true,
      durationMs,
      diagnostics,
    });
  }
  if (status === 401 || status === 403) {
    return failure({
      category: "authentication",
      code: "AI_PROVIDER_AUTHENTICATION_FAILED",
      summary: "The AI provider rejected its server-side credential.",
      retryable: false,
      fallbackAllowed: true,
      countsForDegrade: false,
      durationMs,
      diagnostics,
    });
  }
  return failure({
    category: "model",
    code: `AI_PROVIDER_HTTP_${status}`,
    summary: "The AI provider rejected the model request.",
    retryable: false,
    fallbackAllowed: true,
    countsForDegrade: false,
    durationMs,
    diagnostics,
  });
}

function chatResponse(body: unknown): ParsedResponse {
  const parsed = chatResponseSchema.safeParse(body);
  const choice = parsed.success ? parsed.data.choices[0] : undefined;
  if (choice === undefined) {
    return {
      supported: false,
      text: null,
      finishReason: null,
      contentCharacters: null,
      reasoningCharacters: null,
    };
  }
  const content = choice.message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => part.text ?? "").join("")
        : "";
  return {
    supported: true,
    text,
    finishReason: choice.finish_reason ?? null,
    contentCharacters: text.length,
    reasoningCharacters: choice.message.reasoning_content?.length ?? 0,
  };
}

function responsesResponse(body: unknown): ParsedResponse {
  const parsed = responsesResponseSchema.safeParse(body);
  if (!parsed.success) {
    return {
      supported: false,
      text: null,
      finishReason: null,
      contentCharacters: null,
      reasoningCharacters: null,
    };
  }
  const text =
    parsed.data.output_text ??
    parsed.data.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text ?? "")
      .join("") ??
    "";
  return {
    supported: true,
    text,
    finishReason: parsed.data.status ?? null,
    contentCharacters: text.length,
    reasoningCharacters: 0,
  };
}

function requestId(headers: Headers): string | null {
  for (const name of [
    "x-request-id",
    "request-id",
    "openai-request-id",
    "cf-ray",
  ]) {
    const value = headers.get(name)?.trim();
    if (value !== undefined && value.length > 0) {
      return value.slice(0, 512);
    }
  }
  return null;
}

function tokenDiagnostics(body: unknown) {
  const parsed = responseUsageSchema.safeParse(body);
  const usage = parsed.success ? parsed.data.usage : undefined;
  return {
    promptTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? usage?.output_tokens ?? null,
    reasoningTokens:
      usage?.completion_tokens_details?.reasoning_tokens ??
      usage?.output_tokens_details?.reasoning_tokens ??
      null,
    totalTokens: usage?.total_tokens ?? null,
    cachedPromptTokens:
      usage?.prompt_cache_hit_tokens ??
      usage?.prompt_tokens_details?.cached_tokens ??
      usage?.input_tokens_details?.cached_tokens ??
      null,
    cacheWritePromptTokens:
      usage?.prompt_tokens_details?.cache_write_tokens ??
      usage?.input_tokens_details?.cache_write_tokens ??
      null,
    cacheMissPromptTokens: usage?.prompt_cache_miss_tokens ?? null,
  };
}

function baseDiagnostics(
  request: AiChatRequest,
  requestBody: string,
): AiCallDiagnostics {
  return {
    clientRequestId: request.clientRequestId?.slice(0, 512) ?? null,
    providerRequestId: null,
    httpStatus: null,
    requestHash: sha256(requestBody),
    requestMessageCount: request.messages.length,
    requestCharacters: request.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
    responseBytes: null,
    responseBodyHash: null,
    responseFinishReason: null,
    responseContentCharacters: null,
    responseReasoningCharacters: null,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    cachedPromptTokens: null,
    cacheWritePromptTokens: null,
    cacheMissPromptTokens: null,
  };
}

function responseDiagnostics(
  base: AiCallDiagnostics,
  response: Response,
  responseBody: string,
  body: unknown,
  parsed: ParsedResponse,
): AiCallDiagnostics {
  return {
    ...base,
    providerRequestId: requestId(response.headers),
    httpStatus: response.status,
    responseBytes: new TextEncoder().encode(responseBody).byteLength,
    responseBodyHash: sha256(responseBody),
    responseFinishReason: parsed.finishReason,
    responseContentCharacters: parsed.contentCharacters,
    responseReasoningCharacters: parsed.reasoningCharacters,
    ...tokenDiagnostics(body),
  };
}

export interface AiClient {
  call(
    provider: AiProviderRecord,
    request: AiChatRequest,
  ): Promise<AiCallResult>;
}

export class OpenAiCompatibleClient implements AiClient {
  private readonly fetchImplementation: typeof fetch;

  constructor(
    private readonly secrets: SecretResolver,
    fetchImplementation?: typeof fetch,
  ) {
    this.fetchImplementation = fetchImplementation ?? fetch;
  }

  async call(
    provider: AiProviderRecord,
    request: AiChatRequest,
  ): Promise<AiCallResult> {
    const startedAt = Date.now();
    const endpoint = new URL(
      provider.apiKind === "chat-completions"
        ? "chat/completions"
        : "responses",
      `${provider.baseUrl.replace(/\/+$/u, "")}/`,
    );
    const payload: Record<string, unknown> = {
      ...provider.parameters,
      model: provider.model,
      stream: false,
    };
    if (provider.apiKind === "chat-completions") {
      payload.messages = request.messages;
      payload.max_tokens = request.maxOutputTokens;
    } else {
      payload.input = inputMessages(request.messages);
      payload.max_output_tokens = request.maxOutputTokens;
    }
    if (request.temperature !== null) {
      payload.temperature = request.temperature;
    }
    const requestBody = JSON.stringify(payload);
    const initialDiagnostics = baseDiagnostics(request, requestBody);
    const secret = resolveProviderSecret(provider, this.secrets);
    if (!isProviderSecretConfigured(provider, this.secrets)) {
      return failure({
        category: "configuration",
        code: "AI_PROVIDER_SECRET_NOT_CONFIGURED",
        summary: "The AI provider secret reference is not configured.",
        retryable: false,
        fallbackAllowed: true,
        countsForDegrade: false,
        durationMs: elapsed(startedAt),
        diagnostics: initialDiagnostics,
      });
    }

    const controller = new AbortController();
    const timeoutMs = Math.min(request.timeoutMs, provider.requestTimeoutMs);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImplementation(endpoint, {
        method: "POST",
        headers: {
          ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
          ...(request.clientRequestId === undefined
            ? {}
            : { "x-client-request-id": request.clientRequestId }),
          accept: "application/json",
          "content-type": "application/json",
        },
        body: requestBody,
        signal: controller.signal,
      });
      let responseBody = "";
      let body: unknown;
      try {
        responseBody = await response.text();
        body = JSON.parse(responseBody) as unknown;
      } catch {
        body = null;
      }
      const durationMs = elapsed(startedAt);
      const parsed =
        provider.apiKind === "chat-completions"
          ? chatResponse(body)
          : responsesResponse(body);
      const diagnostics = responseDiagnostics(
        initialDiagnostics,
        response,
        responseBody,
        body,
        parsed,
      );
      if (!response.ok) {
        return httpFailure(response.status, body, durationMs, diagnostics);
      }
      if (!parsed.supported) {
        return failure({
          category: "invalid-response",
          code: "AI_PROVIDER_INVALID_RESPONSE",
          summary: "The AI provider returned an unsupported response shape.",
          retryable: true,
          fallbackAllowed: true,
          countsForDegrade: true,
          durationMs,
          diagnostics,
        });
      }
      const text = parsed.text ?? "";
      if (text.trim().length === 0) {
        return failure({
          category: "empty-output",
          code: "AI_PROVIDER_EMPTY_OUTPUT",
          summary: "The AI provider returned empty output.",
          retryable: true,
          fallbackAllowed: true,
          countsForDegrade: true,
          durationMs,
          diagnostics,
        });
      }
      return {
        status: "succeeded",
        text: text.trim(),
        durationMs,
        diagnostics,
      };
    } catch (error) {
      const timedOut =
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError");
      return failure({
        category: timedOut ? "timeout" : "connection",
        code: timedOut
          ? "AI_PROVIDER_TIMEOUT"
          : "AI_PROVIDER_CONNECTION_FAILED",
        summary: timedOut
          ? "The AI provider request timed out."
          : "The AI provider connection failed.",
        retryable: true,
        fallbackAllowed: true,
        countsForDegrade: true,
        durationMs: elapsed(startedAt),
        diagnostics: initialDiagnostics,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
