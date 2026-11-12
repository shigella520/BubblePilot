import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
const url = process.env.TEST_DATABASE_URL;
describe.runIf(!!url)("recurring task migration", () => {
  it("preserves v1 execution identities and backfills pending, running and terminal single tasks", async () => {
    const databaseName = `bubblepilot_recurring_${randomUUID().replaceAll("-", "")}_test`;
    const admin = new Client({ connectionString: url });
    await admin.connect();
    const connection = new URL(url!);
    connection.pathname = `/${databaseName}`;
    let db: Client | undefined;
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      db = new Client({ connectionString: connection.toString() });
      await db.connect();
      for (const f of (
        await readdir(new URL("../migrations/", import.meta.url))
      )
        .filter((f) => f.endsWith(".sql") && f < "0063")
        .sort())
        await db.query(
          await readFile(
            new URL(`../migrations/${f}`, import.meta.url),
            "utf8",
          ),
        );
      const chat = randomUUID(),
        workflow = randomUUID(),
        version = randomUUID(),
        trigger = randomUUID(),
        execution = randomUUID(),
        run = randomUUID();
      await db.query(
        "INSERT INTO chats(id,provider,provider_chat_id,type,enabled) VALUES($1,'bluebubbles','fictional-recurring-migration','group',true)",
        [chat],
      );
      await db.query(
        "INSERT INTO workflows(id,name,status) VALUES($1,'fixture','draft')",
        [workflow],
      );
      await db.query(
        "INSERT INTO workflow_versions(id,workflow_id,version,status,definition) VALUES($1,$2,1,'validated','{}')",
        [version, workflow],
      );
      await db.query(
        "INSERT INTO bot_triggers(id,name,workflow_version_id,conditions) VALUES($1,'fixture',$2,'{}')",
        [trigger, version],
      );
      const tasks = [randomUUID(), randomUUID(), randomUUID()];
      for (const [i, status] of ["pending", "running", "sent"].entries())
        await db.query(
          "INSERT INTO scheduled_tasks(id,chat_id,workflow_id,creator_sender_id,scheduled_at,expires_at,timezone,status,creation_key,content) VALUES($1,$2,$3,'fictional-member',now()+interval '1 hour',now()+interval '2 hours','UTC',$4,$5,'fixture reminder')",
          [tasks[i], chat, workflow, status, tasks[i]],
        );
      const event = {
        schemaVersion: "scheduled-task-v1",
        eventId: `scheduled:${tasks[1]}:1`,
        message: null,
        scheduled: {
          taskId: tasks[1],
          taskVersion: 1,
          content: "fixture reminder",
        },
      };
      await db.query(
        "INSERT INTO workflow_executions(id,provider,external_event_id,trigger_id,workflow_version_id,correlation_id,status,trigger_event) VALUES($1,'bluebubbles',$2,$3,$4,$1,'running',$5)",
        [execution, event.eventId, trigger, version, JSON.stringify(event)],
      );
      await db.query(
        "INSERT INTO scheduled_task_runs(id,task_id,task_version,execution_id,workflow_version_id,task_snapshot,history_boundary,lease_owner,lease_expires_at) VALUES($1,$2,1,$3,$4,'{}',0,$1,now()-interval '1 minute')",
        [run, tasks[1], execution, version],
      );
      await db.query("BEGIN");
      await db.query(
        await readFile(
          new URL("../migrations/0063_recurring_tasks.sql", import.meta.url),
          "utf8",
        ),
      );
      await db.query("COMMIT");
      expect(
        (
          await db.query(
            "SELECT id,external_event_id,trigger_event FROM workflow_executions WHERE id=$1",
            [execution],
          )
        ).rows[0],
      ).toEqual({
        id: execution,
        external_event_id: event.eventId,
        trigger_event: event,
      });
      expect(
        (
          await db.query(
            "SELECT occurrence_id,execution_id FROM scheduled_task_runs WHERE id=$1",
            [run],
          )
        ).rows[0],
      ).toEqual({ occurrence_id: run, execution_id: execution });
      const rows = (
        await db.query<{
          id: string;
          schedule: unknown;
          lifecycle: string;
          consumed_count: number;
          status: string;
        }>(
          "SELECT t.id,t.schedule,t.lifecycle,t.consumed_count,o.status FROM scheduled_tasks t JOIN scheduled_task_occurrences o ON o.task_id=t.id",
        )
      ).rows;
      expect(rows).toHaveLength(3);
      expect(rows.find((r) => r.id === tasks[0])).toMatchObject({
        schedule: { kind: "once" },
        lifecycle: "active",
        consumed_count: 0,
        status: "pending",
      });
      expect(rows.find((r) => r.id === tasks[1])).toMatchObject({
        lifecycle: "active",
        consumed_count: 1,
        status: "running",
      });
      expect(rows.find((r) => r.id === tasks[2])).toMatchObject({
        lifecycle: "completed",
        consumed_count: 1,
        status: "sent",
      });
      await db.query("UPDATE scheduled_tasks SET version=5 WHERE id=$1", [
        tasks[0],
      ]);
      const occurrencesBefore = (
        await db.query("SELECT * FROM scheduled_task_occurrences ORDER BY id")
      ).rows;
      const runsBefore = (
        await db.query("SELECT * FROM scheduled_task_runs ORDER BY id")
      ).rows;
      await db.query(
        await readFile(
          new URL(
            "../migrations/0067_scheduled_task_summary.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const migrated: unknown = (
        await db.query(
          "SELECT summary,version,execution_version,content FROM scheduled_tasks WHERE id=$1",
          [tasks[0]],
        )
      ).rows[0];
      expect(migrated).toEqual({
        summary: null,
        version: 5,
        execution_version: 5,
        content: "fixture reminder",
      });
      expect(
        (await db.query("SELECT * FROM scheduled_task_occurrences ORDER BY id"))
          .rows,
      ).toEqual(occurrencesBefore);
      expect(
        (await db.query("SELECT * FROM scheduled_task_runs ORDER BY id")).rows,
      ).toEqual(runsBefore);
    } finally {
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  }, 30000);
});
