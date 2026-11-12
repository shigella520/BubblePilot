import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { WorkflowStartupRecovery } from "../modules/workflow/startup-recovery.js";
import { PostgresWorkflowRepository } from "../modules/workflow/postgres-workflow-repository.js";

const url = process.env.TEST_DATABASE_URL;
describe.runIf(!!url)(
  "startup execution recovery in an isolated database",
  () => {
    const name = `bubblepilot_startup_${randomUUID().replaceAll("-", "")}_test`;
    let admin: Client,
      db: Client,
      connection: string,
      repository: PostgresWorkflowRepository;
    const guards: WorkflowStartupRecovery[] = [];
    let workflow: string, version: string, trigger: string, chat: string;
    beforeAll(async () => {
      admin = new Client({ connectionString: url });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}"`);
      const address = new URL(url!);
      address.pathname = `/${name}`;
      connection = address.toString();
      db = new Client({ connectionString: connection });
      await db.connect();
      for (const file of (
        await readdir(new URL("../migrations/", import.meta.url))
      )
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await db.query(
          await readFile(
            new URL(`../migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
      repository = new PostgresWorkflowRepository(connection);
      workflow = randomUUID();
      version = randomUUID();
      trigger = randomUUID();
      chat = randomUUID();
      await db.query(
        "INSERT INTO chats(id,provider,provider_chat_id,type,enabled) VALUES($1,'bluebubbles','fictional-startup','group',true)",
        [chat],
      );
      await db.query(
        "INSERT INTO workflows(id,name,status) VALUES($1,'fictional startup','draft')",
        [workflow],
      );
      await db.query(
        "INSERT INTO workflow_versions(id,workflow_id,version,status,definition) VALUES($1,$2,1,'validated',$3)",
        [
          version,
          workflow,
          JSON.stringify({
            nodes: [
              { type: "message-trigger", config: { idle: { enabled: true } } },
            ],
          }),
        ],
      );
      await db.query(
        "INSERT INTO bot_triggers(id,name,workflow_version_id,conditions) VALUES($1,'fictional',$2,'{}')",
        [trigger, version],
      );
    }, 30000);
    afterEach(async () => {
      await Promise.all(guards.splice(0).map((g) => g.close()));
      await db.query("TRUNCATE workflow_executions CASCADE");
      await db.query("TRUNCATE scheduled_tasks CASCADE");
      await db.query("TRUNCATE audit_events");
    });
    afterAll(async () => {
      await repository?.close();
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    });
    function guard(onLost = vi.fn()) {
      const g = new WorkflowStartupRecovery(connection, 5000, onLost);
      guards.push(g);
      return g;
    }
    async function execution(status = "running", event: unknown = null) {
      const id = randomUUID();
      await db.query(
        "INSERT INTO workflow_executions(id,provider,external_event_id,trigger_id,workflow_version_id,correlation_id,status,trigger_event,started_at,current_node_id,next_retry_at) VALUES($1::uuid,'bluebubbles',$1::text,$2,$3,$1::uuid,$4,$5,now()-interval '85 days','ai',now())",
        [id, trigger, version, status, JSON.stringify(event)],
      );
      return id;
    }
    async function delivery(executionId: string, status: string) {
      const id = randomUUID();
      await db.query(
        "INSERT INTO outbound_deliveries(id,execution_id,node_id,idempotency_key,provider,provider_chat_id,body_hash,provider_temp_guid,status,error_code) VALUES($1::uuid,$2,'reply',$1::text,'bluebubbles','fictional-startup','fixture',$1::uuid,$3,'ORIGINAL_ERROR')",
        [id, executionId, status],
      );
      return id;
    }
    it("closes batches once, preserves evidence and terminal history, fences late writes and keeps unknown sends visible", async () => {
      const running = await execution(),
        created = await execution("created"),
        retrying = await execution("retrying");
      const terminals: string[] = [];
      for (const status of [
        "failed",
        "dead-lettered",
        "succeeded",
        "skipped",
        "closed",
      ])
        terminals.push(await execution(status));
      const node = randomUUID();
      await db.query(
        "INSERT INTO node_executions(id,execution_id,node_id,node_type,node_version,attempt,status,started_at,output_summary,error_code) VALUES($1,$2,'ai','ai-chat',1,1,'running',now()-interval '85 days','{\"fixture\":true}','ORIGINAL_ERROR')",
        [node, running],
      );
      const sending = await delivery(running, "sending"),
        unknown = await delivery(created, "unknown"),
        confirmed = await delivery(retrying, "confirmed"),
        pending = await delivery(retrying, "pending");
      const before = (
        await db.query(
          "SELECT * FROM outbound_deliveries WHERE id=ANY($1::uuid[]) ORDER BY id",
          [[unknown, confirmed]],
        )
      ).rows;
      const first = guard();
      expect(await first.start(1)).toMatchObject({
        scanned: 3,
        closed: 3,
        deferred: 0,
        interruptedNodes: 1,
        unknownDeliveries: 2,
      });
      for (const id of [running, created, retrying]) {
        expect(await repository.getExecution(id)).toMatchObject({
          status: "closed",
          currentNodeId: null,
          nextRetryAt: null,
          startupClosure: { reasonCode: "WORKFLOW_PROCESS_INTERRUPTED" },
        });
      }
      expect(
        (
          await db.query(
            "SELECT status,duration_ms,error_code,output_summary FROM node_executions WHERE id=$1",
            [node],
          )
        ).rows[0],
      ).toEqual({
        status: "failed",
        duration_ms: 2147483647,
        error_code: "ORIGINAL_ERROR",
        output_summary: { fixture: true },
      });
      expect(
        (
          await db.query(
            "SELECT * FROM outbound_deliveries WHERE id=ANY($1::uuid[]) ORDER BY id",
            [[unknown, confirmed]],
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await db.query(
            "SELECT status,retryable,error_code FROM outbound_deliveries WHERE id=$1",
            [sending],
          )
        ).rows[0],
      ).toEqual({
        status: "unknown",
        retryable: false,
        error_code: "ORIGINAL_ERROR",
      });
      expect(
        (
          await repository.listExecutions({
            limit: 20,
            cursor: null,
            attention: "unknown-outbound",
          })
        )
          .map((e) => e.id)
          .sort(),
      ).toEqual([running, created].sort());
      expect(await repository.getRuntimeSummary(new Date())).toMatchObject({
        outbound: { unknown: 2, sending: 0 },
      });
      await expect(
        repository.markExecutionRunning(running, "ai"),
      ).rejects.toThrow("WORKFLOW_EXECUTION_CLOSED");
      await expect(repository.markDeliverySending(pending)).rejects.toThrow(
        "OUTBOUND_DELIVERY_NOT_SENDABLE",
      );
      await expect(
        repository.startNodeExecution({
          executionId: running,
          node: {
            id: "late",
            type: "end",
            version: 1,
            config: { result: "succeeded" },
          },
          attempt: 1,
          inputSummary: {},
        }),
      ).rejects.toThrow("WORKFLOW_EXECUTION_CLOSED");
      await repository.finishExecution(running, "succeeded");
      await repository.markExecutionRetrying(
        running,
        "ai",
        new Date(),
        "LATE_ERROR",
      );
      await repository.finishNodeExecution({
        nodeExecutionId: node,
        status: "succeeded",
        outputSummary: { late: true },
      });
      expect((await repository.getExecution(running))?.status).toBe("closed");
      expect(
        (
          await db.query(
            "SELECT error_code,output_summary FROM node_executions WHERE id=$1",
            [node],
          )
        ).rows[0],
      ).toEqual({
        error_code: "ORIGINAL_ERROR",
        output_summary: { fixture: true },
      });
      expect(
        (
          await db.query<{ count: string }>(
            "SELECT count(*) FROM workflow_executions WHERE id=ANY($1::uuid[]) AND startup_closure IS NOT NULL",
            [terminals],
          )
        ).rows[0]!.count,
      ).toBe("0");
      await first.close();
      expect(await guard().start(1)).toMatchObject({ closed: 0, scanned: 0 });
      expect(
        (
          await db.query<{ count: string }>(
            "SELECT count(*) FROM audit_events WHERE action='execution.startup-close'",
          )
        ).rows[0]!.count,
      ).toBe("3");
    });
    it("retains scheduler ownership and future/recurring definitions, closes orphaned or exhausted background runs", async () => {
      const idle = await execution("running", {
        schemaVersion: "chat-idle-v1",
      });
      const exhausted = await execution("retrying", {
        schemaVersion: "chat-idle-v1",
      });
      await db.query(
        "UPDATE workflow_executions SET recovery_attempt=3 WHERE id=$1",
        [exhausted],
      );
      for (const [i, id] of [idle, exhausted].entries())
        await db.query(
          "INSERT INTO idle_attempts(id,chat_id,generation,trigger_id,workflow_version_id,execution_id,trigger_updated_at,state) VALUES($1,$2,$3,$4,$5,$1,now(),'reserved')",
          [id, chat, i + 1, trigger, version],
        );
      const scheduled = await execution("running", {
        schemaVersion: "scheduled-task-v2",
      });
      const orphan = await execution("running", {
        schemaVersion: "scheduled-task-v1",
      });
      const task = randomUUID(),
        occurrence = randomUUID();
      await db.query(
        'INSERT INTO scheduled_tasks(id,chat_id,workflow_id,creator_sender_id,scheduled_at,expires_at,timezone,creation_key,schedule) VALUES($1::uuid,$2,$3,\'fictional\',now()+interval \'1 day\',now()+interval \'2 days\',\'UTC\',$1::text,\'{"kind":"recurring","startsAt":"2030-06-01T09:00:00Z","rule":{"type":"daily","localTime":"09:00"},"end":{"kind":"count","count":12}}\')',
        [task, chat, workflow],
      );
      await db.query(
        "INSERT INTO scheduled_task_occurrences(id,task_id,occurrence_number,task_version,scheduled_at,expires_at,status) VALUES($1,$2,1,1,now(),now()+interval '1 day','running')",
        [occurrence, task],
      );
      await db.query(
        "INSERT INTO scheduled_task_runs(id,task_id,task_version,execution_id,workflow_version_id,history_boundary,lease_owner,lease_expires_at,occurrence_id) VALUES($1,$2,1,$3,$4,0,$1,now()-interval '1 minute',$1)",
        [occurrence, task, scheduled, version],
      );
      const before = (await db.query("SELECT * FROM scheduled_tasks")).rows;
      expect(await guard().start(1)).toMatchObject({
        scanned: 4,
        deferred: 2,
        closed: 2,
      });
      expect((await repository.getExecution(idle))?.status).toBe("running");
      expect((await repository.getExecution(scheduled))?.status).toBe(
        "running",
      );
      expect((await repository.getExecution(orphan))?.status).toBe("closed");
      expect(
        (
          await db.query<{ state: string }>(
            "SELECT state FROM idle_attempts WHERE execution_id=$1",
            [exhausted],
          )
        ).rows[0]!.state,
      ).toBe("released");
      expect((await db.query("SELECT * FROM scheduled_tasks")).rows).toEqual(
        before,
      );
    });
    it("holds ownership after scanning, rejects a competing runtime and detects a lost connection", async () => {
      const lost = vi.fn(),
        first = guard(lost);
      await first.start();
      const contender = guard();
      await expect(contender.start()).rejects.toThrow(
        "WORKFLOW_RUNTIME_ALREADY_ACTIVE",
      );
      const result = await db.query(
        "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid()",
      );
      expect(result.rowCount).toBe(1);
      await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
      await first.close();
      await expect(guard().start()).resolves.toMatchObject({ closed: 0 });
    });
    it("rolls back a failed batch and releases ownership for a safe retry", async () => {
      const id = await execution();
      await db.query(
        "CREATE FUNCTION reject_startup_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$; CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_startup_audit()",
      );
      try {
        await expect(guard().start()).rejects.toThrow("fixture audit failure");
        expect((await repository.getExecution(id))?.status).toBe("running");
      } finally {
        await db.query(
          "DROP TRIGGER fixture_audit_failure ON audit_events; DROP FUNCTION reject_startup_audit()",
        );
      }
      expect(await guard().start()).toMatchObject({ closed: 1 });
    });
  },
);
