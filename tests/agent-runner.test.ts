import { OpenAiCompatibleClient } from "../modules/ai/openai-compatible-client.js";
import type { MemoryService } from "../modules/memory/memory-service.js";
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AgentRunner } from "../modules/ai/agent-runner.js";
import { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import type { AiClient } from "../modules/ai/openai-compatible-client.js";
import type {
  AiCallResult,
  AiChatRequest,
  AiProviderRecord,
  AiRouteRequest,
} from "../modules/ai/ai-types.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import {
  WebSearchToolError,
  type WebSearchTool,
} from "../modules/ai/web-search-tool.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";

class ToolCallingClient implements AiClient {
  readonly requests: AiChatRequest[] = [];

  constructor(private readonly answer = "Answer with source") {}

  call(
    _provider: AiProviderRecord,
    request: AiChatRequest,
  ): Promise<AiCallResult> {
    this.requests.push(structuredClone(request));
    const hasToolOutput = request.messages.some((item) => item.role === "tool");
    return Promise.resolve(
      hasToolOutput
        ? { status: "succeeded", text: this.answer, durationMs: 4 }
        : {
            status: "succeeded",
            text: "",
            toolCalls: [
              {
                id: "search-call",
                name: "web_search",
                arguments: '{"query":"fictional latest news"}',
              },
            ],
            durationMs: 3,
          },
    );
  }
}

async function setup(answer?: string) {
  const repository = new InMemoryAiRepository();
  const created = await repository.createProvider({
    name: "Fictional",
    apiKind: "responses",
    baseUrl: "https://ai.example.test/v1",
    model: "fictional-model",
    secretRef: "FICTIONAL_KEY",
    parameters: {},
    requestTimeoutMs: 5_000,
    enabled: true,
    capabilities: { functionCalling: true, hostedWebSearch: false },
  });
  if (created.status !== "ok") throw new Error("provider setup failed");
  await repository.updateProviderCapabilityProbe(created.value.id, {
    functionCalling: "verified",
    hostedWebSearch: "unknown",
    checkedAt: new Date(0).toISOString(),
  });
  const route = await repository.createRoute({
    name: "Search route",
    providerIds: [created.value.id],
    fallbackEnabled: true,
    retryPolicy: { maxRounds: 1, initialDelayMs: 0 },
    degradePolicy: { failureThreshold: 3, cooldownMs: 60_000 },
    enabled: true,
  });
  if (route.status !== "ok") throw new Error("route setup failed");
  const client = new ToolCallingClient(answer);
  const routing = new AiRoutingService(
    repository,
    client,
    new EnvironmentSecretResolver({ FICTIONAL_KEY: "fictional-secret" }),
    true,
  );
  const search: WebSearchTool = {
    isReady: () => Promise.resolve(true),
    search: () =>
      Promise.resolve({
        results: [
          {
            title: "Source",
            url: "https://news.example.test/item",
            snippet: "Fresh fact",
            publishedAt: null,
            source: "fictional",
          },
        ],
        durationMs: 2,
      }),
  };
  const request: AiRouteRequest = {
    executionId: randomUUID(),
    nodeId: "ai",
    routeId: route.value.id,
    messages: [{ role: "user", content: "What is new?" }],
    maxOutputTokens: 256,
    temperature: null,
    maxOutputCharacters: 4_000,
    outputFormat: "text",
    protectedPrompt: null,
    webSearch: "required",
  };
  return { repository, client, routing, search, request };
}

describe("AgentRunner", () => {
  it.each(["responses", "chat-completions"] as const)(
    "pairs paginated count results on the %s wire without fetching message bodies",
    async (apiKind) => {
      const { repository, request } = await setup();
      [...repository.providers.values()][0]!.apiKind = apiKind;
      const args = {
        from: "2026-11-07T00:00:00+08:00",
        to: "2026-11-07T23:59:59+08:00",
        groupBy: "hour",
        limit: 12,
      };
      const execute = vi
        .fn<(name: string, args: string) => Promise<string>>()
        .mockImplementation((_name: string, argumentsJson: string) => {
          const input = JSON.parse(argumentsJson) as { cursor?: string };
          const offset = input.cursor ? 12 : 0;
          return Promise.resolve(
            JSON.stringify({
              status: "succeeded",
              totalCount: 285,
              totalGroups: 24,
              returnedGroupCount: 12,
              groups: Array.from({ length: 12 }, (_, i) => ({
                hour: offset + i,
                count: offset + i < 21 ? 12 : 11,
              })),
              countsExact: true,
              hasMore: !input.cursor,
              nextCursor: input.cursor ? null : "fictional-page",
              truncated: false,
            }),
          );
        });
      const memory = {
        repository: { scopeForEvent: vi.fn().mockResolvedValue({}) },
        session: vi.fn().mockResolvedValue({
          id: "fictional-retrieval",
          execute,
          validate: vi.fn().mockResolvedValue(true),
          render: (text: string) => text,
        }),
      } as unknown as MemoryService;
      const payloads: Array<Record<string, unknown>> = [];
      const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
        const payload = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>;
        payloads.push(payload);
        const turn = payloads.length;
        const call = {
          name: "count_chat_messages",
          arguments: JSON.stringify({
            ...args,
            ...(turn === 2 ? { cursor: "fictional-page" } : {}),
          }),
        };
        const response =
          apiKind === "responses"
            ? turn < 3
              ? {
                  output: [
                    {
                      type: "function_call",
                      call_id: "count-" + turn,
                      ...call,
                    },
                  ],
                }
              : { output_text: "共285条，已取得24个小时的完整统计。" }
            : {
                choices: [
                  {
                    finish_reason: turn < 3 ? "tool_calls" : "stop",
                    message:
                      turn < 3
                        ? {
                            content: null,
                            tool_calls: [
                              {
                                id: "count-" + turn,
                                type: "function",
                                function: call,
                              },
                            ],
                          }
                        : { content: "共285条，已取得24个小时的完整统计。" },
                  },
                ],
              };
        return Promise.resolve(Response.json(response));
      });
      const secrets = new EnvironmentSecretResolver({
        FICTIONAL_KEY: "fictional-secret",
      });
      const routing = new AiRoutingService(
        repository,
        new OpenAiCompatibleClient(secrets, fetcher),
        secrets,
        true,
      );
      const result = await new AgentRunner(
        routing,
        undefined,
        repository,
        undefined,
        undefined,
        memory,
      ).run({
        ...request,
        webSearch: "disabled",
        messages: [{ role: "user", content: "按小时统计虚构日期的聊天数" }],
        memoryEvent: { provider: "bluebubbles", messageId: "fictional" },
      });
      expect(result).toMatchObject({
        status: "succeeded",
        text: "共285条，已取得24个小时的完整统计。",
      });
      expect(result.agentBudget).toMatchObject({
        toolCalls: 2,
        finalizingDueToBudget: false,
      });
      expect(execute.mock.calls.map((c) => c[0])).toEqual([
        "count_chat_messages",
        "count_chat_messages",
      ]);
      expect(payloads).toHaveLength(3);
      for (const payload of payloads)
        expect(payload.tools).toEqual(payloads[0]!.tools);
      const outputs = (
        apiKind === "responses" ? payloads[2]!.input : payloads[2]!.messages
      ) as Array<Record<string, unknown>>;
      for (const id of ["count-1", "count-2"]) {
        expect(
          outputs.filter((p) =>
            apiKind === "responses"
              ? p.type === "function_call_output" && p.call_id === id
              : p.role === "tool" && p.tool_call_id === id,
          ),
        ).toHaveLength(1);
      }
      expect(repository.toolExecutions).toHaveLength(2);
      expect(repository.toolExecutions[0]?.responseDetails).toMatchObject({
        metadataOnly: true,
        groupBy: "hour",
        returnedGroupCount: 12,
        hasMore: true,
        truncated: false,
      });
      expect(JSON.stringify(repository.toolExecutions)).not.toContain(
        "2026-11-07",
      );
    },
  );

  it("keeps application tools stable even when the provider also supports hosted search", async () => {
    const { repository, client, routing, search, request } = await setup();
    const provider = [...repository.providers.values()][0]!;
    provider.capabilities = { functionCalling: true, hostedWebSearch: true };
    await repository.updateProviderCapabilityProbe(provider.id, {
      functionCalling: "verified",
      hostedWebSearch: "verified",
      checkedAt: new Date(0).toISOString(),
    });
    const result = await new AgentRunner(
      routing,
      search,
      repository,
      undefined,
      {
        maxToolCalls: 1,
        maxToolOutputCharacters: 24000,
        maxToolDurationMs: 60000,
      },
    ).run(request);
    expect(result.status).toBe("succeeded");
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]?.tools?.map((t) => t.name)).toContain(
      "web_search",
    );
    expect(client.requests[1]?.tools).toEqual(client.requests[0]?.tools);
    expect(client.requests.every((r) => r.webSearch === undefined)).toBe(true);
    expect(client.requests[1]?.toolChoice).toBe("auto");
  });

  it("executes a legacy required local search with auto tool choice and continues the same provider", async () => {
    const { repository, client, routing, search, request } = await setup();
    const result = await new AgentRunner(routing, search, repository).run({
      ...request,
      promptTraceKey: "fictional-chat:workflow:ai-node",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      text: "Answer with source",
    });
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]).toMatchObject({ toolChoice: "auto" });
    expect(
      client.requests[1]?.messages.some((item) => item.role === "tool"),
    ).toBe(true);
    expect(repository.toolExecutions).toHaveLength(1);
    expect(repository.toolExecutions[0]).toMatchObject({
      status: "succeeded",
      resultCount: 1,
      requestDetails: { query: "fictional latest news" },
      responseDetails: {
        retainedResultCount: 1,
      },
    });
    expect(repository.toolExecutions[0]?.queryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(repository.attempts.map((attempt) => attempt.agentTurn)).toEqual([
      1, 2,
    ]);
    expect(client.requests.map((item) => item.promptTraceKey)).toEqual([
      "fictional-chat:workflow:ai-node:1",
      "fictional-chat:workflow:ai-node:2",
    ]);
  });

  it.each(["auto", "required"] as const)(
    "allows %s mode to answer without searching",
    async (policy) => {
      const { repository, search, request } = await setup();
      const directClient: AiClient = {
        call: () =>
          Promise.resolve({
            status: "succeeded",
            text: "Timeless answer",
            durationMs: 2,
          }),
      };
      const runner = new AgentRunner(
        new AiRoutingService(
          repository,
          directClient,
          new EnvironmentSecretResolver({ FICTIONAL_KEY: "fictional-secret" }),
          true,
        ),
        search,
      );
      await expect(
        runner.run({ ...request, webSearch: policy }),
      ).resolves.toMatchObject({
        status: "succeeded",
        text: "Timeless answer",
      });
    },
  );

  it("lets auto mode choose to answer after local search retries fail", async () => {
    const { repository, client, routing, request } = await setup(
      "I could not verify live information, so this is only stable background.",
    );
    const search: WebSearchTool = {
      isReady: () => Promise.resolve(true),
      search: () =>
        Promise.reject(
          new WebSearchToolError(
            "AI_WEB_SEARCH_TIMEOUT",
            "Search attempts timed out.",
            {
              responseDetails: {
                outcome: "failed",
                transportAttempts: [
                  { attempt: 1, errorCode: "AI_WEB_SEARCH_TIMEOUT" },
                  { attempt: 2, errorCode: "AI_WEB_SEARCH_TIMEOUT" },
                ],
              },
            },
          ),
        ),
    };

    await expect(
      new AgentRunner(routing, search, repository).run({
        ...request,
        webSearch: "auto",
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      text: "I could not verify live information, so this is only stable background.",
    });
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1]?.tools?.map((tool) => tool.name)).toContain(
      "web_search",
    );
    const failedToolMessage = client.requests[1]?.messages
      .filter((m) => m.role === "tool")
      .at(-1);
    expect(failedToolMessage?.role).toBe("tool");
    expect(failedToolMessage?.content).toContain('"status":"failed"');
    expect(repository.toolExecutions).toMatchObject([
      { status: "failed", errorCode: "AI_WEB_SEARCH_TIMEOUT" },
    ]);
  });

  it.each([false, true])(
    "keeps tools available for a revised query after a timeout (same-batch success: %s)",
    async (sameBatchSuccess) => {
      const { repository, request, search: workingSearch } = await setup();
      const requests: AiChatRequest[] = [];
      const queries: string[] = [];
      const client: AiClient = {
        call: (_provider, current) => {
          requests.push(structuredClone(current));
          const calls =
            requests.length === 1
              ? ["timeout", ...(sameBatchSuccess ? ["other"] : [])]
              : requests.length === 2
                ? ["revised"]
                : [];
          return Promise.resolve({
            status: "succeeded",
            text: calls.length ? "" : "Verified fictional answer",
            durationMs: 1,
            toolCalls: calls.map((query) => ({
              id: query,
              name: "web_search",
              arguments: JSON.stringify({ query }),
            })),
          });
        },
      };
      const runner = new AgentRunner(
        new AiRoutingService(
          repository,
          client,
          new EnvironmentSecretResolver({ FICTIONAL_KEY: "fictional-secret" }),
          true,
        ),
        {
          isReady: () => Promise.resolve(true),
          search: async (query, options) => {
            queries.push(query);
            if (query === "timeout")
              throw new WebSearchToolError(
                "AI_WEB_SEARCH_TIMEOUT",
                "Fictional timeout",
              );
            return workingSearch.search(query, options);
          },
        },
        repository,
      );
      const result = await runner.run({ ...request, webSearch: "auto" });
      expect(result.status).toBe("succeeded");
      expect(queries).toEqual([
        "timeout",
        ...(sameBatchSuccess ? ["other"] : []),
        "revised",
      ]);
      expect(requests[1]?.tools?.map((tool) => tool.name)).toContain(
        "web_search",
      );
      expect(result.agentBudget?.toolCalls).toBe(sameBatchSuccess ? 3 : 2);
      const policy = requests[0]?.messages.find(
        (message) => message.role === "system",
      )?.content;
      expect(policy).toContain(
        "10 tool calls, 64000 tool-result characters, and 90 seconds",
      );
      expect(policy).toContain("12 model rounds");
      expect(policy).toContain("native structured tool-call channel");
    },
  );

  it("allows required mode to opt into a degraded answer", async () => {
    const { repository, client, routing, request } = await setup(
      "Live search is unavailable; no current claim is made.",
    );
    const search: WebSearchTool = {
      isReady: () => Promise.resolve(true),
      search: () =>
        Promise.reject(
          new WebSearchToolError(
            "AI_WEB_SEARCH_CONNECTION_FAILED",
            "Search backend unavailable.",
          ),
        ),
    };

    await expect(
      new AgentRunner(routing, search, repository, {
        resolve: () =>
          Promise.resolve({
            maxAttempts: 2,
            attemptTimeoutMs: 8_000,
            retryDelayMs: 300,
            maxResults: 5,
            failurePolicy: "continue",
          }),
      }).run(request),
    ).resolves.toMatchObject({
      status: "succeeded",
      text: "Live search is unavailable; no current claim is made.",
    });
    expect(client.requests).toHaveLength(2);
  });

  it("allows legacy required mode to answer after an empty search", async () => {
    const { repository, client, routing, request } = await setup();
    const search: WebSearchTool = {
      isReady: () => Promise.resolve(true),
      search: () =>
        Promise.resolve({
          results: [],
          durationMs: 2,
          requestDetails: { query: "fictional latest news" },
          responseDetails: {
            outcome: "no_results",
            retainedResultCount: 0,
            engineFailures: [{ engine: "baidu", reason: "CAPTCHA" }],
          },
        }),
    };

    await expect(
      new AgentRunner(routing, search, repository).run(request),
    ).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(repository.toolExecutions).toMatchObject([
      {
        status: "succeeded",
        resultCount: 0,
        errorCode: null,
        responseDetails: {
          outcome: "no_results",
          retainedResultCount: 0,
        },
      },
    ]);
    const toolMessage = client.requests[1]?.messages.find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content).toContain('"status":"no_results"');
    expect(client.requests[0]?.tools?.[0]?.description).toContain(
      "Do not use site:",
    );
  });

  it("keeps earlier search evidence when a later refinement fails", async () => {
    const { repository, request } = await setup();
    const scriptedClient: AiClient & { requests: AiChatRequest[] } = {
      requests: [],
      call(_provider, chatRequest) {
        this.requests.push(structuredClone(chatRequest));
        switch (this.requests.length) {
          case 1:
            return Promise.resolve({
              status: "succeeded" as const,
              text: "",
              toolCalls: [
                {
                  id: "broad-search",
                  name: "web_search",
                  arguments: '{"query":"Segway 2026 products"}',
                },
              ],
              durationMs: 2,
            });
          case 2:
            return Promise.resolve({
              status: "succeeded" as const,
              text: "",
              toolCalls: [
                {
                  id: "site-search",
                  name: "web_search",
                  arguments:
                    '{"query":"site:segway.com.cn Segway 2026 products"}',
                },
              ],
              durationMs: 2,
            });
          default:
            return Promise.resolve({
              status: "succeeded" as const,
              text: "Answer from the first search with uncertainty",
              durationMs: 2,
            });
        }
      },
    };
    const routing = new AiRoutingService(
      repository,
      scriptedClient,
      new EnvironmentSecretResolver({ FICTIONAL_KEY: "fictional-secret" }),
      true,
    );
    let searchCalls = 0;
    const search: WebSearchTool = {
      isReady: () => Promise.resolve(true),
      search: () => {
        searchCalls += 1;
        if (searchCalls === 1) {
          return Promise.resolve({
            results: [
              {
                title: "Initial source",
                url: "https://news.example.test/segway",
                snippet: "Initial evidence",
                publishedAt: null,
                source: "fictional",
              },
            ],
            durationMs: 2,
          });
        }
        return Promise.reject(
          new WebSearchToolError(
            "AI_WEB_SEARCH_TIMEOUT",
            "The refinement timed out.",
            {
              requestDetails: {
                query: "site:segway.com.cn Segway 2026 products",
              },
            },
          ),
        );
      },
    };

    await expect(
      new AgentRunner(routing, search, repository).run(request),
    ).resolves.toMatchObject({
      status: "succeeded",
      text: "Answer from the first search with uncertainty",
    });
    expect(scriptedClient.requests).toHaveLength(3);
    expect(repository.toolExecutions).toMatchObject([
      { status: "succeeded", resultCount: 1 },
      { status: "failed", errorCode: "AI_WEB_SEARCH_TIMEOUT" },
    ]);
    const failedToolMessage = scriptedClient.requests[2]?.messages.find(
      (message) =>
        message.role === "tool" && message.toolCallId === "site-search",
    );
    expect(failedToolMessage?.content).toContain(
      '"errorCode":"AI_WEB_SEARCH_TIMEOUT"',
    );
  });

  it("uses collected results for a final answer when a tool-call batch exceeds the limit", async () => {
    const { repository, request } = await setup();
    const scriptedClient: AiClient & { requests: AiChatRequest[] } = {
      requests: [],
      call(_provider, chatRequest) {
        this.requests.push(structuredClone(chatRequest));
        if (this.requests.length === 1) {
          return Promise.resolve({
            status: "succeeded" as const,
            text: "",
            toolCalls: [
              {
                id: "initial-search",
                name: "web_search",
                arguments: '{"query":"fictional product latest news"}',
              },
            ],
            durationMs: 2,
          });
        }
        if (this.requests.length === 2) {
          return Promise.resolve({
            status: "succeeded" as const,
            text: "",
            toolCalls: [
              {
                id: "refinement-one",
                name: "web_search",
                arguments: '{"query":"fictional product price"}',
              },
              {
                id: "refinement-two",
                name: "web_search",
                arguments: '{"query":"fictional product release date"}',
              },
              {
                id: "over-limit-refinement",
                name: "web_search",
                arguments: '{"query":"fictional product configuration"}',
              },
            ],
            durationMs: 2,
          });
        }
        return Promise.resolve({
          status: "succeeded" as const,
          text: "Final answer from the three completed searches",
          durationMs: 2,
        });
      },
    };
    const routing = new AiRoutingService(
      repository,
      scriptedClient,
      new EnvironmentSecretResolver({ FICTIONAL_KEY: "fictional-secret" }),
      true,
    );
    let searchCalls = 0;
    const search: WebSearchTool = {
      isReady: () => Promise.resolve(true),
      search: () => {
        searchCalls += 1;
        return Promise.resolve({
          results: [
            {
              title: `Source ${searchCalls}`,
              url: `https://news.example.test/item-${searchCalls}`,
              snippet: "Fresh fact",
              publishedAt: null,
              source: "fictional",
            },
          ],
          durationMs: 2,
        });
      },
    };

    await expect(
      new AgentRunner(routing, search, repository, undefined, {
        maxToolCalls: 3,
        maxToolOutputCharacters: 24000,
        maxToolDurationMs: 60000,
      }).run(request),
    ).resolves.toMatchObject({
      status: "succeeded",
      text: "Final answer from the three completed searches",
    });
    expect(searchCalls).toBe(3);
    expect(scriptedClient.requests).toHaveLength(3);
    expect(scriptedClient.requests[2]?.webSearch).toBeUndefined();
    expect(scriptedClient.requests[2]?.tools).toEqual(
      scriptedClient.requests[0]?.tools,
    );
    expect(scriptedClient.requests[2]?.toolChoice).toBe("auto");
    expect(repository.toolExecutions).toMatchObject([
      { status: "succeeded", resultCount: 1 },
      { status: "succeeded", resultCount: 1 },
      { status: "succeeded", resultCount: 1 },
      {
        status: "failed",
        resultCount: null,
        errorCode: "AI_AGENT_TOOL_LIMIT_REACHED",
        requestDetails: {
          query: "fictional product configuration",
          skipped: true,
          reason: "tool_limit",
        },
      },
    ]);
    const skippedToolMessage = scriptedClient.requests[2]?.messages.find(
      (message) =>
        message.role === "tool" &&
        message.toolCallId === "over-limit-refinement",
    );
    expect(skippedToolMessage?.content).toContain(
      '"errorCode":"AI_AGENT_TOOL_LIMIT_REACHED"',
    );
  });

  it.each(["full", "compact", "hidden"] as const)(
    "guides %s source display without deleting answer links or audit results",
    async (mode) => {
      const answer = [
        "[Video](https://video.example.test/one)",
        "https://video.example.test/two",
        "<https://video.example.test/three>",
        "www.example.test/four",
        "Sources: https://news.example.test/item",
        '```python\nurl = "https://api.example.test/v1"\n```',
      ].join("\n");
      const { repository, client, routing, search, request } =
        await setup(answer);
      const result = await new AgentRunner(routing, search, repository).run({
        ...request,
        webSearchSources: mode,
      });
      expect(result).toMatchObject({ status: "succeeded", text: answer });
      const instruction = client.requests[0]?.messages
        .filter((message) => message.role === "system")
        .map((message) =>
          typeof message.content === "string" ? message.content : "",
        )
        .join("\n");
      expect(instruction).toContain(
        "Preserve URLs explicitly requested by the user",
      );
      expect(instruction).toContain(
        {
          full: "Cite source URLs when useful",
          compact: "This limit does not apply to task-required links",
          hidden: "Do not proactively add supporting citations",
        }[mode],
      );
      expect(repository.toolExecutions[0]?.responseDetails).toMatchObject({
        results: [{ url: "https://news.example.test/item" }],
      });
    },
  );

  it.each(["text", "json"] as const)(
    "preserves task URLs in %s without a search call under hidden sources",
    async (outputFormat) => {
      const answer =
        outputFormat === "json"
          ? JSON.stringify({
              links: [
                "https://video.example.test/one",
                { url: "https://video.example.test/two" },
              ],
              source: "来源：https://news.example.test/item",
            })
          : "Video one：https://video.example.test/one\nVideo two：https://video.example.test/two";
      const { repository, client, routing, search, request } = await setup();
      vi.spyOn(client, "call").mockResolvedValue({
        status: "succeeded",
        text: answer,
        durationMs: 1,
      });
      const result = await new AgentRunner(routing, search, repository).run({
        ...request,
        outputFormat,
        webSearch: "auto",
        webSearchSources: "hidden",
      });
      expect(result).toMatchObject({ status: "succeeded", text: answer });
      expect(repository.toolExecutions).toHaveLength(0);
    },
  );

  it("records searchable request and response diagnostics for tool failures", async () => {
    const { repository, routing, request } = await setup();
    const search: WebSearchTool = {
      isReady: () => Promise.resolve(false),
      search: () =>
        Promise.reject(
          new WebSearchToolError(
            "AI_WEB_SEARCH_ENGINES_UNAVAILABLE",
            "Search engines unavailable.",
            {
              requestDetails: {
                query: "fictional latest news",
                language: "zh-CN",
              },
              responseDetails: {
                retainedResultCount: 0,
                engineFailures: [{ engine: "duckduckgo", reason: "CAPTCHA" }],
              },
            },
          ),
        ),
    };

    await expect(
      new AgentRunner(routing, search, repository, {
        resolve: () =>
          Promise.resolve({
            maxAttempts: 2,
            attemptTimeoutMs: 8000,
            retryDelayMs: 300,
            maxResults: 5,
            failurePolicy: "fail",
          }),
      }).run(request),
    ).resolves.toMatchObject({
      status: "failed",
      code: "AI_WEB_SEARCH_ENGINES_UNAVAILABLE",
    });
    expect(repository.toolExecutions).toMatchObject([
      {
        status: "failed",
        resultCount: 0,
        errorCode: "AI_WEB_SEARCH_ENGINES_UNAVAILABLE",
        requestDetails: {
          query: "fictional latest news",
          language: "zh-CN",
        },
        responseDetails: {
          retainedResultCount: 0,
          engineFailures: [{ engine: "duckduckgo", reason: "CAPTCHA" }],
        },
      },
    ]);
  });
  it.each(["search_chat_history", "query_chat_messages"])(
    "offers %s without web search and redacts diagnostics",
    async (toolName) => {
      const { repository, client, routing, search, request } = await setup();
      const execute = vi.fn().mockResolvedValue(
        JSON.stringify({
          status: "succeeded",
          evidence: [{ ref: "M1", text: "fictional private history" }],
        }),
      );
      const memory = {
        repository: { scopeForEvent: vi.fn().mockResolvedValue({}) },
        session: vi.fn().mockResolvedValue({
          id: "fictional-retrieval",
          execute,
          validate: vi.fn().mockResolvedValue(true),
          render: (text: string) => text.replace(" [M1]", ""),
        }),
      } as unknown as MemoryService;
      vi.spyOn(client, "call").mockImplementation((_provider, input) => {
        client.requests.push(input);
        return Promise.resolve(
          input.messages.some((m) => m.role === "tool")
            ? {
                status: "succeeded",
                text: "Earlier decision [M1]",
                durationMs: 1,
              }
            : {
                status: "succeeded",
                text: "",
                durationMs: 1,
                toolCalls: [
                  {
                    id: "memory-call",
                    name: toolName,
                    arguments: JSON.stringify({
                      query: "fictional private query",
                    }),
                  },
                ],
              },
        );
      });
      const result = await new AgentRunner(
        routing,
        search,
        repository,
        undefined,
        undefined,
        memory,
      ).run({
        ...request,
        webSearch: "disabled",
        memoryEvent: { provider: "bluebubbles", messageId: "fictional" },
      });
      expect(result).toMatchObject({
        status: "succeeded",
        text: "Earlier decision",
      });
      expect(client.requests[0]?.tools?.map((t) => t.name)).toEqual([
        "query_chat_messages",
        "count_chat_messages",
        "get_chat_message_extrema",
        "search_chat_history",
        "read_chat_excerpt",
      ]);
      const policyText = JSON.stringify(client.requests[0]?.messages);
      expect(policyText).toContain("Preserve the configured persona");
      expect(policyText).toContain("Do not list irrelevant hits");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(repository.toolExecutions)).not.toContain(
        "fictional private",
      );
    },
  );
  it("does not force history calls for a greeting and does not grant tools without runtime context", async () => {
    const { repository, client, routing, request } = await setup();
    vi.spyOn(client, "call").mockResolvedValue({
      status: "succeeded",
      text: "Hello",
      durationMs: 1,
    });
    const open = vi.fn();
    const memory = {
      repository: { scopeForEvent: open },
    } as unknown as MemoryService;
    const result = await new AgentRunner(
      routing,
      undefined,
      repository,
      undefined,
      undefined,
      memory,
    ).run({ ...request, webSearch: "disabled" });
    expect(result.status).toBe("succeeded");
    expect(open).not.toHaveBeenCalled();
  });
  it("allows history-only answers when legacy web search is enabled", async () => {
    const { repository, client, routing, search, request } = await setup();
    const memory = {
      repository: { scopeForEvent: vi.fn().mockResolvedValue({}) },
      session: vi.fn().mockResolvedValue({
        id: "fixture",
        execute: vi.fn().mockResolvedValue("{}"),
        validate: vi.fn().mockResolvedValue(true),
        render: (v: string) => v,
      }),
    } as unknown as MemoryService;
    let calls = 0;
    vi.spyOn(client, "call").mockImplementation(() =>
      Promise.resolve(
        ++calls === 1
          ? {
              status: "succeeded",
              text: "",
              durationMs: 1,
              toolCalls: [
                {
                  id: "m",
                  name: "search_chat_history",
                  arguments: '{"query":"fixture"}',
                },
              ],
            }
          : { status: "succeeded", text: "Answer", durationMs: 1 },
      ),
    );
    const result = await new AgentRunner(
      routing,
      search,
      repository,
      undefined,
      undefined,
      memory,
    ).run({
      ...request,
      memoryEvent: { provider: "bluebubbles", messageId: "fixture" },
    });
    expect(result).toMatchObject({
      status: "succeeded",
      text: "Answer",
    });
  });
  it("bounds invalid historical citation correction to one request", async () => {
    const { repository, client, routing, request } = await setup();
    const memory = {
      repository: { scopeForEvent: vi.fn().mockResolvedValue({}) },
      session: vi.fn().mockResolvedValue({
        id: "fixture",
        validate: vi.fn().mockResolvedValue(true),
        render: () => null,
      }),
    } as unknown as MemoryService;
    const call = vi.spyOn(client, "call").mockResolvedValue({
      status: "succeeded",
      text: "Bad [M999]",
      durationMs: 1,
    });
    const result = await new AgentRunner(
      routing,
      undefined,
      repository,
      undefined,
      undefined,
      memory,
    ).run({
      ...request,
      webSearch: "disabled",
      memoryEvent: { provider: "bluebubbles", messageId: "fixture" },
    });
    expect(call).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: "succeeded",
      text: "Bad",
      agentBudget: {
        citationHandling: {
          invalidResponses: 2,
          correctionAttempts: 1,
          finalAction: "markers-removed",
        },
      },
    });
  });
});
