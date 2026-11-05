import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunner } from "../modules/ai/agent-runner.js";
import { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";
import type { AiClient } from "../modules/ai/openai-compatible-client.js";
import type { AiChatRequest } from "../modules/ai/ai-types.js";
import type { PluginService } from "../modules/plugins/plugin-service.js";
import { PluginMcp } from "../modules/plugins/plugin-mcp.js";
import { digest } from "../modules/plugins/plugin-package.js";
import type {
  InstalledPlugin,
  Connection,
} from "../modules/plugins/plugin-types.js";
import type { AttachmentService } from "../modules/attachments/attachment-service.js";
import { AttachmentSession } from "../modules/attachments/attachment-session.js";
import { AttachmentStore } from "../modules/attachments/attachment-store.js";
import { attachmentLimitsSchema } from "../modules/attachments/attachment-policy.js";
import { createMcpHttp } from "../plugins/opensandbox/server/src/http.js";
import { SandboxPool } from "../plugins/opensandbox/server/src/lifecycle.js";
import type { Backend } from "../plugins/opensandbox/server/src/backend.js";
it.each(["responses", "chat-completions"] as const)(
  "pairs attachment and MCP calls under the shared Agent budget (%s)",
  async (apiKind) => {
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
      name: "Fictional",
      providerIds: [provider.value.id],
      fallbackEnabled: false,
      retryPolicy: { maxRounds: 1, initialDelayMs: 0 },
      degradePolicy: { failureThreshold: 3, cooldownMs: 60000 },
      enabled: true,
    });
    if (route.status !== "ok") throw new Error("fixture");
    const live = new Map<string, string>();
    let imported = false;
    const backend: Backend = {
      create: (owner) => {
        const id = randomUUID();
        live.set(id, owner);
        return Promise.resolve({
          id,
          close: () => Promise.resolve(),
          run: () =>
            Promise.resolve({
              status: "completed",
              exitCode: 0,
              stdout: imported ? "30" : "{}",
              stderr: "",
              durationMs: 1,
              truncated: false,
            }),
          upload: async (input, body) => {
            let size = 0;
            for await (const chunk of body) size += chunk.length;
            expect(size).toBe(input.size);
            imported = true;
            return {
              status: "imported",
              sandbox_path: `/workspace/attachments/${input.id}/${input.filename}`,
              size,
              sha256: input.sha256,
              expandedBytes: 0,
              expandedFiles: 0,
            };
          },
        });
      },
      owned: (owner) =>
        Promise.resolve(
          [...live].filter(([, o]) => !owner || o === owner).map(([id]) => id),
        ),
      remove: (id) => {
        live.delete(id);
        return Promise.resolve(true);
      },
      close: () => Promise.resolve(),
    };
    const pool = new SandboxPool(backend, 1, 600000);
    const service = createMcpHttp(pool, "fictional-token");
    await new Promise<void>((r) => service.http.listen(0, "127.0.0.1", r));
    const address = service.http.address();
    if (!address || typeof address === "string") throw new Error("address");
    const connection: Connection = {
      url: `http://127.0.0.1:${address.port}/mcp`,
      allowPrivate: true,
      auth: "bearer",
      secret: "fictional-token",
      header: "X-Key",
    };
    const root = await mkdtemp(join(tmpdir(), "bp-agent-attachment-"));
    const store = new AttachmentStore(root);
    await store.init();
    const probe = new PluginMcp();
    try {
      await probe.connect(connection);
      const tools = await probe.discover("sandbox");
      await probe.close();
      expect(live.size).toBe(0);
      const plugin: InstalledPlugin = {
        id: randomUUID(),
        name: "Sandbox fixture",
        enabled: true,
        version: 1,
        revision: "fixture",
        package: {
          name: "fixture",
          version: "1",
          description: "fixture",
          format: "portable-1",
          hash: "fixture",
          files: {},
          skills: [],
          servers: [],
        },
        config: {
          connections: { sandbox: connection },
          tools,
          disabledTools: [],
          disabledSkills: [],
        },
      };
      const plugins = {
        assertAvailable: () => Promise.resolve(),
        get: () => Promise.resolve(plugin),
      } as unknown as PluginService;
      const attachment = {
        providerAttachmentId: "fictional",
        fileName: "sample.csv",
        mimeType: "text/csv",
        sizeBytes: null,
      };
      const attachments: Pick<AttachmentService, "create"> = {
        create: (input, session) =>
          Promise.resolve(
            new AttachmentSession(
              input,
              session,
              {
                resolve: () =>
                  Promise.resolve({
                    messageId: "fixture-message",
                    providerMessageId: "current",
                    attachment,
                    attachmentIndex: 0,
                  }),
              },
              {
                download: () =>
                  Promise.resolve(new Response("sales\n10\n20\n")),
              },
              store,
            ),
          ),
      };
      const requests: AiChatRequest[] = [];
      const client: AiClient = {
        call: (_p, r) => {
          requests.push(r);
          let call;
          if (requests.length === 1) {
            const text = r.messages.find(
              (m) =>
                typeof m.content === "string" &&
                m.content.startsWith("Attachment metadata"),
            )?.content;
            if (typeof text !== "string") throw new Error("metadata");
            const catalog = JSON.parse(text.slice(text.indexOf("{"))) as {
              entries: Array<{ attachment_ref: string }>;
            };
            call = {
              id: "import",
              name: "import_chat_attachment",
              arguments: JSON.stringify({
                attachment_ref: catalog.entries[0]!.attachment_ref,
              }),
            };
          } else if (requests.length === 2) {
            const imported = r.messages.find(
              (m) => m.role === "tool" && m.toolCallId === "import",
            );
            expect(imported?.content).toContain('"status":"imported"');
            call = {
              id: "calculate",
              name: `ext_${digest([plugin.id, "sandbox", "run_command"]).slice(0, 24)}`,
              arguments: JSON.stringify({
                arguments_json: JSON.stringify({
                  command: "python analysis.py",
                }),
              }),
            };
          } else
            expect(
              r.messages.find(
                (m) => m.role === "tool" && m.toolCallId === "calculate",
              )?.content,
            ).toContain("30");
          return Promise.resolve({
            status: "succeeded" as const,
            text: call ? "" : "合计30。",
            durationMs: 1,
            ...(call ? { toolCalls: [call] } : {}),
          });
        },
      };
      const runner = new AgentRunner(
        new AiRoutingService(
          repo,
          client,
          new EnvironmentSecretResolver({ TEST_KEY: "fictional-key" }),
          false,
        ),
        undefined,
        repo,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        plugins,
        attachments as AttachmentService,
      );
      const result = await runner.run({
        executionId: randomUUID(),
        nodeId: "ai",
        routeId: route.value.id,
        messages: [{ role: "user", content: "汇总附件金额" }],
        maxOutputTokens: 256,
        temperature: null,
        maxOutputCharacters: 4000,
        outputFormat: "text",
        protectedPrompt: null,
        pluginIds: [plugin.id],
        attachmentInput: {
          config: {
            enabled: true,
            pluginId: plugin.id,
            server: "sandbox",
            limits: attachmentLimitsSchema.parse({}),
          },
          scope: {
            provider: "bluebubbles",
            providerChatId: "fictional",
            triggerMessageId: "current",
          },
          current: { providerMessageId: "current", attachments: [attachment] },
        },
      });
      expect(result.status).toBe("succeeded");
      expect(result.agentBudget?.toolCalls).toBe(2);
      expect(requests).toHaveLength(3);
      const names = requests[0]!.tools!.map((t) => t.name);
      for (const r of requests)
        expect(r.tools!.map((t) => t.name)).toEqual(names);
      await pool.sweep();
      expect(live.size).toBe(0);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await probe.close();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
