import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
const url = process.env.TEST_DATABASE_URL;
describe.runIf(!!url)("chat summary retirement migration", () => {
  it("migrates existing settings, erases only chat summaries and preserves archived derivatives", async () => {
    const databaseName = `bubblepilot_retirement_${randomUUID().replaceAll("-", "")}_test`;
    const admin = new Client({ connectionString: url });
    await admin.connect();
    const connection = new URL(url!);
    connection.pathname = `/${databaseName}`;
    let db: Client | undefined;
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      db = new Client({ connectionString: connection.toString() });
      await db.connect();
      const files = (await readdir(new URL("../migrations/", import.meta.url)))
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const file of files.filter((f) => f < "0052"))
        await db.query(
          await readFile(
            new URL(`../migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
      const chat = randomUUID(),
        event = randomUUID(),
        message = randomUUID(),
        state = randomUUID(),
        operation = randomUUID(),
        workflow = randomUUID(),
        version = randomUUID(),
        trigger = randomUUID(),
        execution = randomUUID();
      await db.query(
        `INSERT INTO chats(id,provider,provider_chat_id,type,enabled) VALUES($1,'bluebubbles','fictional-migration','group',TRUE)`,
        [chat],
      );
      await db.query(
        `INSERT INTO inbound_events(id,provider,external_event_id,correlation_id,event_type,status,payload_hash) VALUES($1,'bluebubbles','fictional-event',$1,'new-message','completed','fixture')`,
        [event],
      );
      await db.query(
        `INSERT INTO messages(id,provider,provider_message_id,chat_id,sent_at,body,content_type,is_from_me,content_hash,source_event_id,message_index) VALUES($1,'bluebubbles','fictional-message',$2,now(),'fictional archive','text',FALSE,'fixture',$3,1)`,
        [message, chat, event],
      );
      await db.query(
        `INSERT INTO message_image_summaries(id,message_id,source_type,source_key,attachment_ref,summary,status) VALUES($1,$2,'attachment','fixture','image-ref','fictional image summary','succeeded')`,
        [randomUUID(), message],
      );
      await db.query(
        `INSERT INTO memory_generations(id,config,identity,status) VALUES($1,'{}','fictional-embedding','active')`,
        [randomUUID()],
      );
      await db.query(
        `INSERT INTO conversation_summary_settings(id,enabled,include_from_me,base_message_window,redundancy_message_window,character_limit,version) VALUES(1,FALSE,FALSE,7,4,9000,8)`,
      );
      await db.query(
        `INSERT INTO conversation_context_states(id,chat_id,summary,covered_through_index) VALUES($1,$2,'obsolete fictional chat summary',1)`,
        [state, chat],
      );
      await db.query(
        `INSERT INTO conversation_context_compressions(id,context_state_id,base_version,from_index,through_index,status,lease_expires_at) VALUES($1,$2,1,1,1,'queued',now())`,
        [operation, state],
      );
      await db.query(
        `INSERT INTO conversation_context_summary_revisions(context_state_id,version,summary,covered_through_index) VALUES($1,1,'obsolete revision',1) ON CONFLICT DO NOTHING`,
        [state],
      );
      await db.query(
        `INSERT INTO workflows(id,name,status) VALUES($1,'fictional','draft')`,
        [workflow],
      );
      await db.query(
        `INSERT INTO workflow_versions(id,workflow_id,version,status,definition) VALUES($1,$2,1,'validated','{}')`,
        [version, workflow],
      );
      await db.query(
        `INSERT INTO bot_triggers(id,name,workflow_version_id,conditions) VALUES($1,'fictional',$2,'{}')`,
        [trigger, version],
      );
      const snapshot = {
        summary: "obsolete snapshot",
        summaryVersion: 1,
        summaryCoveredThroughIndex: "1",
        historyCoverage: {
          summaryCoveredThroughIndex: "1",
          retained: null,
          omitted: null,
        },
        imageSummaries: [{ summary: "keep image" }],
        linkPreview: { summary: "keep link" },
      };
      await db.query(
        `INSERT INTO workflow_executions(id,provider,external_event_id,trigger_id,workflow_version_id,correlation_id,status,context_snapshot) VALUES($1,'bluebubbles','fictional-execution',$2,$3,$1,'created',$4)`,
        [execution, trigger, version, JSON.stringify(snapshot)],
      );
      await db.query(
        `INSERT INTO node_executions(id,execution_id,node_id,node_type,node_version,attempt,status,output_summary) VALUES($1,$2,'history','load-context',1,1,'succeeded',$3)`,
        [randomUUID(), execution, JSON.stringify(snapshot)],
      );
      await db.query("BEGIN");
      await db.query(
        await readFile(
          new URL("../migrations/0052_raw_chat_context.sql", import.meta.url),
          "utf8",
        ),
      );
      await db.query("COMMIT");
      expect(
        (
          await db.query<{
            base_message_window: number;
            redundancy_message_window: number;
            character_limit: number;
            include_from_me: boolean;
            version: number;
          }>("SELECT * FROM conversation_context_settings")
        ).rows[0],
      ).toMatchObject({
        base_message_window: 7,
        redundancy_message_window: 4,
        character_limit: 9000,
        include_from_me: false,
        version: 8,
      });
      const after = (
        await db.query<{ context_snapshot: Record<string, unknown> }>(
          "SELECT context_snapshot FROM workflow_executions WHERE id=$1",
          [execution],
        )
      ).rows[0]!.context_snapshot;
      expect(after.summary).toBeUndefined();
      expect(after.summaryVersion).toBeUndefined();
      expect(after.imageSummaries).toEqual(snapshot.imageSummaries);
      expect(after.linkPreview).toEqual(snapshot.linkPreview);
      expect(after.historyCoverage).toEqual({ retained: null, omitted: null });
      expect(
        (
          await db.query<{ body: string }>(
            "SELECT body FROM messages WHERE id=$1",
            [message],
          )
        ).rows[0]?.body,
      ).toBe("fictional archive");
      expect(
        (
          await db.query<{ summary: string }>(
            "SELECT summary FROM message_image_summaries",
          )
        ).rows[0]?.summary,
      ).toBe("fictional image summary");
      expect(
        (
          await db.query<{ status: string }>(
            "SELECT status FROM memory_generations",
          )
        ).rows[0]?.status,
      ).toBe("active");
      expect(
        (
          await db.query<{ name: string | null }>(
            "SELECT to_regclass('conversation_context_states') AS name",
          )
        ).rows[0]?.name,
      ).toBeNull();
      // Rewritten identity triggers continue working after summary tables disappear.
      await db.query(
        "UPDATE chats SET bot_identity_revision=bot_identity_revision+1 WHERE id=$1",
        [chat],
      );
    } finally {
      await db?.end();
      await admin.query(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      );
      await admin.end();
    }
  }, 30000);
});
