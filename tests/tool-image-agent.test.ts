import type { AiRouteRequest } from "../modules/ai/ai-types.js";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AgentRunner } from "../modules/ai/agent-runner.js";
import { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import { OpenAiCompatibleClient } from "../modules/ai/openai-compatible-client.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";
import { PluginMcp } from "../modules/plugins/plugin-mcp.js";
import type { PluginService } from "../modules/plugins/plugin-service.js";
import type { InstalledPlugin } from "../modules/plugins/plugin-types.js";
import { imageBlock, preparedImages } from "./support/tool-image-fixture.js";

afterEach(() => vi.restoreAllMocks());
it.each(["chat-completions", "responses"] as const)(
  "carries mixed MCP images through %s only after ALL tool results",
  async (apiKind) => {
    const repo = new InMemoryAiRepository();
    const p = await repo.createProvider({
      name: "Fictional",
      apiKind,
      baseUrl: "https://example.test/v1",
      model: "fictional",
      secretRef: "FIXTURE_KEY",
      parameters: {},
      requestTimeoutMs: 5000,
      enabled: true,
      capabilities: {
        functionCalling: true,
        hostedWebSearch: false,
        imageInput: true,
      },
    });
    if (p.status !== "ok") throw new Error("fixture");
    await repo.updateProviderCapabilityProbe(p.value.id, {
      functionCalling: "verified",
      hostedWebSearch: "unknown",
      imageInput: "verified",
      checkedAt: new Date().toISOString(),
    });
    const r = await repo.createRoute({
      name: "Fictional",
      providerIds: [p.value.id],
      fallbackEnabled: false,
      retryPolicy: { maxRounds: 1, initialDelayMs: 0 },
      degradePolicy: { failureThreshold: 3, cooldownMs: 60000 },
      enabled: true,
    });
    if (r.status !== "ok") throw new Error("fixture");
    const tool = {
      server: "fixture",
      hash: "h",
      definition: {
        name: "view_image",
        description: "View fictional chart",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    };
    const plugin: InstalledPlugin = {
      id: "fixture",
      name: "Fictional",
      version: 1,
      revision: "r1",
      enabled: true,
      package: {
        name: "Fictional",
        version: "1",
        description: "fixture",
        format: "portable-1",
        hash: "r1",
        files: {},
        skills: [],
        servers: [],
      },
      config: {
        tools: [tool],
        disabledTools: [],
        disabledSkills: [],
        connections: {
          fixture: {
            url: "https://example.test/mcp",
            auth: "none",
            header: "X-Key",
            allowPrivate: false,
          },
        },
      },
    };
    vi.spyOn(PluginMcp.prototype, "connect").mockResolvedValue();
    vi.spyOn(PluginMcp.prototype, "discover").mockResolvedValue([tool]);
    vi.spyOn(PluginMcp.prototype, "close").mockResolvedValue();
    const block = await imageBlock();
    vi.spyOn(PluginMcp.prototype, "call").mockResolvedValue({
      status: "success",
      responseBytes: 1000,
      content: [
        { type: "text", text: "Fictional red chart" },
        { ...block, type: "image" },
        { type: "text", text: "End of chart" },
      ],
    });
    let calls = 0;
    const fetcher: typeof fetch = (_url, init) => {
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "null",
      ) as {
        tools: Array<{ name?: string; function?: { name: string } }>;
        messages?: Array<Record<string, unknown>>;
        input?: Array<Record<string, unknown>>;
      };
      calls++;
      if (calls === 1) {
        const ext = body.tools
          .map((t) => t.function?.name ?? t.name!)
          .find((name) => name.startsWith("ext_"))!;
        const argumentsJson = JSON.stringify({
          path: "/workspace/chart.png",
        });
        const toolCalls = ["first", "second"].map((id) => ({
          id,
          name: ext,
          arguments: argumentsJson,
        }));
        return Promise.resolve(
          new Response(
            JSON.stringify(
              apiKind === "responses"
                ? {
                    output: toolCalls.map((t) => ({
                      type: "function_call",
                      call_id: t.id,
                      name: t.name,
                      arguments: t.arguments,
                    })),
                  }
                : {
                    choices: [
                      {
                        message: {
                          content: null,
                          tool_calls: toolCalls.map((t) => ({
                            id: t.id,
                            type: "function",
                            function: { name: t.name, arguments: t.arguments },
                          })),
                        },
                        finish_reason: "tool_calls",
                      },
                    ],
                  },
            ),
          ),
        );
      }
      const messages = body.messages ?? body.input!;
      const outputs = messages
        .map((m, i) => ({ m, i }))
        .filter(
          ({ m }) => m.role === "tool" || m.type === "function_call_output",
        );
      expect(outputs).toHaveLength(2);
      const supplements = messages
        .map((m, i) => ({ m, i }))
        .filter(
          ({ m }) =>
            m.role === "user" &&
            Array.isArray(m.content) &&
            JSON.stringify(m.content).includes("data:image/"),
        );
      expect(supplements).toHaveLength(1);
      expect(supplements[0]!.i).toBeGreaterThan(outputs[1]!.i);
      expect(JSON.stringify(supplements[0]!.m)).toContain("first");
      expect(JSON.stringify(outputs)).not.toContain(block.data);
      expect(JSON.stringify(outputs)).toContain("already-in-context");
      expect(JSON.stringify(supplements[0]!.m)).toContain(
        apiKind === "responses" ? "input_image" : "image_url",
      );
      return Promise.resolve(
        new Response(
          JSON.stringify(
            apiKind === "responses"
              ? { output_text: "虚构图表为红色。" }
              : {
                  choices: [
                    {
                      message: { content: "虚构图表为红色。" },
                      finish_reason: "stop",
                    },
                  ],
                },
          ),
        ),
      );
    };
    const secrets = new EnvironmentSecretResolver({ FIXTURE_KEY: "fictional" });
    const routing = new AiRoutingService(
      repo,
      new OpenAiCompatibleClient(secrets, fetcher),
      secrets,
      false,
    );
    const service = {
      assertAvailable: () => Promise.resolve(),
      get: () => Promise.resolve(plugin),
    } as unknown as PluginService;
    const runner = new AgentRunner(
      routing,
      undefined,
      repo,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    const result = await runner.run({
      executionId: randomUUID(),
      nodeId: "ai",
      routeId: r.value.id,
      preparedImageInput: preparedImages(),
      messages: [{ role: "user", content: "Describe the fictional chart." }],
      maxOutputTokens: 256,
      temperature: null,
      maxOutputCharacters: 4000,
      outputFormat: "text",
      protectedPrompt: null,
      webSearch: "disabled",
      pluginIds: [plugin.id],
    });
    expect(result.status).toBe("succeeded");
    expect(calls).toBe(2);
    expect(result.agentBudget?.images?.tool).toBe(1);
    expect(repo.toolExecutions[0]?.responseDetails?.images).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "committed", toolCallId: "first" }),
      ]),
    );
    expect(repo.attempts[1]?.diagnostics?.imageInputs).toMatchObject({
      dispatched: true,
      images: [
        expect.objectContaining({ contentHash: expect.any(String) as string }),
      ],
    });
  },
);

it.each(["timeout", "text-limit"])(
  "never commits media after %s or emits an orphan image",
  async (mode) => {
    const commit = vi.fn();
    const requests: AiRouteRequest[] = [];
    const routing = {
      execute: (request: AiRouteRequest) => {
        requests.push(request);
        return Promise.resolve({
          status: "succeeded",
          text: requests.length === 1 ? "" : "图片未读取。",
          toolCalls:
            requests.length === 1
              ? [{ id: "inspect", name: "fixture_image", arguments: "{}" }]
              : [],
          providerId: "fixture",
          providerName: "Fixture",
          providerVersion: 1,
          model: "fixture",
          routeVersion: 1,
          round: 1,
          attemptCount: 1,
          durationMs: 1,
          diagnostics: null,
        });
      },
    } as unknown as AiRoutingService;
    const runner = new AgentRunner(routing, undefined, undefined, undefined, {
      maxToolCalls: 2,
      maxToolOutputCharacters: 4000,
      maxToolDurationMs: mode === "timeout" ? 10 : 5000,
    });
    const result = await runner.run({
      executionId: "fixture",
      nodeId: "ai",
      routeId: "fixture",
      messages: [{ role: "user", content: "查看图片" }],
      maxOutputTokens: 256,
      maxOutputCharacters: 4000,
      temperature: null,
      outputFormat: "text",
      webSearch: "disabled",
      protectedPrompt: null,
      preparedImageInput: preparedImages(),
      runtimeTools: [
        {
          definition: {
            name: "fixture_image",
            description: "fixture",
            parameters: { type: "object", properties: {} },
          },
          diagnostics: "plugin",
          execute: () =>
            Promise.resolve({
              text: JSON.stringify({
                status: "success",
                text: mode === "text-limit" ? "x".repeat(4000) : "image",
              }),
              validateCommit: async () => {
                if (mode === "timeout")
                  await new Promise((r) => setTimeout(r, 30));
              },
              commitResult: commit,
              media: {
                parts: [
                  {
                    type: "image",
                    dataUrl: "data:image/png;base64,ZmljdGlvbmFs",
                    label: "fictional",
                    detail: "auto",
                  },
                ],
                commit,
              },
            }),
        },
      ],
    });
    expect(result.status).toBe("succeeded");
    await new Promise((r) => setTimeout(r, 40));
    expect(commit).not.toHaveBeenCalled();
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("data:image");
    expect(result.agentBudget?.images?.tool).toBe(0);
  },
);
