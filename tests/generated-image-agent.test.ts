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
it.each(
  (
    [
      ["chat-completions", "strict", false],
      ["chat-completions", "compatible", false],
      ["responses", "strict", false],
      ["responses", "compatible", false],
      ["chat-completions", "strict", true],
      ["chat-completions", "compatible", true],
      ["responses", "strict", true],
      ["responses", "compatible", true],
    ] as const
  ).flatMap(([apiKind, mode, fallback]) =>
    (["png", "txt"] as const).map(
      (format) => [apiKind, mode, fallback, format] as const,
    ),
  ),
)(
  "completes an attachment reply using %s / %s, fallback=%s, file=%s",
  async (apiKind, initialMode, withFallback, fileFormat) => {
    const toolSchemaMode = withFallback
      ? initialMode === "strict"
        ? "compatible"
        : "strict"
      : initialMode;
    const repo = new InMemoryAiRepository();
    const provider = await repo.createProvider({
      name: "Fictional",
      apiKind,
      toolSchemaMode: initialMode,
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
    const providerIds = [provider.value.id];
    if (withFallback) {
      const fallback = await repo.createProvider({
        name: "Fictional fallback",
        apiKind,
        toolSchemaMode,
        baseUrl: "https://example.test/v1",
        model: "fictional-fallback",
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
      if (fallback.status !== "ok") throw new Error("fixture");
      await repo.updateProviderCapabilityProbe(fallback.value.id, {
        functionCalling: "verified",
        hostedWebSearch: "unknown",
        imageInput: "unknown",
        checkedAt: new Date().toISOString(),
      });
      providerIds.push(fallback.value.id);
    }
    const route = await repo.createRoute({
      name: "Fictional",
      providerIds,
      fallbackEnabled: withFallback,
      retryPolicy: { maxRounds: 1, initialDelayMs: 0 },
      degradePolicy: { failureThreshold: 3, cooldownMs: 60000 },
      enabled: true,
    });
    if (route.status !== "ok") throw new Error("fixture");
    const tools: ApprovedTool[] = [
      "prepare_sandbox",
      "write_file",
      "run_command",
    ].map((name) => ({
      server: "fixture",
      hash: name,
      ...(name === "prepare_sandbox"
        ? { imageExportVersion: 1 as const, fileExportVersion: 1 as const }
        : {}),
      definition: {
        name,
        description: name,
        parameters: {
          type: "object",
          properties:
            name === "run_command"
              ? {
                  command: { type: "string" },
                  timeout_seconds: {
                    type: "integer",
                    minimum: 1,
                    maximum: 120,
                  },
                }
              : name === "write_file"
                ? { path: { type: "string" }, text: { type: "string" } }
                : {},
          required:
            name === "run_command"
              ? ["command"]
              : name === "write_file"
                ? ["path", "text"]
                : [],
          additionalProperties: false,
        },
      },
    }));
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
    const remoteCall = vi.spyOn(PluginMcp.prototype, "call").mockResolvedValue({
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
        width: fileFormat === "png" ? 600 : null,
        height: fileFormat === "png" ? 400 : null,
        filename: `result.${fileFormat}`,
        mime_type: fileFormat === "png" ? "image/png" : "text/plain",
        file_type: fileFormat,
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
    const drawing =
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120">\n<text x="10" y="20">Fictional chart</text>\n</svg>';
    const writePath =
      fileFormat === "png" ? "/workspace/chart.svg" : "/workspace/analyze.py";
    const text =
      fileFormat === "png"
        ? drawing
        : 'from pathlib import Path\nPath("/workspace/result.txt").write_text("fictional total: 3")';
    const command =
      fileFormat === "png"
        ? "bp-render-svg /workspace/chart.svg /workspace/chart.png"
        : "python /workspace/analyze.py";
    const outputPath =
      fileFormat === "png" ? "/workspace/chart.png" : "/workspace/result.txt";
    const actions: Array<{ name: string; args: Record<string, unknown> }> =
      tools.map((tool) => ({
        name: `ext_${digest([plugin.id, tool.server, tool.definition.name]).slice(0, 24)}`,
        args:
          tool.definition.name === "run_command"
            ? {
                command,
                ...(toolSchemaMode === "strict"
                  ? { timeout_seconds: null }
                  : {}),
              }
            : tool.definition.name === "write_file"
              ? { path: writePath, text }
              : {},
      }));
    actions.push({
      name: "prepare_chat_attachment",
      args: { path: outputPath },
    });
    let calls = 0;
    let failedPrimary = 0;
    const fetcher: typeof fetch = (_url, init) => {
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "null",
      ) as {
        model: string;
        tools: Array<{
          name?: string;
          parameters?: Record<string, unknown>;
          function?: { name: string; parameters: Record<string, unknown> };
        }>;
        messages?: Record<string, unknown>[];
        input?: Record<string, unknown>[];
      };
      for (const wire of body.tools) {
        const definition = wire.function ?? wire;
        if (definition.name?.startsWith("ext_")) {
          expect(definition.parameters?.properties).not.toHaveProperty(
            "arguments_json",
          );
          if (
            Object.hasOwn(
              definition.parameters?.properties ?? {},
              "timeout_seconds",
            )
          ) {
            const mode =
              body.model === "fictional" ? initialMode : toolSchemaMode;
            expect(definition.parameters?.required).toEqual(
              mode === "strict" ? ["command", "timeout_seconds"] : ["command"],
            );
          }
        }
      }
      if (withFallback && body.model === "fictional") {
        failedPrimary++;
        return Promise.resolve(
          new Response('{"error":{"message":"Fictional temporary failure"}}', {
            status: 503,
          }),
        );
      }
      const messages = body.messages ?? body.input!;
      expect(JSON.stringify(messages)).not.toContain("data:image/");
      expect(JSON.stringify(messages)).not.toContain("fixture-binary");
      const action = actions[calls++];
      if (!action) {
        const outputs = messages.filter(
          (m) => m.role === "tool" || m.type === "function_call_output",
        );
        expect(outputs).toHaveLength(4);
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
        config: {
          enabled: true,
          pluginId: plugin.id,
          server: "fixture",
          allowedTypes: [fileFormat],
        },
        executionId,
        nodeId: "ai",
        chatId: "fictional-chat",
      },
    });
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") throw new Error(result.code);
    expect(result.text).toBe("");
    expect(result.generatedImage?.id).toBe(artifact.id);
    expect(result.agentBudget).toMatchObject({ toolCalls: 4, modelTurns: 5 });
    expect(calls).toBe(5);
    expect(failedPrimary > 0).toBe(withFallback);
    expect(remoteCall.mock.calls[1]?.[1]).toEqual({
      path: writePath,
      text,
    });
    expect(remoteCall.mock.calls[2]?.[1]).toEqual({
      command,
    });
    expect(exportImage).toHaveBeenCalledOnce();
    expect(exportImage.mock.calls[0]?.[2]).toBe(fileFormat !== "png");
    expect(discard).toHaveBeenCalledWith(expect.any(String), artifact.id);
  },
);
