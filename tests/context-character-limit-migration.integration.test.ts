import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.runIf(!!url)("context character limit migration", () => {
  it("preserves the existing configuration and snapshots while expanding the constraint", async () => {
    const name = `context_limit_${randomUUID().replaceAll("-", "")}_test`;
    const admin = new Client({ connectionString: url });
    await admin.connect();
    let db: Client | undefined;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      const connection = new URL(url!);
      connection.pathname = `/${name}`;
      db = new Client({ connectionString: connection.toString() });
      await db.connect();
      const dir = new URL("../migrations/", import.meta.url);
      for (const file of (await readdir(dir))
        .filter((f) => f.endsWith(".sql") && f < "0078")
        .sort())
        await db.query(await readFile(new URL(file, dir), "utf8"));
      await db.query(
        "INSERT INTO conversation_context_settings(id,base_message_window,redundancy_message_window,character_limit,version) VALUES(1,40,40,20000,7)",
      );
      const chat = randomUUID();
      await db.query(
        "INSERT INTO chats(id,provider,provider_chat_id,type,enabled) VALUES($1,'bluebubbles','fictional-limit-chat','group',true)",
        [chat],
      );
      await db.query(
        "INSERT INTO conversation_context_windows(chat_id,trigger_message_index,snapshot) VALUES($1,1,$2)",
        [chat, JSON.stringify({ settings: { characterLimit: 20_000 } })],
      );
      const before = (
        await db.query("SELECT * FROM conversation_context_settings")
      ).rows;
      await expect(
        db.query(
          "UPDATE conversation_context_settings SET character_limit=40000",
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await db.query(
        await readFile(
          new URL("0078_context_character_limit.sql", dir),
          "utf8",
        ),
      );
      expect(
        (await db.query("SELECT * FROM conversation_context_settings")).rows,
      ).toEqual(before);
      expect(
        (
          await db.query<{ snapshot: unknown }>(
            "SELECT snapshot FROM conversation_context_windows",
          )
        ).rows[0]?.snapshot,
      ).toEqual({ settings: { characterLimit: 20_000 } });
      await db.query(
        "UPDATE conversation_context_settings SET character_limit=60000",
      );
      await expect(
        db.query(
          "UPDATE conversation_context_settings SET character_limit=60001",
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.query("UPDATE conversation_context_settings SET character_limit=99"),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await db?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    }
  }, 30_000);
});
