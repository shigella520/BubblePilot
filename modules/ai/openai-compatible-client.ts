import { z } from "zod";

import type {
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
          message: z
            .object({
              content: z.union([
                z.string(),
                z.array(
                  z.object({ text: z.string().optional() }).passthrough(),
                ),
              ]),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const responsesResponseSchema = z
  .object({
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
  });
}

function chatText(body: unknown): string | null {
  const parsed = chatResponseSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const content = parsed.data.choices[0]?.message.content;
  return typeof content === "string"
    ? content
    : (content?.map((part) => part.text ?? "").join("") ?? null);
}

function responsesText(body: unknown): string | null {
  const parsed = responsesResponseSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  return (
    parsed.data.output_text ??
    parsed.data.output
      ?.flatMap((item) => item.content ?? [])
      .map((content) => content.text ?? "")
      .join("") ??
    null
  );
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
      });
    }
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

    const controller = new AbortController();
    const timeoutMs = Math.min(request.timeoutMs, provider.requestTimeoutMs);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImplementation(endpoint, {
        method: "POST",
        headers: {
          ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const durationMs = elapsed(startedAt);
      if (!response.ok) {
        return httpFailure(response.status, body, durationMs);
      }
      const text =
        provider.apiKind === "chat-completions"
          ? chatText(body)
          : responsesText(body);
      if (text === null) {
        return failure({
          category: "invalid-response",
          code: "AI_PROVIDER_INVALID_RESPONSE",
          summary: "The AI provider returned an unsupported response shape.",
          retryable: false,
          fallbackAllowed: true,
          countsForDegrade: false,
          durationMs,
        });
      }
      if (text.trim().length === 0) {
        return failure({
          category: "empty-output",
          code: "AI_PROVIDER_EMPTY_OUTPUT",
          summary: "The AI provider returned empty output.",
          retryable: false,
          fallbackAllowed: true,
          countsForDegrade: false,
          durationMs,
        });
      }
      return { status: "succeeded", text: text.trim(), durationMs };
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
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
