import { z } from "zod";

import { hashJson, sha256 } from "../../app/canonical-json.js";
import type {
  AiCallDiagnostics,
  AiCallFailure,
  AiCallResult,
  AiChatMessage,
  AiChatRequest,
  AiContentPart,
  AiProviderRecord,
  AiRequestTrace,
  AiRequestTraceItem,
  AiToolCall,
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
              tool_calls: z
                .array(
                  z.object({
                    id: z.string(),
                    function: z.object({
                      name: z.string(),
                      arguments: z.string(),
                    }),
                  }),
                )
                .optional(),
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
            type: z.string().optional(),
            call_id: z.string().optional(),
            name: z.string().optional(),
            arguments: z.string().optional(),
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
  toolCalls: readonly AiToolCall[];
}

interface PreviousPromptTrace {
  requestHash: string;
  configurationHash: string;
  cacheKeyHash: string | null;
  itemHashes: readonly string[];
  items: readonly AiRequestTraceItem[];
}

function dataUrlBytes(value: string): number {
  const match = /^data:[^,]*;base64,(.*)$/su.exec(value);
  if (match?.[1] === undefined) return 0;
  const encoded = match[1].replace(/\s/gu, "");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

function promptItemMetrics(item: unknown) {
  const contentKinds = new Set<string>();
  let textCharacters = 0;
  let imageCount = 0;
  let imageBytes = 0;
  const textParts: string[] = [];
  const imageParts: string[] = [];

  const visit = (value: unknown, key: string | null = null): void => {
    if (typeof value === "string") {
      if (key === "image_url" || key === "url") {
        const bytes = dataUrlBytes(value);
        if (bytes > 0) {
          imageBytes += bytes;
          imageParts.push(sha256(value));
          return;
        }
      }
      if (["content", "text", "output", "arguments"].includes(key ?? "")) {
        textCharacters += value.length;
        textParts.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((part) => visit(part, key));
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.type === "string") {
      contentKinds.add(record.type);
      if (["input_image", "image_url"].includes(record.type)) imageCount += 1;
    }
    Object.entries(record).forEach(([nestedKey, nestedValue]) =>
      visit(nestedValue, nestedKey),
    );
  };
  visit(item);
  const text = textParts.join("\n");
  const historyMessageId = /<chat_history\s+message_id="([^"]+)"/u.exec(
    text,
  )?.[1];
  const linkPreviewLines = text
    .split("\n")
    .filter((line) => line.includes("[link_preview"));
  return {
    contentKinds: [...contentKinds].sort(),
    textCharacters,
    imageCount,
    imageBytes,
    historyMessageIdHash:
      historyMessageId === undefined ? null : sha256(historyMessageId),
    textHash: sha256(text),
    imageContentHash: imageParts.length === 0 ? null : hashJson(imageParts),
    linkPreviewHash:
      linkPreviewLines.length === 0
        ? null
        : sha256(linkPreviewLines.join("\n")),
  };
}

function traceItems(items: readonly unknown[]): readonly AiRequestTraceItem[] {
  const hashes: string[] = [];
  return items.map((item, index) => {
    const itemHash = hashJson(item);
    hashes.push(itemHash);
    const record =
      item !== null && typeof item === "object"
        ? (item as Record<string, unknown>)
        : {};
    const metrics = promptItemMetrics(item);
    const region = promptItemRegion(item, record);
    return {
      index,
      role:
        typeof record.role === "string"
          ? record.role
          : typeof record.type === "string"
            ? record.type
            : "unknown",
      ...metrics,
      itemHash,
      prefixHash: hashJson(hashes),
      region,
    };
  });
}

function promptItemRegion(
  item: unknown,
  record: Readonly<Record<string, unknown>>,
): AiRequestTraceItem["region"] {
  const text = JSON.stringify(item);
  if (record.role === "system") return "system";
  if (text.includes("<history_summary")) return "summary";
  if (text.includes("<chat_history")) return "history";
  if (text.includes("<participant_identities")) return "participants";
  if (text.includes("<link_previews")) return "link-previews";
  if (
    text.includes("<current_attachments") ||
    text.includes("input_image") ||
    text.includes("image_url")
  )
    return "attachments";
  if (text.includes("<resource_diagnostics")) return "diagnostics";
  return "dynamic";
}

function divergenceReason(
  previous: AiRequestTraceItem | undefined,
  current: AiRequestTraceItem | undefined,
): AiRequestTrace["divergenceReason"] {
  const region = current?.region ?? previous?.region;
  switch (region) {
    case "summary":
      return "summary-changed";
    case "system":
      return "system-prompt-changed";
    case "history":
      if (previous === undefined || current === undefined)
        return "history-window-shifted";
      if (
        previous.historyMessageIdHash !== current.historyMessageIdHash ||
        previous.historyMessageIdHash === null ||
        current.historyMessageIdHash === null
      )
        return "history-window-shifted";
      if (previous.imageCount !== current.imageCount)
        return "history-image-selection-changed";
      if (previous.linkPreviewHash !== current.linkPreviewHash)
        return "link-preview-changed";
      if (
        previous.imageCount > 0 &&
        current.imageCount > 0 &&
        previous.imageContentHash !== current.imageContentHash
      )
        return "history-image-content-changed";
      return "history-message-changed";
    case "participants":
      return "participant-mapping-changed";
    case "link-previews":
      return "link-preview-changed";
    case "attachments":
      return previous === undefined ||
        current === undefined ||
        previous.imageCount !== current.imageCount
        ? "current-image-selection-changed"
        : previous.imageContentHash !== current.imageContentHash
          ? "current-image-content-changed"
          : "dynamic-input-changed";
    case "diagnostics":
      return "image-download-state-changed";
    case "dynamic":
      return "dynamic-input-changed";
    default:
      return "unknown";
  }
}

function sharedPrefixLength(
  previous: readonly string[],
  current: readonly string[],
): number {
  const limit = Math.min(previous.length, current.length);
  let index = 0;
  while (index < limit && previous[index] === current[index]) index += 1;
  return index;
}

function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function failure(input: Omit<AiCallFailure, "status">): AiCallFailure {
  return { status: "failed", ...input };
}

function textContent(content: string | readonly AiContentPart[]): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

function chatContent(content: string | readonly AiContentPart[]) {
  if (typeof content === "string") return content;
  return content.flatMap((part) =>
    part.type === "text"
      ? [{ type: "text", text: part.text }]
      : [
          { type: "text", text: `[图片：${part.label}]` },
          {
            type: "image_url",
            image_url: { url: part.dataUrl, detail: part.detail },
          },
        ],
  );
}

function responsesContent(content: string | readonly AiContentPart[]) {
  if (typeof content === "string") return content;
  return content.flatMap((part) =>
    part.type === "text"
      ? [{ type: "input_text", text: part.text }]
      : [
          { type: "input_text", text: `[图片：${part.label}]` },
          {
            type: "input_image",
            image_url: part.dataUrl,
            detail: part.detail,
          },
        ],
  );
}

function chatMessages(messages: readonly AiChatMessage[]) {
  return messages.map((message) =>
    message.role === "tool"
      ? {
          role: "tool",
          content: textContent(message.content),
          tool_call_id: message.toolCallId,
        }
      : {
          role: message.role,
          content: chatContent(message.content),
          ...(message.toolCalls === undefined
            ? {}
            : {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              }),
        },
  );
}

function responseInput(messages: readonly AiChatMessage[]) {
  const items: unknown[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: message.toolCallId ?? "missing-tool-call-id",
        output: textContent(message.content),
      });
      continue;
    }
    if (
      textContent(message.content).length > 0 ||
      Array.isArray(message.content)
    ) {
      items.push({
        role: message.role,
        content: responsesContent(message.content),
      });
    }
    for (const call of message.toolCalls ?? []) {
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
    }
  }
  return items;
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
      toolCalls: [],
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
    toolCalls: (choice.message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
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
      toolCalls: [],
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
    toolCalls: (parsed.data.output ?? []).flatMap((item) =>
      item.type === "function_call" &&
      item.call_id !== undefined &&
      item.name !== undefined &&
      item.arguments !== undefined
        ? [
            {
              id: item.call_id,
              name: item.name,
              arguments: item.arguments,
            },
          ]
        : [],
    ),
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
  requestTrace: AiRequestTrace | null,
): AiCallDiagnostics {
  return {
    clientRequestId: request.clientRequestId?.slice(0, 512) ?? null,
    providerRequestId: null,
    httpStatus: null,
    requestHash: sha256(requestBody),
    requestMessageCount: request.messages.length,
    requestCharacters: request.messages.reduce(
      (total, message) => total + textContent(message.content).length,
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
    requestTrace,
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
  private readonly promptTraceHistory = new Map<string, PreviousPromptTrace>();

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
    const reasoningEffort = provider.reasoningEffort ?? "default";
    if (reasoningEffort !== "default") {
      if (provider.apiKind === "responses") {
        payload.reasoning = { effort: reasoningEffort };
      } else {
        payload.reasoning_effort = reasoningEffort;
      }
    }
    if (
      request.webSearch !== undefined &&
      request.webSearch !== "disabled" &&
      provider.apiKind !== "responses"
    ) {
      return failure({
        category: "configuration",
        code: "AI_WEB_SEARCH_UNSUPPORTED",
        summary: "This provider interface does not support hosted web search.",
        retryable: false,
        fallbackAllowed: true,
        countsForDegrade: false,
        durationMs: elapsed(startedAt),
      });
    }
    if (provider.apiKind === "chat-completions") {
      payload.messages = chatMessages(request.messages);
      payload.max_tokens = request.maxOutputTokens;
      if (request.tools !== undefined) {
        payload.tools = request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: true,
          },
        }));
        payload.tool_choice = request.toolChoice ?? "auto";
      }
    } else {
      payload.input = responseInput(request.messages);
      payload.max_output_tokens = request.maxOutputTokens;
      if (request.sessionId !== undefined) {
        // Responses prompt caches are commonly partitioned by this key. Keep
        // it identical to the affinity header so a multi-account gateway and
        // its upstream cache observe the same stable logical conversation.
        payload.prompt_cache_key = request.sessionId;
      }
      if (request.webSearch !== undefined && request.webSearch !== "disabled") {
        payload.tools = [{ type: "web_search" }];
        if (request.webSearch === "required") {
          payload.tool_choice = "required";
        }
      } else if (request.tools !== undefined) {
        payload.tools = request.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: true,
        }));
        payload.tool_choice = request.toolChoice ?? "auto";
      }
    }
    if (request.temperature !== null) {
      payload.temperature = request.temperature;
    }
    const requestBody = JSON.stringify(payload);
    const requestHash = sha256(requestBody);
    const requestTrace = this.buildRequestTrace(
      provider,
      request,
      payload,
      requestHash,
    );
    const initialDiagnostics = baseDiagnostics(
      request,
      requestBody,
      requestTrace,
    );
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
    const timeout = setTimeout(
      () => controller.abort(),
      provider.requestTimeoutMs,
    );
    try {
      const response = await this.fetchImplementation(endpoint, {
        method: "POST",
        headers: {
          ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
          ...(request.clientRequestId === undefined
            ? {}
            : { "x-client-request-id": request.clientRequestId }),
          ...(request.sessionId === undefined
            ? {}
            : { "x-session-id": request.sessionId }),
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
      if (text.trim().length === 0 && parsed.toolCalls.length === 0) {
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
        toolCalls: parsed.toolCalls,
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

  private buildRequestTrace(
    provider: AiProviderRecord,
    request: AiChatRequest,
    payload: Readonly<Record<string, unknown>>,
    requestHash: string,
  ): AiRequestTrace | null {
    if (request.promptTraceKey === undefined) {
      return null;
    }
    const itemsValue =
      provider.apiKind === "responses" ? payload.input : payload.messages;
    const items = traceItems(Array.isArray(itemsValue) ? itemsValue : []);
    const configuration = { ...payload };
    delete configuration.input;
    delete configuration.messages;
    const configurationHash = hashJson(configuration);
    const traceKeyHash = sha256(request.promptTraceKey);
    const historyKey = `${provider.id}:${provider.apiKind}:${provider.model}:${traceKeyHash}`;
    const previous = this.promptTraceHistory.get(historyKey);
    const itemHashes = items.map((item) => item.itemHash);
    const sharedPrefixItemCount =
      previous === undefined
        ? null
        : sharedPrefixLength(previous.itemHashes, itemHashes);
    const configurationMatchesPrevious =
      previous === undefined
        ? null
        : previous.configurationHash === configurationHash;
    const cacheKeyHash =
      request.sessionId === undefined ? null : sha256(request.sessionId);
    const cacheKeyMatchesPrevious =
      previous === undefined ? null : previous.cacheKeyHash === cacheKeyHash;
    const previousRequestIsExactPrefix =
      previous === undefined || sharedPrefixItemCount === null
        ? null
        : configurationMatchesPrevious === true &&
          sharedPrefixItemCount === previous.itemHashes.length;
    const divergenceOffset = sharedPrefixItemCount;
    const hasDivergence =
      previous !== undefined &&
      divergenceOffset !== null &&
      divergenceOffset !== previous.itemHashes.length;
    const trace: AiRequestTrace = {
      traceKeyHash,
      apiKind: provider.apiKind,
      requestHash,
      configurationHash,
      previousRequestHash: previous?.requestHash ?? null,
      previousItemCount: previous?.itemHashes.length ?? null,
      sharedPrefixItemCount,
      configurationMatchesPrevious,
      previousRequestIsExactPrefix,
      cacheKeyHash,
      cacheKeyMatchesPrevious,
      divergenceIndex:
        previous === undefined ||
        sharedPrefixItemCount === previous.itemHashes.length
          ? null
          : sharedPrefixItemCount,
      divergenceRegion:
        !hasDivergence || divergenceOffset === null
          ? null
          : (items[divergenceOffset]?.region ??
            previous.items[divergenceOffset]?.region ??
            null),
      divergenceReason:
        previous === undefined
          ? null
          : configurationMatchesPrevious === false
            ? "request-configuration-changed"
            : cacheKeyMatchesPrevious === false
              ? "cache-key-changed"
              : previousRequestIsExactPrefix === true &&
                  items.length > previous.itemHashes.length
                ? "append-only-growth"
                : !hasDivergence || divergenceOffset === null
                  ? "request-unchanged"
                  : divergenceReason(
                      previous.items[divergenceOffset],
                      items[divergenceOffset],
                    ),
      items,
    };
    this.promptTraceHistory.set(historyKey, {
      requestHash,
      configurationHash,
      cacheKeyHash,
      itemHashes,
      items,
    });
    if (this.promptTraceHistory.size > 1_024) {
      const oldest = this.promptTraceHistory.keys().next().value;
      if (oldest !== undefined) this.promptTraceHistory.delete(oldest);
    }
    return trace;
  }
}
