import { afterEach, expect, it, vi } from "vitest";
import {
  exportImage,
  harness,
  importImage,
  solid,
  sha256,
  type Harness,
} from "./support.js";

let h: Harness | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.close();
  h = undefined;
});

const text = (result: unknown) =>
  JSON.parse(
    (result as { content: { type: string; text?: string }[] }).content.find(
      (c) => c.type === "text",
    )?.text ?? "{}",
  ) as Record<string, unknown>;

it("requires bearer auth, rejects browser origins and unknown routes", async () => {
  h = await harness();
  expect((await fetch(h.url)).status).toBe(401);
  expect(
    (
      await fetch(h.url, {
        headers: {
          authorization: "Bearer fictional-image-gen-token-0123456789",
          origin: "http://evil.example",
        },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(new URL("/mcp/file-exports/tickets", h.url), {
        method: "POST",
        headers: {
          authorization: "Bearer fictional-image-gen-token-0123456789",
        },
      })
    ).status,
  ).toBe(404);
});

it("declares generator capabilities anchored to generate_image", async () => {
  h = await harness();
  const { client } = await h.connect();
  expect(client.getServerCapabilities()?.experimental).toEqual({
    "io.bubblepilot/image-export": {
      version: 1,
      fileBytes: 8388608,
      anchorTool: "generate_image",
      workspacePrefix: "/workspace/image-gen/",
    },
    "io.bubblepilot/attachments": {
      version: 1,
      fileBytes: 20971520,
      files: 5,
      totalBytes: 52428800,
      anchorTool: "generate_image",
      workspacePrefix: "/workspace/image-gen/",
      mimeTypes: ["image/png", "image/jpeg", "image/webp"],
    },
  });
  const tools = (await client.listTools()).tools;
  expect(tools.map((t) => t.name)).toEqual([
    "generate_image",
    "edit_image",
    "view_image",
  ]);
  expect(tools[0]!.inputSchema).toMatchObject({
    additionalProperties: false,
    required: ["prompt"],
  });
});

it("generates, previews and exports a PNG through a single-use session-bound ticket", async () => {
  h = await harness();
  const a = await h.connect();
  const b = await h.connect();
  const result = await a.client.callTool({
    name: "generate_image",
    arguments: {
      prompt: "fictional secret prompt about a boat",
      quality: "low",
    },
  });
  const body = text(result);
  expect(result.isError).toBe(false);
  expect(body).toMatchObject({
    status: "generated",
    width: 96,
    height: 64,
    format: "png",
  });
  const path = body.path as string;
  expect(path).toMatch(/^\/workspace\/image-gen\/out\/[0-9a-f-]{36}\.png$/u);
  expect(h.calls[0]).toMatchObject({
    op: "generate",
    input: { quality: "low", size: "1024x1024" },
  });

  const view = await a.client.callTool({
    name: "view_image",
    arguments: { path },
  });
  expect(view.isError).toBe(false);
  expect((view.content as { type: string }[]).map((c) => c.type)).toEqual([
    "text",
    "image",
  ]);
  expect(view.structuredContent).toMatchObject({
    sourceWidth: 96,
    sourceHeight: 64,
    transformed: true,
  });

  const sessionA = a.transport.sessionId!;
  const sessionB = b.transport.sessionId!;
  const exported = await exportImage(h, sessionA, path);
  expect(exported.status).toBe(200);
  expect(exported.headers?.get("content-type")).toBe("image/png");
  expect(exported.headers?.get("x-content-sha256")).toBe(
    sha256(exported.data!),
  );
  // Replaying the same token is denied.
  const replay = await h.post("/mcp/image-exports", sessionA, {
    headers: { "x-bp-transfer-token": exported.token! },
  });
  expect(replay.status).toBe(403);
  // Another session cannot see this workspace.
  expect(await exportImage(h, sessionB, path)).toMatchObject({
    status: 422,
    error: "image_not_found",
  });
  // The prompt never reaches logs.
  expect(JSON.stringify(h.logs)).not.toContain("fictional secret prompt");
  expect(h.logs[0]).toMatchObject({
    event: "image_generate",
    outcome: "generated",
    inputTokens: 5,
  });
});

it("rejects traversal, expired and excess export tickets", async () => {
  h = await harness();
  const { transport } = await h.connect();
  const session = transport.sessionId!;
  for (const path of [
    "/workspace/other.png",
    "/workspace/image-gen/../secret.png",
    "/workspace/image-gen/out\\x.png",
  ])
    expect(await exportImage(h, session, path)).toMatchObject({
      status: 422,
      error: "image_path_denied",
    });
  const tickets = [];
  for (let i = 0; i < 4; i++)
    tickets.push(
      await h.post("/mcp/image-exports/tickets", session, {
        body: JSON.stringify({ path: `/workspace/image-gen/out/${i}.png` }),
        headers: { "content-type": "application/json" },
      }),
    );
  expect(tickets.every((t) => t.ok)).toBe(true);
  const fifth = await h.post("/mcp/image-exports/tickets", session, {
    body: JSON.stringify({ path: "/workspace/image-gen/out/x.png" }),
    headers: { "content-type": "application/json" },
  });
  expect(await fifth.json()).toEqual({ error: "sandbox_busy" });
  const { token: stale } = (await tickets[0]!.json()) as { token: string };
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
  const expired = await h.post("/mcp/image-exports", session, {
    headers: { "x-bp-transfer-token": stale },
  });
  expect(expired.status).toBe(403);
});

it("imports user images with hash/MIME checks and edits them", async () => {
  h = await harness();
  const { client, transport } = await h.connect();
  const session = transport.sessionId!;
  const jpeg = await solid("jpeg", 80, 60);
  const imported = await importImage(h, session, jpeg, "IMG_0001.jpg");
  expect(imported.status).toBe(200);
  expect(imported.body.result).toMatchObject({
    status: "imported",
    sandbox_path:
      "/workspace/image-gen/attachments/00000000-0000-4000-8000-000000000001/IMG_0001.jpg",
    size: jpeg.length,
    sha256: sha256(jpeg),
    expandedBytes: 0,
    expandedFiles: 0,
    mimeType: "image/jpeg",
    width: 80,
    height: 60,
  });
  // Same id and metadata: the ticket request returns the existing result.
  const again = await importImage(h, session, jpeg, "IMG_0001.jpg");
  expect(again.body.result).toEqual(imported.body.result);
  // An imported JPEG is not a deliverable PNG.
  const sourcePath = imported.body.result!.sandbox_path as string;
  expect(await exportImage(h, session, sourcePath)).toMatchObject({
    status: 422,
    error: "image_invalid",
  });

  const edited = await client.callTool({
    name: "edit_image",
    arguments: { prompt: "make it green", images: [sourcePath] },
  });
  expect(text(edited)).toMatchObject({
    status: "generated",
    width: 64,
    height: 64,
  });
  const editCall = h.calls.find((c) => c.op === "edit")!.input as {
    images: { mime: string; filename: string; data: Buffer }[];
    quality: string;
  };
  expect(editCall.quality).toBe("medium");
  expect(editCall.images).toHaveLength(1);
  expect(editCall.images[0]).toMatchObject({
    mime: "image/jpeg",
    filename: "input-1.jpg",
  });
  expect(sha256(editCall.images[0]!.data)).toBe(sha256(jpeg));

  const missing = await client.callTool({
    name: "edit_image",
    arguments: {
      prompt: "x",
      images: ["/workspace/image-gen/attachments/none/x.png"],
    },
  });
  expect(text(missing)).toMatchObject({ status: "image_not_found" });
});

it("rejects non-image bytes and invalidates the session on hash mismatch", async () => {
  h = await harness();
  const { client, transport } = await h.connect();
  const session = transport.sessionId!;
  const fake = Buffer.from("not really a png, just text pretending");
  const rejected = await importImage(h, session, fake, "fake.png");
  expect(rejected).toMatchObject({
    status: 422,
    body: { error: "attachment_type_unsupported" },
  });
  // The session is still usable after a typed rejection.
  expect(
    text(
      await client.callTool({
        name: "generate_image",
        arguments: { prompt: "ok" },
      }),
    ).status,
  ).toBe("generated");

  const png = await solid("png");
  const ticket = await h.post("/mcp/attachments/tickets", session, {
    body: JSON.stringify({
      id: "00000000-0000-4000-8000-000000000002",
      filename: "a.png",
      size: png.length,
      sha256: "0".repeat(64),
      limits: { files: 5, totalMiB: 50, expandedMiB: 100, expandedFiles: 500 },
    }),
    headers: { "content-type": "application/json" },
  });
  const { token: uploadToken } = (await ticket.json()) as { token: string };
  const upload = await h.post("/mcp/attachments", session, {
    body: new Uint8Array(png),
    headers: {
      "x-bp-transfer-token": uploadToken,
      "content-length": String(png.length),
    },
  });
  expect(await upload.json()).toEqual({
    error: "attachment_hash_mismatch_session_invalidated",
  });
  const after = await client
    .callTool({ name: "generate_image", arguments: { prompt: "x" } })
    .catch(() => null);
  expect(
    after === null || text(after).status === "session_expired_or_invalidated",
  ).toBe(true);
});

it("enforces session and daily quotas without charging pre-send failures", async () => {
  h = await harness({ sessionLimit: 2, dailyLimit: 3 });
  const a = await h.connect();
  for (let i = 0; i < 2; i++)
    expect(
      text(
        await a.client.callTool({
          name: "generate_image",
          arguments: { prompt: "x" },
        }),
      ).status,
    ).toBe("generated");
  expect(
    text(
      await a.client.callTool({
        name: "generate_image",
        arguments: { prompt: "x" },
      }),
    ).status,
  ).toBe("quota_exceeded");
  const b = await h.connect();
  expect(
    text(
      await b.client.callTool({
        name: "generate_image",
        arguments: { prompt: "x" },
      }),
    ).status,
  ).toBe("generated");
  expect(
    text(
      await b.client.callTool({
        name: "generate_image",
        arguments: { prompt: "x" },
      }),
    ).status,
  ).toBe("quota_exceeded");
});

it("maps upstream failures to fixed codes and releases not-sent reservations", async () => {
  const { NotSentError } = await import("../src/upstream.js");
  const { ToolError } = await import("../src/errors.js");
  let mode: "notSent" | "rejected" = "notSent";
  h = await harness({
    dailyLimit: 1,
    client: {
      generate: () =>
        Promise.reject(
          mode === "notSent"
            ? new NotSentError("upstream_unavailable")
            : new ToolError("content_rejected"),
        ),
      edit: () => Promise.reject(new ToolError("upstream_timeout")),
    },
  });
  const { client } = await h.connect();
  expect(
    text(
      await client.callTool({
        name: "generate_image",
        arguments: { prompt: "x" },
      }),
    ),
  ).toMatchObject({
    status: "upstream_unavailable",
  });
  // Not charged: the single daily call is still available.
  mode = "rejected";
  const rejected = text(
    await client.callTool({
      name: "generate_image",
      arguments: { prompt: "x" },
    }),
  );
  expect(rejected.status).toBe("content_rejected");
  expect(String(rejected.guidance)).toContain("do not rephrase");
  // Charged: the limit is now reached.
  expect(
    text(
      await client.callTool({
        name: "generate_image",
        arguments: { prompt: "x" },
      }),
    ).status,
  ).toBe("quota_exceeded");
});

it("binds attachment tickets to one use, one session, a deadline and capacity", async () => {
  h = await harness();
  const a = (await h.connect()).transport.sessionId!;
  const b = (await h.connect()).transport.sessionId!;
  const png = await solid("png");
  const meta = (n: number) => ({
    id: `00000000-0000-4000-8000-00000000001${n}`,
    filename: `p${n}.png`,
    size: png.length,
    sha256: sha256(png),
    limits: { files: 5, totalMiB: 50, expandedMiB: 100, expandedFiles: 500 },
  });
  const ticket = async (session: string, n: number) =>
    (await (
      await h!.post("/mcp/attachments/tickets", session, {
        body: JSON.stringify(meta(n)),
        headers: { "content-type": "application/json" },
      })
    ).json()) as { token?: string; error?: string };
  const upload = (session: string, token: string) =>
    h!.post("/mcp/attachments", session, {
      body: new Uint8Array(png),
      headers: {
        "x-bp-transfer-token": token,
        "content-length": String(png.length),
      },
    });
  const first = await ticket(a, 0);
  expect(first.token).toMatch(/^[a-f0-9]{64}$/u);
  expect((await upload(b, first.token!)).status).toBe(403);
  expect((await upload(a, first.token!)).status).toBe(200);
  expect((await upload(a, first.token!)).status).toBe(403);
  const tokens = [];
  for (let n = 1; n <= 4; n++) tokens.push((await ticket(a, n)).token);
  expect(await ticket(a, 5)).toEqual({ error: "transfer_capacity_busy" });
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 11_000);
  expect((await upload(a, tokens[0]!)).status).toBe(403);
  expect(h.service.sessions.size).toBe(2);
  // Without a session id the binary channel is closed.
  expect(
    (
      await fetch(new URL("/mcp/attachments/tickets", h.url), {
        method: "POST",
        headers: {
          authorization: "Bearer fictional-image-gen-token-0123456789",
        },
      })
    ).status,
  ).toBe(403);
});

it("sends multiple edit inputs in order", async () => {
  h = await harness();
  const { client, transport } = await h.connect();
  const session = transport.sessionId!;
  const first = await importImage(
    h,
    session,
    await solid("png"),
    "a.png",
    "00000000-0000-4000-8000-000000000021",
  );
  const generated = await client.callTool({
    name: "generate_image",
    arguments: { prompt: "base" },
  });
  const paths = [
    first.body.result!.sandbox_path as string,
    text(generated).path as string,
  ];
  expect(
    text(
      await client.callTool({
        name: "edit_image",
        arguments: { prompt: "merge", images: paths },
      }),
    ).status,
  ).toBe("generated");
  const input = h.calls.find((c) => c.op === "edit")!.input as {
    images: { filename: string }[];
  };
  expect(input.images.map((i) => i.filename)).toEqual([
    "input-1.png",
    "input-2.png",
  ]);
  const empty = await client
    .callTool({ name: "edit_image", arguments: { prompt: "x", images: [] } })
    .catch(() => ({ isError: true }));
  expect(empty.isError).toBe(true);
  expect(h.calls.filter((c) => c.op === "edit")).toHaveLength(1);
});
