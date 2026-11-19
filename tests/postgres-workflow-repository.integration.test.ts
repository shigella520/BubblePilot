import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";
import type {
  ReplyGateway,
  SendReplyCommand,
} from "../modules/integrations/bluebubbles/reply-gateway.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import {
  createDefaultNodeRegistry,
  NodeRegistry,
  type NodeHandler,
} from "../modules/workflow/node-registry.js";
import { WorkflowExecutionError } from "../modules/workflow/workflow-errors.js";
import { PostgresWorkflowRepository } from "../modules/workflow/postgres-workflow-repository.js";
import { WorkflowEngine } from "../modules/workflow/workflow-engine.js";
import { parseTriggerConditions } from "../modules/workflow/trigger-matcher.js";
import { parseWorkflowDefinition } from "../modules/workflow/workflow-definition.js";
import { newMessageWebhook } from "./fixtures/bluebubbles.js";

import {
  exportWorkflowManifest,
  importWorkflowManifest,
} from "../modules/workflow/workflow-manifest.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

class ConfirmingReplyGateway implements ReplyGateway {
  readonly commands: SendReplyCommand[] = [];

  sendReply(command: SendReplyCommand) {
    this.commands.push(command);
    return Promise.resolve({
      status: "confirmed" as const,
      providerMessageId: `fictional-outbound-${this.commands.length}`,
    });
  }
}

describe.runIf(testDatabaseUrl !== undefined)(
  "PostgresWorkflowRepository",
  () => {
    let repository: PostgresWorkflowRepository;
    let archive: PostgresArchiveRepository;
    let admin: Client;
    let connection: string;
    const name = `bubblepilot_workflow_${randomUUID().replaceAll("-", "")}_test`;

    beforeAll(async () => {
      admin = new Client({ connectionString: testDatabaseUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}"`);
      const address = new URL(testDatabaseUrl!);
      address.pathname = `/${name}`;
      connection = address.toString();
      const db = new Client({ connectionString: connection });
      await db.connect();
      try {
        for (const file of (
          await readdir(new URL("../migrations/", import.meta.url))
        )
          .filter((file) => file.endsWith(".sql"))
          .sort())
          await db.query(
            await readFile(
              new URL(`../migrations/${file}`, import.meta.url),
              "utf8",
            ),
          );
      } finally {
        await db.end();
      }
      repository = new PostgresWorkflowRepository(connection);
      archive = new PostgresArchiveRepository(connection);
    }, 30000);

    afterAll(async () => {
      await Promise.all([repository?.close(), archive?.close()]);
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
        await admin.end();
      }
    });

    it("aggregates timing by execution without multiplying traces or counting AI nodes twice", async () => {
      const db = new Client({ connectionString: connection });
      await db.connect();
      const workflow = randomUUID(),
        version = randomUUID(),
        trigger = randomUUID(),
        provider = randomUUID(),
        route = randomUUID();
      const id = randomUUID(),
        empty = randomUUID();
      try {
        await db.query(
          "INSERT INTO workflows(id,name,status) VALUES($1,$2,'active')",
          [workflow, `Fictional timing ${workflow}`],
        );
        await db.query(
          "INSERT INTO workflow_versions(id,workflow_id,version,status,definition) VALUES($1,$2,1,'published','{\"nodes\":[]}'::jsonb)",
          [version, workflow],
        );
        await db.query(
          "INSERT INTO bot_triggers(id,name,workflow_version_id,conditions,include_from_me,enabled) VALUES($1,'Fictional timing',$2,'{}',false,true)",
          [trigger, version],
        );
        await db.query(
          "INSERT INTO ai_providers(id,name,api_kind,base_url,model,secret_ref,request_timeout_ms,sort_order) VALUES($1,$2,'chat-completions','https://fictional.example.test','fictional','fictional',1000,1)",
          [provider, `Fictional ${provider}`],
        );
        await db.query(
          "INSERT INTO ai_provider_routes(id,name) VALUES($1,$2)",
          [route, `Fictional ${route}`],
        );
        for (const execution of [id, empty])
          await db.query(
            "INSERT INTO workflow_executions(id,provider,external_event_id,trigger_id,workflow_version_id,correlation_id,status,started_at,completed_at) VALUES($1::uuid,'fictional',$1::text,$2,$3,$4,'succeeded','2026-01-01T00:00:00Z','2026-01-01T00:00:10Z')",
            [execution, trigger, version, randomUUID()],
          );
        for (const [sequence, duration, status] of [
          [1, 2000, "failed"],
          [2, 3000, "succeeded"],
        ] as const)
          await db.query(
            "INSERT INTO ai_provider_attempts(id,execution_id,node_id,route_id,route_version,provider_id,provider_name,provider_version,model,round,sequence,status,selection_health_state,health_state,duration_ms) VALUES($1,$2,'ai',$3,1,$4,'fictional',1,'fictional',1,$5,$6,'healthy','healthy',$7)",
            [randomUUID(), id, route, provider, sequence, status, duration],
          );
        for (const duration of [700, 800])
          await db.query(
            "INSERT INTO ai_tool_executions(id,execution_id,node_id,provider_id,tool_call_id,tool_name,status,duration_ms,query_hash) VALUES($1::uuid,$2,'ai',$3,$1::text,'fictional_tool','succeeded',$4,$5)",
            [randomUUID(), id, provider, duration, "a".repeat(64)],
          );
        for (const [type, duration] of [
          ["ai-chat", 9000],
          ["reply", 300],
          ["load-context", 100],
          ["log", null],
        ] as const)
          await db.query(
            "INSERT INTO node_executions(id,execution_id,node_id,node_type,node_version,attempt,status,duration_ms) VALUES($1,$2,$3,$3,1,1,$4,$5)",
            [
              randomUUID(),
              id,
              type,
              duration === null ? "running" : "succeeded",
              duration,
            ],
          );
        const detail = await repository.getExecution(id);
        expect(detail?.timing).toMatchObject({
          totalMs: 10000,
          categories: {
            model: { durationMs: 5000, count: 2, recordedCount: 2 },
            tools: { durationMs: 1500, count: 2, recordedCount: 2 },
            delivery: { durationMs: 300, count: 1, recordedCount: 1 },
            otherNodes: { durationMs: 100, count: 2, recordedCount: 1 },
          },
        });
        const page = await repository.listExecutions({
          limit: 100,
          cursor: null,
        });
        expect(page.find((x) => x.id === id)?.timing?.categories).toEqual(
          detail?.timing?.categories,
        );
        expect(
          page.find((x) => x.id === empty)?.timing?.categories.model,
        ).toEqual({ durationMs: null, count: 0, recordedCount: 0 });
        await db.query(
          `UPDATE workflow_executions SET status='closed',startup_closure='{"closedAt":"2026-01-01T00:00:10Z"}' WHERE id=$1`,
          [empty],
        );
        await db.query(
          "INSERT INTO node_executions(id,execution_id,node_id,node_type,node_version,attempt,status,duration_ms,completed_at,error_code) VALUES($1,$2,'reply','reply',1,1,'failed',86400000,'2026-01-01T00:00:10Z','FICTIONAL_OLD_ERROR')",
          [randomUUID(), empty],
        );
        const closed = await repository.getExecution(empty);
        expect(closed?.timing).toMatchObject({
          totalMs: null,
          unavailableReason: "closed",
          categories: {
            delivery: { durationMs: null, count: 1, recordedCount: 0 },
          },
        });
      } finally {
        await db.query(
          "DELETE FROM workflow_executions WHERE id=ANY($1::uuid[])",
          [[id, empty]],
        );
        await db.query("DELETE FROM bot_triggers WHERE id=$1", [trigger]);
        await db.query("DELETE FROM workflow_versions WHERE id=$1", [version]);
        await db.query("DELETE FROM workflows WHERE id=$1", [workflow]);
        await db.query("DELETE FROM ai_providers WHERE id=$1", [provider]);
        await db.query("DELETE FROM ai_provider_routes WHERE id=$1", [route]);
        await db.end();
      }
    });

    it("retains exported message and text bindings through import persistence and reload", async () => {
      const routeId = randomUUID();
      const catalog = {
        aiRoutes: [
          {
            id: routeId,
            name: "Fictional route",
            capabilities: ["text" as const, "function-calling" as const],
          },
        ],
        chats: [],
      };
      const definition = parseWorkflowDefinition({
        schemaVersion: "1",
        name: "Fictional linked workflow",
        startNodeId: "load-context",
        nodes: [
          {
            id: "load-context",
            type: "load-context",
            version: 1,
            config: {},
            onSuccess: "ai",
          },
          {
            id: "ai",
            type: "ai-chat",
            version: 1,
            inputs: {
              messages: {
                kind: "output",
                blockId: "load-context",
                port: "messages",
              },
            },
            config: {
              providerRouteId: routeId,
              systemPrompt: "Fictional prompt",
              promptTemplate: "{{message.text}}",
            },
            onSuccess: "reply",
          },
          {
            id: "reply",
            type: "reply",
            version: 1,
            inputs: { text: { kind: "output", blockId: "ai", port: "text" } },
            config: { text: "{{variables.aiReply}}" },
            onSuccess: "done",
          },
          {
            id: "done",
            type: "end",
            version: 1,
            config: { result: "succeeded" },
          },
        ],
      });
      const source = await repository.createWorkflow(
        definition.name,
        definition,
      );
      const manifest = exportWorkflowManifest({
        definition: source.definition,
        mode: "portable",
        catalog,
      });
      manifest.metadata.name = "Fictional renamed workflow";
      manifest.spec.nodes.find(
        (node) => node.id === "ai",
      )!.config.systemPrompt = "Edited fictional prompt";
      const imported = importWorkflowManifest({
        manifest: JSON.parse(JSON.stringify(manifest)),
        catalog,
      });
      expect(imported.issues).toEqual([]);
      const restored = parseWorkflowDefinition(imported.definition);
      const created = await repository.createWorkflow(restored.name, restored);
      const reloaded = await repository.getWorkflowVersion(
        created.workflowId,
        created.version,
      );
      expect(reloaded?.definition).toEqual(restored);
      expect(
        reloaded?.definition.nodes.find((node) => node.id === "ai")?.inputs,
      ).toEqual(definition.nodes[1]?.inputs);
      expect(
        reloaded?.definition.nodes.find((node) => node.id === "reply")?.inputs,
      ).toEqual(definition.nodes[2]?.inputs);
    });

    it("persists a published workflow, execution trace and idempotent delivery", async () => {
      const suffix = randomUUID();
      const definition = parseWorkflowDefinition({
        schemaVersion: "1",
        name: `postgres-reply-${suffix}`,
        startNodeId: "reply",
        nodes: [
          {
            id: "reply",
            type: "reply",
            version: 1,
            config: {
              text: "Fictional database reply",
              retry: { maxAttempts: 1, initialDelayMs: 0 },
            },
            onSuccess: "done",
          },
          {
            id: "done",
            type: "end",
            version: 1,
            config: { result: "succeeded" },
          },
        ],
      });
      const version = await repository.createWorkflow(
        `Postgres ${suffix}`,
        definition,
      );
      const published = await repository.publishWorkflowVersion(
        version.workflowId,
        version.version,
      );
      expect(published?.status).toBe("published");

      const trigger = await repository.createTrigger({
        name: `Postgres trigger ${suffix}`,
        workflowId: version.workflowId,
        workflowVersion: version.version,
        conditions: parseTriggerConditions({
          chatIds: [`iMessage;-;fake-chat-${suffix}`],
          text: { kind: "prefix", value: "/db" },
        }),
        includeFromMe: false,
        enabled: true,
      });
      expect(trigger).not.toBeNull();

      const normalized = new BlueBubblesWebhookAdapter().normalize(
        newMessageWebhook({
          messageGuid: `fake-workflow-message-${suffix}`,
          chatGuid: `iMessage;-;fake-chat-${suffix}`,
          chatDisplayName: `Fictional chat ${suffix}`,
          text: "/db run",
        }),
        randomUUID(),
      );
      expect(normalized.kind).toBe("message");
      if (normalized.kind !== "message") {
        return;
      }
      await archive.ingestMessage(normalized.envelope, true);

      const gateway = new ConfirmingReplyGateway();
      const engine = new WorkflowEngine(
        repository,
        createDefaultNodeRegistry(repository, gateway),
      );
      const first = await engine.handleMessage(normalized.envelope);
      const duplicate = await engine.handleMessage(normalized.envelope);
      const detail = await repository.getExecution(first.executionIds[0] ?? "");

      expect(first.executionIds).toHaveLength(1);
      expect(duplicate.executionIds).toEqual(first.executionIds);
      expect(gateway.commands).toHaveLength(1);
      expect(detail).toMatchObject({
        status: "succeeded",
        nodes: [
          { nodeId: "reply", status: "succeeded" },
          { nodeId: "done", status: "succeeded" },
        ],
        deliveries: [{ status: "confirmed", attemptCount: 1 }],
      });
      const messageExecutions = await repository.listExecutionsForMessages([
        normalized.envelope.message.providerMessageId,
      ]);
      expect(messageExecutions).toHaveLength(1);
      expect(messageExecutions[0]?.providerMessageId).toBe(
        normalized.envelope.message.providerMessageId,
      );
      expect(messageExecutions[0]?.execution.id).toBe(first.executionIds[0]);
      const database = new Client({
        connectionString: connection,
      });
      await database.connect();
      try {
        await database.query(
          "UPDATE workflow_executions SET source_message_id = NULL WHERE id = $1",
          [first.executionIds[0]],
        );
        const recoveredLinks = await repository.listExecutionsForMessages([
          normalized.envelope.message.providerMessageId,
        ]);
        expect(recoveredLinks).toHaveLength(1);
        expect(recoveredLinks[0]).toMatchObject({
          providerMessageId: normalized.envelope.message.providerMessageId,
          execution: {
            id: first.executionIds[0],
            providerChatId: `iMessage;-;fake-chat-${suffix}`,
          },
        });
      } finally {
        await database.end();
      }
      await expect(
        repository.listExecutions({ limit: 100, cursor: null }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: first.executionIds[0],
            providerChatId: `iMessage;-;fake-chat-${suffix}`,
            chatDisplayName: `Fictional chat ${suffix}`,
            cachedPromptTokens: null,
            cacheEligiblePromptTokens: 0,
            cacheHitRate: null,
          }),
        ]),
      );

      // Fictional delivery: closing resolves attention without rewriting delivery history.
      const attentionDatabase = new Client({
        connectionString: connection,
      });
      await attentionDatabase.connect();
      try {
        const baseline = await repository.getRuntimeSummary(new Date());
        await attentionDatabase.query(
          "UPDATE outbound_deliveries SET status = 'unknown' WHERE execution_id = $1",
          [first.executionIds[0]],
        );
        await attentionDatabase.query(
          "UPDATE workflow_executions SET status = 'dead-lettered' WHERE id = $1",
          [first.executionIds[0]],
        );
        expect(
          (await repository.getRuntimeSummary(new Date())).outbound.unknown,
        ).toBe(baseline.outbound.unknown + 1);
        const pending = await repository.listExecutions({
          limit: 100,
          cursor: null,
          attention: "unknown-outbound",
        });
        expect(
          pending.filter((item) => item.id === first.executionIds[0]),
        ).toHaveLength(1);
        await repository.closeExecution(first.executionIds[0]!);
        expect(
          (await repository.getRuntimeSummary(new Date())).outbound.unknown,
        ).toBe(baseline.outbound.unknown);
        expect(
          await repository.listExecutions({
            limit: 100,
            cursor: null,
            attention: "unknown-outbound",
          }),
        ).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: first.executionIds[0] }),
          ]),
        );
        expect(
          (await repository.getExecution(first.executionIds[0]!))?.deliveries[0]
            ?.status,
        ).toBe("unknown");
      } finally {
        await attentionDatabase.end();
      }

      await expect(
        repository.setWorkflowEnabled(version.workflowId, false),
      ).resolves.toMatchObject({ status: "inactive", publishedVersion: 1 });
      await expect(repository.listActiveTriggerBindings()).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: trigger?.id })]),
      );
      await expect(
        repository.setWorkflowEnabled(version.workflowId, true),
      ).resolves.toMatchObject({ status: "active", publishedVersion: 1 });

      const secondVersion = await repository.createWorkflowVersion(
        version.workflowId,
        parseWorkflowDefinition({
          ...definition,
          name: `postgres-reply-v2-${suffix}`,
        }),
        `postgres-reply-v2-${suffix}`,
      );
      expect(secondVersion).toMatchObject({
        version: 2,
        workflowName: `postgres-reply-v2-${suffix}`,
        definition: { name: `postgres-reply-v2-${suffix}` },
      });
      await repository.publishWorkflowVersion(version.workflowId, 2);
      await expect(repository.listTriggers()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: trigger?.id,
            workflowVersion: 2,
            enabled: true,
          }),
        ]),
      );
    });

    it("creates a linked recovery execution from the locked message and version", async () => {
      const suffix = randomUUID();
      const definition = parseWorkflowDefinition({
        schemaVersion: "1",
        name: `postgres-recovery-${suffix}`,
        startNodeId: "unstable",
        nodes: [
          {
            id: "unstable",
            type: "log",
            version: 1,
            config: { message: "fictional" },
            onSuccess: "done",
          },
          {
            id: "done",
            type: "end",
            version: 1,
            config: { result: "succeeded" },
          },
        ],
      });
      const version = await repository.createWorkflow(
        `Postgres recovery ${suffix}`,
        definition,
      );
      await repository.publishWorkflowVersion(
        version.workflowId,
        version.version,
      );
      await repository.createTrigger({
        name: `Postgres recovery trigger ${suffix}`,
        workflowId: version.workflowId,
        workflowVersion: version.version,
        conditions: parseTriggerConditions({
          chatIds: [`iMessage;-;recovery-${suffix}`],
          text: { kind: "prefix", value: "/recover" },
        }),
        includeFromMe: false,
        enabled: true,
      });

      const normalized = new BlueBubblesWebhookAdapter().normalize(
        newMessageWebhook({
          messageGuid: `fake-recovery-message-${suffix}`,
          chatGuid: `iMessage;-;recovery-${suffix}`,
          text: "/recover now",
        }),
        randomUUID(),
      );
      expect(normalized.kind).toBe("message");
      if (normalized.kind !== "message") return;
      await archive.ingestMessage(normalized.envelope, true);

      let calls = 0;
      const unstableHandler: NodeHandler = {
        type: "log",
        version: 1,
        retryPolicy: () => ({ maxAttempts: 1, initialDelayMs: 0 }),
        failureTarget: () => null,
        execute: (_node, context) => {
          calls += 1;
          if (calls === 1) {
            throw new WorkflowExecutionError(
              "FICTIONAL_TRANSIENT_FAILURE",
              "The fictional operation failed temporarily.",
              true,
            );
          }
          return Promise.resolve({
            status: "succeeded",
            nextNodeId: "done",
            outputSummary: {
              replay:
                context.envelope.message !== null &&
                context.envelope.metadata.isReplay,
            },
          });
        },
      };
      const registry = new NodeRegistry();
      registry.register(unstableHandler);
      registry.register({
        type: "end",
        version: 1,
        retryPolicy: () => ({ maxAttempts: 1, initialDelayMs: 0 }),
        failureTarget: () => null,
        execute: () =>
          Promise.resolve({
            status: "succeeded",
            nextNodeId: null,
            completionStatus: "succeeded",
            outputSummary: { result: "succeeded" },
          }),
      });
      const engine = new WorkflowEngine(repository, registry);
      const first = await engine.handleMessage(normalized.envelope);
      const originalId = first.executionIds[0] ?? "";
      await expect(repository.getExecution(originalId)).resolves.toMatchObject({
        status: "dead-lettered",
      });

      await repository.markExecutionRetrying(
        originalId,
        "unstable",
        new Date(),
        "FICTIONAL_TRANSIENT_FAILURE",
      );
      await expect(
        engine.retryExecution(
          originalId,
          randomUUID(),
          new Date(Date.now() - 300_000),
        ),
      ).resolves.toEqual({
        status: "conflict",
        reason: "execution-retry-still-active",
      });
      await repository.markExecutionRetrying(
        originalId,
        "unstable",
        new Date(Date.now() - 600_000),
        "FICTIONAL_TRANSIENT_FAILURE",
      );

      const recovery = await engine.retryExecution(
        originalId,
        randomUUID(),
        new Date(Date.now() - 300_000),
      );
      expect(recovery).toMatchObject({
        status: "created",
        execution: {
          retryOfExecutionId: originalId,
          recoveryAttempt: 1,
        },
      });
      if (recovery.status !== "created") return;
      await expect(
        repository.getExecution(recovery.execution.id),
      ).resolves.toMatchObject({
        status: "succeeded",
        retryOfExecutionId: originalId,
        nodes: [
          { nodeId: "unstable", outputSummary: { replay: true } },
          { nodeId: "done", status: "succeeded" },
        ],
      });
      await expect(repository.getExecution(originalId)).resolves.toMatchObject({
        status: "failed",
        errorCode: "STALE_RETRY_RECOVERED",
        nextRetryAt: null,
      });
      await expect(
        engine.retryExecution(
          originalId,
          randomUUID(),
          new Date(Date.now() - 300_000),
        ),
      ).resolves.toEqual({
        status: "conflict",
        reason: "recovery-already-created",
      });
    });
  },
);
