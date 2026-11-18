import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AgentRunner } from "../modules/ai/agent-runner.js";
import { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import { OpenAiCompatibleClient } from "../modules/ai/openai-compatible-client.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";
import { PluginMcp } from "../modules/plugins/plugin-mcp.js";
import type { PluginService } from "../modules/plugins/plugin-service.js";
import type {
  InstalledPlugin,
  ApprovedTool,
} from "../modules/plugins/plugin-types.js";
import { digest } from "../modules/plugins/plugin-package.js";
import type {
  GeneratedImageStore,
  ImageArtifact,
} from "../modules/generated-images/image-store.js";
afterEach(() => vi.restoreAllMocks());
it.each([
  ["chat-completions", "strict"],
  ["chat-completions", "compatible"],
  ["responses", "strict"],
  ["responses", "compatible"],
] as const)(
  "completes a PNG-only reply with three tool calls using %s / %s",
  async (apiKind, toolSchemaMode) => {
    const repo = new InMemoryAiRepository();
    const provider = await repo.createProvider({
      name: "Fictional",
      apiKind,
      toolSchemaMode,
      baseUrl: "https://example.test/v1",
      model: "fictional",
      secretRef: "FIXTURE_KEY",
      parameters: {},
      requestTimeoutMs: 5000,
      enabled: true,
      capabilities: {
        functionCalling: true,
        hostedWebSearch: false,
        imageInput: false,
      },
    });
    if (provider.status !== "ok") throw new Error("fixture");
    await repo.updateProviderCapabilityProbe(provider.value.id, {
      functionCalling: "verified",
      hostedWebSearch: "unknown",
      imageInput: "unknown",
      checkedAt: new Date().toISOString(),
    });
    const route = await repo.createRoute({
      name: "Fictional",
      providerIds: [provider.value.id],
      fallbackEnabled: false,
      retryPolicy: { maxRounds: 1, initialDelayMs: 0 },
      degradePolicy: { failureThreshold: 3, cooldownMs: 60000 },
      enabled: true,
    });
    if (route.status !== "ok") throw new Error("fixture");
    const tools: ApprovedTool[] = ["prepare_sandbox", "run_command"].map(
      (name) => ({
        server: "fixture",
        hash: name,
        ...(name === "prepare_sandbox"
          ? { imageExportVersion: 1 as const }
          : {}),
        definition: {
          name,
          description: name,
          parameters: {
            type: "object",
            properties:
              name === "run_command" ? { command: { type: "string" } } : {},
            required: name === "run_command" ? ["command"] : [],
            additionalProperties: false,
          },
        },
      }),
    );
    const plugin: InstalledPlugin = {
      id: randomUUID(),
      name: "Fictional",
      version: 1,
      revision: "r1",
      enabled: true,
      package: {
        name: "fixture",
        version: "1",
        description: "fixture",
        format: "portable-1",
        hash: "r1",
        files: {},
        skills: [],
        servers: [],
      },
      config: {
        tools,
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
    vi.spyOn(PluginMcp.prototype, "discover").mockResolvedValue(tools);
    vi.spyOn(PluginMcp.prototype, "close").mockResolvedValue();
    vi.spyOn(PluginMcp.prototype, "call").mockResolvedValue({
      status: "success",
      responseBytes: 100,
      content: [{ type: "text", text: '{"status":"completed"}' }],
    });
    const exportImage = vi
      .spyOn(PluginMcp.prototype, "exportImage")
      .mockResolvedValue(Buffer.from("fixture-binary"));
    const executionId = randomUUID(),
      artifact = {
        id: randomUUID(),
        execution_id: executionId,
        sha256: "b".repeat(64),
        width: 600,
        height: 400,
        size: 1000,
      } as ImageArtifact;
    const discard = vi.fn().mockResolvedValue(undefined);
    const store = {
      save: vi.fn().mockResolvedValue(artifact),
      ref: (row: ImageArtifact) => ({
        id: row.id,
        sha256: row.sha256,
        executionId: row.execution_id,
      }),
      discard,
    } as unknown as GeneratedImageStore;
    const actions = tools.map((tool) => ({
      name: `ext_${digest([plugin.id, tool.server, tool.definition.name]).slice(0, 24)}`,
      args: {
        arguments_json: JSON.stringify(
          tool.definition.name === "run_command"
            ? { command: "python draw_and_render.py" }
            : {},
        ),
      },
    }));
    actions.push({
      name: "prepare_chat_image",
      args: { path: "/workspace/chart.png" },
    } as unknown as (typeof actions)[number]);
    let calls = 0;
    const fetcher: typeof fetch = (_url, init) => {
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "null",
      ) as {
        messages?: Record<string, unknown>[];
        input?: Record<string, unknown>[];
      };
      const messages = body.messages ?? body.input!;
      expect(JSON.stringify(messages)).not.toContain("data:image/");
      expect(JSON.stringify(messages)).not.toContain("fixture-binary");
      const action = actions[calls++];
      if (!action) {
        const outputs = messages.filter(
          (m) => m.role === "tool" || m.type === "function_call_output",
        );
        expect(outputs).toHaveLength(3);
        expect(JSON.stringify(outputs)).toContain("pending_reply_node");
      }
      return Promise.resolve(
        new Response(
          JSON.stringify(
            apiKind === "responses"
              ? action
                ? {
                    output: [
                      {
                        type: "function_call",
                        call_id: `call${calls}`,
                        name: action.name,
                        arguments: JSON.stringify(action.args),
                      },
                    ],
                  }
                : {
                    output: [
                      {
                        type: "message",
                        role: "assistant",
                        content: [{ type: "output_text", text: "" }],
                      },
                    ],
                    status: "completed",
                  }
              : {
                  choices: [
                    {
                      message: action
                        ? {
                            content: null,
                            tool_calls: [
                              {
                                id: `call${calls}`,
                                type: "function",
                                function: {
                                  name: action.name,
                                  arguments: JSON.stringify(action.args),
                                },
                              },
                            ],
                          }
                        : { content: "" },
                      finish_reason: action ? "tool_calls" : "stop",
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
      undefined,
      store,
    );
    const result = await runner.run({
      executionId,
      nodeId: "ai",
      routeId: route.value.id,
      messages: [
        {
          role: "user",
          content: "Draw a fictional chart. Reply with the image only.",
        },
      ],
      maxOutputTokens: 256,
      temperature: null,
      maxOutputCharacters: 4000,
      outputFormat: "text",
      protectedPrompt: null,
      webSearch: "disabled",
      pluginIds: [plugin.id],
      imageReplyInput: {
        config: { enabled: true, pluginId: plugin.id, server: "fixture" },
        executionId,
        nodeId: "ai",
        chatId: "fictional-chat",
      },
    });
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error(result.code);
    expect(result.text).toBe("");
    expect(result.generatedImage?.id).toBe(artifact.id);
    expect(result.agentBudget).toMatchObject({ toolCalls: 3, modelTurns: 4 });
    expect(calls).toBe(4);
    expect(exportImage).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledWith(expect.any(String), artifact.id);
  },
);
