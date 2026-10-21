import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { AgentRunner } from "../modules/ai/agent-runner.js";
import { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";
import type { AiClient } from "../modules/ai/openai-compatible-client.js";
import type { AiChatRequest } from "../modules/ai/ai-types.js";
import type { PluginService } from "../modules/plugins/plugin-service.js";
import { startMockMcp } from "../modules/plugins/mock-mcp.js";
import { PluginMcp } from "../modules/plugins/plugin-mcp.js";
import { parsePluginPackage } from "../modules/plugins/plugin-package.js";
describe.each(["responses", "chat-completions"] as const)(
  "plugin agent %s",
  (apiKind) => {
    let mock: Awaited<ReturnType<typeof startMockMcp>>;
    beforeAll(async () => {
      mock = await startMockMcp();
    });
    afterAll(async () => {
      await mock.close();
    });
    it("loads a skill then calls HTTP MCP and continues tool pairing with search disabled", async () => {
      const repo = new InMemoryAiRepository();
      const provider = await repo.createProvider({
        name: "Fictional",
        apiKind,
        baseUrl: "https://example.test/v1",
        model: "fixture",
        secretRef: "TEST_KEY",
        parameters: {},
        requestTimeoutMs: 5000,
        enabled: true,
        capabilities: { functionCalling: true, hostedWebSearch: false },
      });
      if (provider.status !== "ok") throw new Error("fixture");
      await repo.updateProviderCapabilityProbe(provider.value.id, {
        functionCalling: "verified",
        hostedWebSearch: "unknown",
        checkedAt: new Date().toISOString(),
      });
      const route = await repo.createRoute({
        name: "Fixture",
        providerIds: [provider.value.id],
        fallbackEnabled: false,
        retryPolicy: { maxRounds: 1, initialDelayMs: 0 },
        degradePolicy: { failureThreshold: 3, cooldownMs: 60000 },
        enabled: true,
      });
      if (route.status !== "ok") throw new Error("fixture");
      const id = randomUUID();
      const pkg = parsePluginPackage(
        {
          "plugin.json": JSON.stringify({
            $schema:
              "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            name: "fictional",
            version: "1.0.0",
            description: "Test",
          }),
          "skills/demo/SKILL.md":
            "---\nname: demo\ndescription: Use when asked for plugin test\n---\nAnswer with fictional greeting.",
        },
        ".",
      );
      const connection = {
        url: mock.url,
        allowPrivate: true,
        auth: "none" as const,
        header: "X-Api-Key",
      };
      const mcp = new PluginMcp();
      await mcp.connect(connection);
      const tools = await mcp.discover("fictional");
      await mcp.close();
      const plugin = {
        id,
        name: pkg.name,
        version: 1,
        revision: pkg.hash,
        enabled: true,
        package: pkg,
        config: {
          connections: { fictional: connection },
          tools,
          disabledSkills: [],
          disabledTools: [],
        },
      };
      const service = {
        assertAvailable: () => Promise.resolve(),
        get: () => Promise.resolve(plugin),
      } as unknown as PluginService;
      const requests: AiChatRequest[] = [];
      const client: AiClient = {
        call: (_p, r) => {
          requests.push(r);
          return Promise.resolve(
            requests.length === 1
              ? {
                  status: "succeeded",
                  text: "",
                  durationMs: 1,
                  toolCalls: [
                    {
                      id: "skill-call",
                      name: "load_plugin_skill",
                      arguments: JSON.stringify({
                        id: `${id}:skills/demo/SKILL.md`,
                      }),
                    },
                  ],
                }
              : requests.length === 2
                ? {
                    status: "succeeded",
                    text: "",
                    durationMs: 1,
                    toolCalls: [
                      {
                        id: "mcp-call",
                        name: r.tools!.find((t) => t.name.startsWith("ext_"))!
                          .name,
                        arguments: JSON.stringify({
                          arguments_json: JSON.stringify({ query: "library" }),
                        }),
                      },
                    ],
                  }
                : {
                    status: "succeeded",
                    text: "虚构图书馆周二开放。",
                    durationMs: 1,
                  },
          );
        },
      };
      const routing = new AiRoutingService(
        repo,
        client,
        new EnvironmentSecretResolver({ TEST_KEY: "fictional-api-secret" }),
        false,
      );
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
      const executionId = randomUUID();
      const result = await runner.run({
        executionId,
        nodeId: "ai",
        routeId: route.value.id,
        messages: [{ role: "user", content: "Test plugin" }],
        maxOutputTokens: 256,
        temperature: null,
        maxOutputCharacters: 4000,
        outputFormat: "text",
        protectedPrompt: null,
        webSearch: "disabled",
        pluginIds: [id],
      });
      expect(result.status).toBe("succeeded");
      expect(
        requests[0]?.messages.some(
          (message) =>
            message.role === "system" &&
            typeof message.content === "string" &&
            message.content.includes("prefer the built-in web_search") &&
            message.content.includes("Never claim to have read a page"),
        ),
      ).toBe(true);
      expect(requests).toHaveLength(3);
      expect(
        requests[2]?.messages.some(
          (m) =>
            m.role === "tool" &&
            m.toolCallId === "mcp-call" &&
            typeof m.content === "string" &&
            m.content.includes("图书馆"),
        ),
      ).toBe(true);
      expect(
        requests[1]?.messages.some(
          (m) => m.role === "tool" && m.toolCallId === "skill-call",
        ),
      ).toBe(true);
      const calls = await repo.listToolExecutions(executionId);
      expect(
        calls.find((call) => call.toolName.startsWith("ext_"))?.requestDetails,
      ).toMatchObject({
        pluginName: "fictional",
        server: "fictional",
        tool: "lookup",
      });
      expect(result.agentBudget?.toolCalls).toBe(2);
      expect(result.agentBudget?.plugins?.[0]?.revision).toBe(pkg.hash);
    });
  },
);
