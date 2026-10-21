import { it, expect } from "vitest";
import { unpackZip } from "../modules/plugins/plugin-storage.js";
import { pluginZip } from "./support/plugin-zip.js";
it("unpacks stored ZIP text without executing files", async () => {
  expect(
    await unpackZip(
      pluginZip({ "plugin.json": "{}", "skills/demo/SKILL.md": "hello" }),
    ),
  ).toEqual({ "plugin.json": "{}", "skills/demo/SKILL.md": "hello" });
});
it.each(["../outside", "/absolute", "x\\y"])(
  "rejects ZIP traversal %s",
  async (path) => {
    await expect(unpackZip(pluginZip({ [path]: "bad" }))).rejects.toThrow();
  },
);
it("rejects symlinks, broken ZIP, and invalid UTF8", async () => {
  await expect(
    unpackZip(pluginZip({ link: "outside" }, 0o120777)),
  ).rejects.toThrow();
  await expect(unpackZip(Buffer.from("not zip"))).rejects.toThrow();
});
