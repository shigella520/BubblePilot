import { randomUUID } from "node:crypto";

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

    beforeAll(() => {
      repository = new PostgresWorkflowRepository(testDatabaseUrl ?? "");
      archive = new PostgresArchiveRepository(testDatabaseUrl ?? "");
    });

    afterAll(async () => {
      await Promise.all([repository.close(), archive.close()]);
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
            outputSummary: { replay: context.envelope.metadata.isReplay },
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
