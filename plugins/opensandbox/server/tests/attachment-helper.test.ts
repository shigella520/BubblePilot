import { it, expect } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { attachmentHelper } from "../src/attachment-helper.js";
async function port() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const a = s.address();
  if (!a || typeof a === "string") throw new Error("address");
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return a.port;
}
async function receiver(
  root: string,
  data: Buffer,
  change: Record<string, unknown> = {},
) {
  const socket = await port();
  const input = {
    id: "fictional",
    filename: "销售.csv",
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    token: "fictional-transfer-token",
    port: socket,
    limits: { files: 3, totalMiB: 20, expandedMiB: 1, expandedFiles: 2 },
    ...change,
  };
  const process = spawn(
    "python3",
    [
      "-I",
      "-S",
      "-u",
      "-c",
      attachmentHelper.replace(
        "os.open('/workspace',",
        `os.open(${JSON.stringify(root)},`,
      ),
      Buffer.from(JSON.stringify(input)).toString("base64"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let logs = "";
  process.stderr.on("data", (d: Buffer) => process.stdout.emit("data", d));
  const exited = once(process, "exit");
  await new Promise<void>((resolve, reject) => {
    process.stdout.on("data", (d: Buffer) => {
      logs += d.toString();
      if (logs.includes("ATTACHMENT_READY")) resolve();
    });
    process.once("error", reject);
    process.once("exit", () => reject(new Error("helper_not_ready:" + logs)));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${socket}`, {
      method: "POST",
      headers: {
        "X-Transfer-Token": input.token,
        "Content-Length": String(data.length),
      },
      body: new Uint8Array(data),
    });
    const text = await response.text();
    await exited;
    return { status: response.status, text };
  } finally {
    process.kill();
  }
}
it("streams Chinese file bytes and hashes into an exclusive directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "bp-helper-"));
  try {
    const data = Buffer.from("地区,金额\n东区,17\n西区,20\n");
    const result = await receiver(root, data);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toMatchObject({
      status: "imported",
      size: data.length,
    });
    expect(
      await readFile(join(root, "attachments/fictional/销售.csv")),
    ).toEqual(data);
    await expect(receiver(root, data)).rejects.toThrow("helper_not_ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects symlink parents and hash mismatches without changing their target", async () => {
  const root = await mkdtemp(join(tmpdir(), "bp-helper-"));
  try {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "safe"), "unchanged");
    await symlink(outside, join(root, "attachments"));
    await expect(receiver(root, Buffer.from("x"))).rejects.toThrow(
      "helper_not_ready",
    );
    expect(await readFile(join(outside, "safe"), "utf8")).toBe("unchanged");
    await rm(join(root, "attachments"));
    expect(
      (await receiver(root, Buffer.from("x"), { sha256: "0".repeat(64) }))
        .status,
    ).toBe(422);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("extracts bounded archives and rejects traversal, symlinks and expansion bombs", async () => {
  const zip = (entries: Array<[string, string]>, symlinkEntry = false) =>
    execFileSync("python3", [
      "-c",
      "import io,zipfile,json,sys; b=io.BytesIO(); z=zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED); entries=json.loads(sys.argv[1]);\nfor name,text in entries:\n i=zipfile.ZipInfo(name); i.external_attr=(0o120777 if sys.argv[2]=='yes' else 0o100600)<<16; i.compress_type=zipfile.ZIP_DEFLATED; z.writestr(i,('x'*2097152 if text=='EXPANSION_FIXTURE' else text))\nz.close(); sys.stdout.buffer.write(b.getvalue())",
      JSON.stringify(entries),
      symlinkEntry ? "yes" : "no",
    ]);
  for (const [label, data, expected] of [
    ["valid", zip([["a/b.txt", "fictional"]]), 200],
    ["traversal", zip([["../outside.txt", "bad"]]), 422],
    ["symlink", zip([["link", "/tmp/outside"]], true), 422],
    ["bomb", zip([["large.txt", "EXPANSION_FIXTURE"]]), 422],
    [
      "count",
      zip([
        ["a", "1"],
        ["b", "2"],
        ["c", "3"],
      ]),
      422,
    ],
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), "bp-archive-"));
    try {
      const result = await receiver(root, data, { filename: "archive.zip" });
      expect(result.status, label).toBe(expected);
      if (expected === 200)
        expect(
          await readFile(
            join(root, "attachments/fictional/expanded/a/b.txt"),
            "utf8",
          ),
        ).toBe("fictional");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
