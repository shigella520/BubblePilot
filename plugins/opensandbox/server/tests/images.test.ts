import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { imageCommand, imageHelper, imageReply } from "../src/images.js";

it("rejects traversal, links and non-files before decoding without interpolating commands", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-image-"));
  mkdirSync(join(root, "workspace"));
  writeFileSync(join(root, "outside"), "fictional");
  symlinkSync(join(root, "outside"), join(root, "workspace", "link"));
  symlinkSync(root, join(root, "workspace", "directory"));
  try {
    const source = imageHelper.replace(
      "os.open('/workspace',",
      `os.open(${JSON.stringify(join(root, "workspace"))},`,
    );
    for (const path of [
      "/workspace/../outside",
      "/workspace/link",
      "/workspace/directory/outside",
      "/workspace/directory",
      "/workspace/",
      "/etc/passwd",
    ]) {
      const output = spawnSync(
        "python3",
        [
          "-I",
          "-S",
          "-c",
          source,
          Buffer.from(JSON.stringify({ path })).toString("base64"),
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(output.status).toBe(0);
      expect((JSON.parse(output.stdout) as { status: string }).status).not.toBe(
        "viewed",
      );
      expect(output.stdout).not.toContain("fictional");
    }
    expect(imageCommand("/workspace/$(touch /tmp/evil)'\".png")).not.toContain(
      "touch /tmp/evil",
    );
    expect(imageCommand("/workspace/x.png")).toContain("python3 -I -c");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("returns native MCP images without duplicating base64 in structured content", () => {
  const data = Buffer.from("fictional-image-bytes").toString("base64");
  const value = {
    status: "viewed",
    data,
    mimeType: "image/png",
    width: 1,
    height: 1,
    sourceWidth: 1,
    sourceHeight: 1,
    sourceBytes: 21,
    bytes: Buffer.from(data, "base64").length,
    transformed: true,
    firstFrameOnly: false,
    whiteBackground: false,
  };
  const result = imageReply(JSON.stringify(value));
  expect(result.isError).toBe(false);
  expect(result.content[1]).toEqual({
    type: "image",
    data,
    mimeType: "image/png",
  });
  expect(JSON.stringify(result.structuredContent)).not.toContain(data);
  expect(() => imageReply(JSON.stringify({ ...value, bytes: 1 }))).toThrow();
  expect(
    imageReply(JSON.stringify({ status: "preview_too_large" })).isError,
  ).toBe(true);
  expect(imageReply(JSON.stringify({ status: "/secret/path" }))).toMatchObject({
    structuredContent: { status: "invalid_image_result" },
  });
});
