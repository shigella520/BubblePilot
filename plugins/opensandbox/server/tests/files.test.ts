import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { fileHelper, fileCommand } from "../src/files.js";
it("uses descriptor-relative nofollow paths and bounded UTF-8 reads", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-files-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const invoke = (value: object) => {
    // Only relocate the hard-coded sandbox root for the local fixture.
    const source = fileHelper.replace(
      "os.open('/workspace',",
      `os.open(${JSON.stringify(workspace)},`,
    );
    const output = spawnSync(
      "python3",
      [
        "-I",
        "-S",
        "-c",
        source,
        Buffer.from(JSON.stringify(value)).toString("base64"),
      ],
      { encoding: "utf8" },
    );
    if (output.error) throw output.error;
    return {
      code: output.status,
      value: output.stdout ? (JSON.parse(output.stdout) as unknown) : null,
    };
  };
  try {
    expect(
      invoke({ op: "write", path: "/workspace/example", text: "猫猫abc" }).code,
    ).toBe(0);
    expect(
      invoke({ op: "read", path: "/workspace/example", offset: 0, length: 4 })
        .value,
    ).toEqual({ status: "read", text: "猫", nextOffset: 3, eof: false });
    expect(
      invoke({ op: "read", path: "/workspace/example", offset: 3, length: 64 })
        .value,
    ).toMatchObject({ text: "猫abc", eof: true });
    writeFileSync(join(root, "outside"), "private fixture");
    symlinkSync(join(root, "outside"), join(workspace, "link"));
    symlinkSync(root, join(workspace, "directory"));
    for (const path of [
      "/workspace/link",
      "/workspace/directory/outside",
      "/workspace/../outside",
    ])
      expect(invoke({ op: "read", path, offset: 0, length: 64 }).code).not.toBe(
        0,
      );
    expect(
      invoke({ op: "write", path: "/workspace/link", text: "changed" }).code,
    ).not.toBe(0);
    writeFileSync(join(workspace, "binary"), Buffer.from([255]));
    expect(
      invoke({ op: "read", path: "/workspace/binary", offset: 0, length: 64 })
        .code,
    ).not.toBe(0);
    expect(
      invoke({
        op: "write",
        path: "/workspace/large",
        text: "猫".repeat(30000),
      }).code,
    ).not.toBe(0);
    expect(
      fileCommand({
        op: "write",
        path: "/workspace/x",
        text: "$(touch /tmp/evil)'",
      }),
    ).not.toContain("touch /tmp/evil");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
