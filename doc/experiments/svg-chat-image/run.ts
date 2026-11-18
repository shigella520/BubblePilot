// Local, fictional-data feasibility probe. Never connects to a real gateway.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { BlueBubblesRestReplyGateway } from "../../../modules/integrations/bluebubbles/rest-reply-gateway.js";

const directory = dirname(fileURLToPath(import.meta.url));
const output = join(directory, "output");
const container = `bp-svg-probe-${process.pid}`;
const token = randomBytes(32).toString("hex");
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();
const maxBytes = 8 * 1024 * 1024;
await mkdir(output, { recursive: true });
let removed = false;
try {
  // Render with no network; export is a separate local HTTP transport test.
  const offline = docker(
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "--network",
    "none",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--pids-limit",
    "64",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65534:65534",
    "--tmpfs",
    "/workspace:rw,size=64m,mode=1777",
    "--tmpfs",
    "/tmp:rw,size=16m,mode=1777",
    "-e",
    "PROBE_RENDER_ONLY=1",
    "-v",
    `${directory}:/probe:ro`,
    "bp-svg-feasibility:local",
    "python",
    "-I",
    "/probe/probe.py",
  );
  await writeFile(join(output, "offline-render.json"), offline + "\n");
  docker(
    "run",
    "-d",
    "--name",
    container,
    "--platform",
    "linux/amd64",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--pids-limit",
    "64",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65534:65534",
    "--tmpfs",
    "/workspace:rw,size=64m,mode=1777",
    "--tmpfs",
    "/tmp:rw,size=16m,mode=1777",
    "-p",
    "127.0.0.1::47832",
    "-e",
    `PROBE_TOKEN=${token}`,
    "-v",
    `${directory}:/probe:ro`,
    "bp-svg-feasibility:local",
    "python",
    "-I",
    "/probe/probe.py",
  );
  const port = docker("port", container, "47832/tcp").split(":").at(-1);
  const base = `http://127.0.0.1:${port}`;
  const headers = { "X-Transfer-Token": token };
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (docker("logs", container).includes("READY")) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert(ready, "container readiness timeout");
  const evidence = await (await fetch(`${base}/results`, { headers })).json();
  assert.equal((await fetch(`${base}/image`)).status, 403);

  // BP-side receiver prototype: bounded streaming, no base64 in model messages.
  async function receive(path: string, signal = AbortSignal.timeout(5000)) {
    const partial = join(output, "image.partial");
    try {
      const response = await fetch(base + path, {
        headers,
        signal,
        redirect: "error",
      });
      assert.equal(response.status, 200);
      const length = Number(response.headers.get("content-length"));
      if (!Number.isSafeInteger(length) || length < 1 || length > maxBytes) {
        await response.body?.cancel();
        throw new Error("byte_limit");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      assert(response.body);
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes || size > length) throw new Error("byte_limit");
        chunks.push(chunk);
      }
      assert.equal(size, length, "incomplete_body");
      const bytes = Buffer.concat(chunks);
      assert.equal(
        sha(bytes),
        response.headers.get("x-content-sha256"),
        "hash_mismatch",
      );
      const image = sharp(bytes, { limitInputPixels: 16_000_000 });
      const metadata = await image.metadata();
      assert.equal(metadata.format, "png");
      await image.raw().toBuffer(); // Full decode, not merely magic-byte sniffing.
      await writeFile(partial, bytes, { mode: 0o600 });
      await rename(partial, join(output, "chart.png"));
      return bytes;
    } finally {
      await rm(partial, { force: true });
    }
  }
  const failures = [];
  for (const path of ["/truncated", "/bad-hash", "/oversize"]) {
    await assert.rejects(receive(path));
    failures.push(path);
  }
  await assert.rejects(receive("/image", AbortSignal.abort()));
  await assert.rejects(receive("/slow", AbortSignal.timeout(200)));
  const large = await receive("/large");
  assert(large.length > 1024 * 1024);
  const bytes = await receive("/image");
  assert.equal(sha(bytes), evidence.snapshot_sha256);
  docker("rm", "-f", container);
  removed = true;
  assert.equal(sha(await readFile(join(output, "chart.png"))), sha(bytes));

  // Exercise the real BP gateway against a loopback-only fake BlueBubbles server.
  let responseStatus = 200;
  let responseBody: unknown = { data: { guid: "fictional-image-guid" } };
  let requests = 0;
  let multipartFailure: unknown;
  const server = createServer(async (request, response) => {
    try {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      const form = await new Request("http://localhost/mock", {
        method: "POST",
        headers: { "content-type": String(request.headers["content-type"]) },
        body: Buffer.concat(parts),
      }).formData();
      assert.equal(form.get("chatGuid"), "iMessage;-;fictional-chart-chat");
      assert.equal(form.get("method"), "apple-script");
      assert.equal(form.get("tempGuid"), "fictional-stable-delivery-id");
      assert.equal(form.get("name"), "weekly-chart.png");
      const file = form.get("attachment");
      assert(file instanceof File);
      assert.equal(file.type, "image/png");
      assert.equal(file.name, "weekly-chart.png");
      assert.equal(sha(new Uint8Array(await file.arrayBuffer())), sha(bytes));
      requests++;
      response.writeHead(responseStatus, {
        "content-type": "application/json",
      });
      response.end(JSON.stringify(responseBody));
    } catch (error) {
      multipartFailure = error;
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const gateway = new BlueBubblesRestReplyGateway({
    serverUrl: `http://127.0.0.1:${address.port}`,
    accessToken: "fictional-local-token",
    method: "apple-script",
    timeoutMs: 2000,
  });
  const delivery = [];
  try {
    for (const [status, body, expected] of [
      [200, { data: { guid: "fictional-image-guid" } }, "confirmed"],
      [429, {}, "failed"],
      [503, {}, "unknown"],
      [200, { data: {} }, "unknown"],
    ] as const) {
      responseStatus = status;
      responseBody = body;
      const result = await gateway.sendAttachment({
        providerChatId: "iMessage;-;fictional-chart-chat",
        providerTempGuid: "fictional-stable-delivery-id",
        idempotencyKey: "fictional-run:reply:image",
        correlationId: "fictional-probe",
        filename: "weekly-chart.png",
        mimeType: "image/png",
        bytes,
      });
      assert.equal(result.status, expected);
      delivery.push({ httpStatus: status, result });
    }
    assert.ifError(multipartFailure);
    assert.equal(requests, 4); // No hidden retries by the gateway.
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const report = {
    ...evidence,
    transport: {
      unauthorizedRejected: true,
      failedTransfersRejected: failures,
      cancelledTransferRejected: true,
      hashPreserved: true,
      midTransferTimeoutRejected: true,
      largeBinaryBytes: large.length,
      survivesSandboxDeletion: true,
      multipartRequestsValidated: requests,
      delivery,
    },
  };
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (!removed) {
    try {
      docker("rm", "-f", container);
    } catch {
      /* startup may have failed */
    }
  }
}
