import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

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
    timeoutMs: 10_000,
    maxOutputCharacters: 4_000,
    outputFormat: "text",
    protectedPrompt: null,
    webSearch: "required",
  };
  return { repository, client, routing, search, request };
}

describe("AgentRunner", () => {
  it("executes a required local search and continues the same provider", async () => {
    const { repository, client, routing, search, request } = await setup();
    const result = await new AgentRunner(routing, search, repository).run(
      request,
    );
    expect(result).toMatchObject({
      status: "succeeded",
      text: "Answer with source",
    });
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]).toMatchObject({ toolChoice: "required" });
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
  });

  it("allows auto mode to answer without searching", async () => {
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
      runner.run({ ...request, webSearch: "auto" }),
    ).resolves.toMatchObject({
      status: "succeeded",
      text: "Timeless answer",
    });
  });

  it("hides searched source links while retaining tool audit results", async () => {
    const { repository, client, routing, search, request } = await setup(
      "Fresh fact [News](https://news.example.test/item) 详情：https://other.example.test/story，之后继续。\n来源：https://source.example.test",
    );
    const result = await new AgentRunner(routing, search, repository).run({
      ...request,
      webSearchSources: "hidden",
    });

    expect(result).toMatchObject({
      status: "succeeded",
      text: "Fresh fact News 详情，之后继续。",
    });
    const sourceInstruction = client.requests[0]?.messages.find(
      (message) =>
        message.role === "system" &&
        message.content.includes("do not include URLs"),
    );
    expect(sourceInstruction?.content).toContain("do not include URLs");
    expect(repository.toolExecutions[0]?.responseDetails).toMatchObject({
      results: [{ url: "https://news.example.test/item" }],
    });
  });

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
      new AgentRunner(routing, search, repository).run(request),
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
});
