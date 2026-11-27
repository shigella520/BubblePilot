import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { PluginMcp } from "../modules/plugins/plugin-mcp.js";
import type {
  Connection,
  InstalledPlugin,
} from "../modules/plugins/plugin-types.js";
import { imageExportTargets } from "../modules/plugins/plugin-image-exports.js";
import { attachmentTargets } from "../modules/plugins/plugin-attachments.js";
import { createMcpHttp } from "../plugins/image-gen/server/src/http.js";
import { DailyQuota } from "../plugins/image-gen/server/src/quota.js";

// Shared contract: BP's own MCP client against the real image-gen adapter
// (mocked upstream, fictional data). Proves discovery, anchoring, import,
// generation and export interoperate without sandbox tool names.
const token = "fictional-image-gen-contract-token-0123";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function start() {
  const root = await mkdtemp(join(tmpdir(), "bp-image-gen-contract-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const png = (color: string) =>
    sharp({ create: { width: 64, height: 48, channels: 3, background: color } })
      .png()
      .toBuffer();
  const calls: string[] = [];
  const service = createMcpHttp(
    {
      client: {
        generate: async () => {
          calls.push("generate");
          return {
            data: await png("#ff0000"),
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
        edit: async () => {
          calls.push("edit");
          return {
            data: await png("#00ff00"),
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
      quota: new DailyQuota(join(root, "quota.json"), 20, "Asia/Shanghai"),
      config: {
        IMAGE_DEFAULT_QUALITY: "medium",
        IMAGE_MAX_QUALITY: "high",
        IMAGE_SESSION_LIMIT: 4,
        IMAGE_MODEL: "fictional-image-model",
      },
      log: () => undefined,
    },
    token,
    {
      ttlMs: 600_000,
      maxFiles: 8,
      maxBytes: 32 * 1024 * 1024,
      importTimeoutMs: 10_000,
    },
  );
  await new Promise<void>((r) => service.http.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => service.http.close(() => r())));
  const address = service.http.address();
  if (!address || typeof address === "string") throw new Error("address");
  const connection: Connection = {
    url: `http://127.0.0.1:${address.port}/mcp`,
    allowPrivate: true,
    auth: "bearer",
    secret: token,
    header: "X-Key",
  };
  return { root, connection, calls, png };
}

describe("image-gen adapter contract with BubblePilot's client", () => {
  it("discovers an anchored generator and round-trips import, edit and export", async () => {
    const f = await start();
    const client = new PluginMcp();
    cleanup.push(() => client.close());
    await client.connect(f.connection);
    expect(client.attachmentVersion()).toBe(1);
    expect(client.imageExportVersion()).toBe(1);
    expect(client.fileExportVersion()).toBeNull();
    const tools = await client.discover("image");
    const anchor = tools.find((t) => t.definition.name === "generate_image")!;
    expect(anchor).toMatchObject({
      imageExportVersion: 1,
      attachmentTransferVersion: 1,
      transportWorkspacePrefix: "/workspace/image-gen/",
      attachmentMimeTypes: ["image/png", "image/jpeg", "image/webp"],
    });
    for (const other of tools.filter((t) => t !== anchor))
      expect(
        other.imageExportVersion ?? other.attachmentTransferVersion,
      ).toBeUndefined();

    const plugin: InstalledPlugin = {
      id: randomUUID(),
      name: "fictional image generator",
      enabled: true,
      version: 1,
      revision: "r1",
      package: {
        name: "bubblepilot-image-gen",
        version: "0.1.0",
        description: "",
        format: "portable-1",
        skills: [],
        servers: [],
        files: {},
        hash: "h",
      },
      config: {
        connections: { image: f.connection },
        tools,
        disabledSkills: [],
        disabledTools: [],
      },
    };
    expect(imageExportTargets([plugin])).toEqual([
      expect.objectContaining({
        kind: "generator",
        workspacePrefix: "/workspace/image-gen/",
      }),
    ]);
    expect(attachmentTargets([plugin])).toEqual([
      expect.objectContaining({
        kind: "generator",
        mimeTypes: ["image/png", "image/jpeg", "image/webp"],
      }),
    ]);

    // Import a chat image exactly as AttachmentSession does.
    const photo = await sharp({
      create: { width: 32, height: 32, channels: 3, background: "#123456" },
    })
      .jpeg()
      .toBuffer();
    const file = join(f.root, "photo.jpeg");
    await writeFile(file, photo);
    const id = randomUUID();
    const imported = await client.transferAttachment(
      {
        id,
        filename: "photo.jpeg",
        size: photo.length,
        sha256: createHash("sha256").update(photo).digest("hex"),
        limits: { files: 3, totalMiB: 20, expandedMiB: 50, expandedFiles: 200 },
      },
      file,
      AbortSignal.timeout(10_000),
    );
    expect(String(imported.sandbox_path)).toMatch(
      /^\/workspace\/image-gen\/attachments\//u,
    );

    const edit = tools.find((t) => t.definition.name === "edit_image")!;
    const result = await client.call(
      edit,
      { prompt: "fictional edit", images: [imported.sandbox_path] },
      AbortSignal.timeout(10_000),
      10_000,
    );
    const payload = JSON.parse(JSON.stringify(result)) as {
      structuredContent?: { path?: string };
      content?: Array<{ text?: string }>;
    };
    const path =
      payload.structuredContent?.path ??
      (
        JSON.parse(payload.content?.find((c) => c.text)?.text ?? "{}") as {
          path?: string;
        }
      ).path;
    expect(path).toMatch(/^\/workspace\/image-gen\/out\/[0-9a-f-]+\.png$/u);
    expect(f.calls).toEqual(["edit"]);

    const exported = await client.exportImage(
      path!,
      AbortSignal.timeout(10_000),
    );
    expect(exported.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    await expect(
      client.exportImage("/workspace/report.pdf", AbortSignal.timeout(10_000)),
    ).rejects.toThrow();
  });
});
