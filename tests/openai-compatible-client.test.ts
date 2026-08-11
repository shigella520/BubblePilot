import { describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleClient } from "../modules/ai/openai-compatible-client.js";
import type { AiProviderRecord } from "../modules/ai/ai-types.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";

const provider: AiProviderRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Fictional AI",
  apiKind: "chat-completions",
  baseUrl: "https://ai.example.test/v1/",
  model: "fictional-model",
  secretRef: "FICTIONAL_AI_KEY",
  parameters: { top_p: 0.9 },
  requestTimeoutMs: 5_000,
  enabled: true,
  sortOrder: 100,
  version: 1,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const request = {
  messages: [
    { role: "system" as const, content: "Be concise." },
    { role: "user" as const, content: "Fictional question" },
  ],
  maxOutputTokens: 128,
  temperature: 0.2,
};

describe("OpenAiCompatibleClient", () => {
  it("traces the exact multimodal divergence without storing prompt content", async () => {
    const responsesProvider: AiProviderRecord = {
      ...provider,
      apiKind: "responses",
    };
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: "completed",
            output_text: "Fictional answer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "server-secret" }),
      fetchImplementation,
      true,
    );
    const imageTail = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Fictional image label" },
        {
          type: "image" as const,
          dataUrl: "data:image/png;base64,ZmFrZS1pbWFnZQ==",
          detail: "high" as const,
          label: "fictional-image",
        },
      ],
    };
    const first = await client.call(responsesProvider, {
      ...request,
      promptTraceKey: "fictional-chat:workflow:node:turn-1",
      messages: [...request.messages, imageTail],
    });
    const second = await client.call(responsesProvider, {
      ...request,
      promptTraceKey: "fictional-chat:workflow:node:turn-1",
      messages: [
        ...request.messages,
        { role: "assistant", content: "Fictional earlier answer" },
        { role: "user", content: "Fictional next question" },
        imageTail,
      ],
    });

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    if (second.status !== "succeeded") return;
    expect(second.diagnostics?.requestTrace).toMatchObject({
      apiKind: "responses",
      previousItemCount: 3,
      sharedPrefixItemCount: 2,
      configurationMatchesPrevious: true,
      previousRequestIsExactPrefix: false,
      divergenceIndex: 2,
    });
    expect(second.diagnostics?.requestTrace?.items[4]).toMatchObject({
      role: "user",
      contentKinds: ["input_image", "input_text"],
      imageCount: 1,
      imageBytes: 10,
    });
    expect(JSON.stringify(second.diagnostics?.requestTrace)).not.toContain(
      "Fictional next question",
    );
    expect(JSON.stringify(second.diagnostics?.requestTrace)).not.toContain(
      "ZmFrZS1pbWFnZQ",
    );

    await client.call(responsesProvider, {
      ...request,
      promptTraceKey: "fictional-chat:workflow:node:inline-images",
      messages: [...request.messages, imageTail],
    });
    const ownerAdjacent = await client.call(responsesProvider, {
      ...request,
      promptTraceKey: "fictional-chat:workflow:node:inline-images",
      messages: [
        ...request.messages,
        imageTail,
        { role: "assistant", content: "Fictional earlier answer" },
        { role: "user", content: "Fictional next question" },
      ],
    });
    expect(ownerAdjacent.status).toBe("succeeded");
    if (ownerAdjacent.status !== "succeeded") return;
    expect(ownerAdjacent.diagnostics?.requestTrace).toMatchObject({
      previousItemCount: 3,
      sharedPrefixItemCount: 3,
      configurationMatchesPrevious: true,
      previousRequestIsExactPrefix: true,
      divergenceIndex: null,
    });
  });

  it("rejects missing and placeholder server secrets before network access", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "CHANGE_ME_AI_KEY" }),
      fetchImplementation,
    );
    await expect(client.call(provider, request)).resolves.toMatchObject({
      status: "failed",
      code: "AI_PROVIDER_SECRET_NOT_CONFIGURED",
      fallbackAllowed: true,
      countsForDegrade: false,
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("sends Chat Completions without exposing the secret in the result", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "Answer" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "server-secret" }),
      fetchImplementation,
    );

    await expect(client.call(provider, request)).resolves.toMatchObject({
      status: "succeeded",
      text: "Answer",
    });
    const [url, options] = fetchImplementation.mock.calls[0] ?? [];
    const urlText =
      url instanceof URL
        ? url.toString()
        : typeof url === "string"
          ? url
          : url?.url;
    expect(urlText).toBe("https://ai.example.test/v1/chat/completions");
    expect(options?.headers).toMatchObject({
      authorization: "Bearer server-secret",
      "content-type": "application/json",
    });
    expect(timeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      provider.requestTimeoutMs,
    );
    timeoutSpy.mockRestore();
    const payload = JSON.parse(
      typeof options?.body === "string" ? options.body : "null",
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      model: "fictional-model",
      stream: false,
      messages: request.messages,
      max_tokens: 128,
      temperature: 0.2,
      top_p: 0.9,
    });
  });

  it("supports a LAN Ollama endpoint without an API key", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "LAN answer" } }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver(),
      fetchImplementation,
    );
    await expect(
      client.call(
        {
          ...provider,
          baseUrl: "http://192.168.31.42:11434/v1",
          secretRef: undefined,
        },
        request,
      ),
    ).resolves.toMatchObject({ status: "succeeded", text: "LAN answer" });
    expect(fetchImplementation.mock.calls[0]?.[1]?.headers).toMatchObject({
      accept: "application/json",
      "content-type": "application/json",
    });
  });

  it.each([
    ["chat-completions" as const, "text", "image_url"],
    ["responses" as const, "input_text", "input_image"],
  ])(
    "serializes native image content for %s",
    async (apiKind, textType, imageType) => {
      const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
        apiKind === "chat-completions"
          ? new Response(
              JSON.stringify({ choices: [{ message: { content: "Seen" } }] }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ output_text: "Seen" }), {
              status: 200,
            }),
      );
      const client = new OpenAiCompatibleClient(
        new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "server-secret" }),
        fetchImplementation,
      );
      await client.call(
        { ...provider, apiKind },
        {
          ...request,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Inspect this image" },
                {
                  type: "image",
                  dataUrl: "data:image/png;base64,AAAA",
                  detail: "high",
                  label: "current attachment",
                },
              ],
            },
          ],
        },
      );
      const body = fetchImplementation.mock.calls[0]?.[1]?.body;
      const payload = JSON.parse(typeof body === "string" ? body : "null") as
        | { messages: Array<{ content: Array<{ type: string }> }> }
        | { input: Array<{ content: Array<{ type: string }> }> };
      const content =
        "messages" in payload
          ? payload.messages[0]?.content
          : payload.input[0]?.content;
      expect(content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: textType }),
          expect.objectContaining({ type: imageType }),
        ]),
      );
    },
  );

  it("records response shape, request IDs, token usage, and cache counters without content", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Answer" },
            },
          ],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 12,
            total_tokens: 212,
            prompt_cache_hit_tokens: 160,
            prompt_cache_miss_tokens: 40,
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "provider-request-123",
          },
        },
      ),
    );
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "server-secret" }),
      fetchImplementation,
    );

    const result = await client.call(provider, {
      ...request,
      clientRequestId: "execution:node:1:1",
      sessionId: "bp_fictional-stable-session",
    });

    expect(result).toMatchObject({
      status: "succeeded",
      diagnostics: {
        clientRequestId: "execution:node:1:1",
        providerRequestId: "provider-request-123",
        httpStatus: 200,
        requestMessageCount: 2,
        responseFinishReason: "stop",
        responseContentCharacters: 6,
        promptTokens: 200,
        completionTokens: 12,
        totalTokens: 212,
        cachedPromptTokens: 160,
        cacheMissPromptTokens: 40,
      },
    });
    expect(JSON.stringify(result.diagnostics)).not.toContain("Answer");
    expect(fetchImplementation.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-client-request-id": "execution:node:1:1",
      "x-session-id": "bp_fictional-stable-session",
    });
    const requestBody = fetchImplementation.mock.calls[0]?.[1]?.body;
    expect(
      JSON.parse(typeof requestBody === "string" ? requestBody : "null"),
    ).not.toHaveProperty("prompt_cache_key");
  });

  it("uses the affinity session as the Responses prompt cache key", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ output_text: "Answer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "server-secret" }),
      fetchImplementation,
    );

    await client.call(
      {
        ...provider,
        apiKind: "responses",
        parameters: { prompt_cache_key: "provider-default" },
      },
      { ...request, sessionId: "bp_fictional-stable-session" },
    );

    expect(fetchImplementation.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-session-id": "bp_fictional-stable-session",
    });
    const body = fetchImplementation.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(typeof body === "string" ? body : "null")).toMatchObject({
      prompt_cache_key: "bp_fictional-stable-session",
    });
  });

  it("classifies a blank final answer as retryable and records reasoning metadata", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "",
                reasoning_content: "private reasoning",
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "server-secret" }),
      fetchImplementation,
    );

    await expect(client.call(provider, request)).resolves.toMatchObject({
      status: "failed",
      code: "AI_PROVIDER_EMPTY_OUTPUT",
      retryable: true,
      countsForDegrade: true,
      diagnostics: {
        httpStatus: 200,
        responseFinishReason: "stop",
        responseContentCharacters: 0,
        responseReasoningCharacters: "private reasoning".length,
      },
    });
  });

  it("uses the Responses contract and extracts nested output text", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ content: [{ type: "output_text", text: "Response" }] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "server-secret" }),
      fetchImplementation,
    );

    await expect(
      client.call({ ...provider, apiKind: "responses" }, request),
    ).resolves.toMatchObject({ status: "succeeded", text: "Response" });
    const body = fetchImplementation.mock.calls[0]?.[1]?.body;
    const payload = JSON.parse(
      typeof body === "string" ? body : "null",
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      input: request.messages,
      max_output_tokens: 128,
    });
  });

  it("adds the hosted web search tool to Responses requests", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ output_text: "Fresh answer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "server-secret" }),
      fetchImplementation,
    );
    await expect(
      client.call(
        { ...provider, apiKind: "responses" },
        { ...request, webSearch: "auto" },
      ),
    ).resolves.toMatchObject({ status: "succeeded", text: "Fresh answer" });
    const body = fetchImplementation.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(typeof body === "string" ? body : "null")).toMatchObject({
      tools: [{ type: "web_search" }],
    });
  });

  it("serializes and parses Chat Completions function calls", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    function: {
                      name: "web_search",
                      arguments: '{"query":"fictional current event"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "server-secret" }),
      fetchImplementation,
    );
    const result = await client.call(provider, {
      ...request,
      tools: [
        {
          name: "web_search",
          description: "Search",
          parameters: { type: "object", properties: {} },
        },
      ],
      toolChoice: "required",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      toolCalls: [{ id: "call-1", name: "web_search" }],
    });
    const body = fetchImplementation.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(typeof body === "string" ? body : "null")).toMatchObject({
      tool_choice: "required",
      tools: [{ type: "function", function: { name: "web_search" } }],
    });
  });

  it("serializes Responses function outputs for a continuation turn", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ output_text: "Final answer" }), {
        status: 200,
      }),
    );
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "server-secret" }),
      fetchImplementation,
    );
    await client.call(
      { ...provider, apiKind: "responses" },
      {
        ...request,
        messages: [
          ...request.messages,
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call-1",
                name: "web_search",
                arguments: '{"query":"fictional"}',
              },
            ],
          },
          { role: "tool", toolCallId: "call-1", content: "result" },
        ],
        tools: [
          {
            name: "web_search",
            description: "Search",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    );
    const body = fetchImplementation.mock.calls[0]?.[1]?.body;
    const payload = JSON.parse(typeof body === "string" ? body : "null") as {
      input: Array<Record<string, unknown>>;
    };
    expect(payload.input).toContainEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "result",
    });
  });

  it("rejects hosted web search on Chat Completions before network access", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "server-secret" }),
      fetchImplementation,
    );
    await expect(
      client.call(provider, { ...request, webSearch: "required" }),
    ).resolves.toMatchObject({
      status: "failed",
      code: "AI_WEB_SEARCH_UNSUPPORTED",
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("classifies safe error categories without returning provider bodies", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { type: "server_error", message: "contains server-secret" },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "server-secret" }),
      fetchImplementation,
    );
    const result = await client.call(provider, request);
    expect(result).toMatchObject({
      status: "failed",
      code: "AI_PROVIDER_HTTP_503",
      retryable: true,
      fallbackAllowed: true,
      countsForDegrade: true,
    });
    expect(JSON.stringify(result)).not.toContain("server-secret");
  });
});
