// Local-only SDK feasibility probe. Creates and deletes disposable sandboxes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
const require = createRequire(
  new URL("../../../plugins/opensandbox/server/package.json", import.meta.url),
);
const {
  Sandbox,
  ConnectionConfig,
  SandboxManager,
} = require("@alibaba-group/opensandbox");
const url = new URL(process.env.SPIKE_URL ?? "http://127.0.0.1:28090");
assert(
  ["127.0.0.1", "localhost"].includes(url.hostname),
  "Only a local disposable server is allowed",
);
assert(process.env.SPIKE_KEY_FILE && process.env.SPIKE_IMAGE);
const cfg = new ConnectionConfig({
  domain: url.href,
  apiKey: (await readFile(process.env.SPIKE_KEY_FILE, "utf8")).trim(),
  useServerProxy: true,
  requestTimeoutSeconds: 40,
  disableMetrics: true,
});
const owner = `attachment-spike-${randomUUID()}`;
const live = [];
const report = { owner, checks: [] };
const hash = (b) => createHash("sha256").update(b).digest("hex");
const check = (name, extra = {}) => {
  report.checks.push({ name, ...extra });
  console.log(JSON.stringify(report.checks.at(-1)));
};
async function create() {
  const t = performance.now();
  const s = await Sandbox.create({
    connectionConfig: cfg,
    image: process.env.SPIKE_IMAGE,
    timeoutSeconds: 300,
    resource: { memory: "512Mi" },
    metadata: { "bubblepilot.experiment": owner },
    signal: AbortSignal.timeout(45000),
  });
  live.push(s);
  check("create", { ms: Math.round(performance.now() - t) });
  return s;
}
async function run(s, command) {
  const events = [];
  for await (const e of s.commands.runStream(
    command,
    { timeoutSeconds: 10 },
    AbortSignal.timeout(15000),
  ))
    events.push(e);
  assert(!events.some((e) => e.type === "error"), JSON.stringify(events));
  return events
    .filter((e) => e.type === "stdout")
    .map((e) => e.text)
    .join("\n");
}
async function* chunks(b) {
  for (let i = 0; i < b.length; i += 65536) yield b.subarray(i, i + 65536);
}
try {
  const s = await create();
  await s.files.createDirectories([
    { path: "/workspace/attachments", mode: 700 },
  ]);
  for (const size of [1024 * 1024, 10 * 1024 * 1024]) {
    const b = Buffer.alloc(size);
    for (let i = 0; i < size; i++) b[i] = i % 251;
    const path = `/workspace/attachments/payload-${size}.part`;
    const t = performance.now();
    await s.files.writeFiles([{ path, data: chunks(b), mode: 600 }]);
    const actual = (
      await run(
        s,
        `python -c "import hashlib; print(hashlib.sha256(open('${path}','rb').read()).hexdigest())"`,
      )
    ).trim();
    assert.equal(actual, hash(b));
    check("binary-stream-hash", {
      bytes: size,
      ms: Math.round(performance.now() - t),
    });
  }
  const csv1 = "地区,金额\n东,10\n西,20\n";
  const csv2 = "地区,金额\n东,7\n";
  await s.files.writeFiles([
    { path: "/workspace/attachments/昨天.csv", data: csv1 },
  ]);
  assert((await run(s, "ls /workspace/attachments")).includes("昨天.csv"));
  // A separate SDK handle for the same sandbox simulates backend handle reuse, not MCP authorization.
  const reconnected = await Sandbox.connect({
    sandboxId: s.id,
    connectionConfig: cfg,
  });
  await reconnected.files.writeFiles([
    { path: "/workspace/attachments/今天.csv", data: csv2 },
  ]);
  const result = await run(
    s,
    `python - <<'PY'
import csv,json
from collections import Counter
c=Counter()
for f in ['昨天.csv','今天.csv']:
 with open('/workspace/attachments/'+f) as h:
  for r in csv.DictReader(h): c[r['地区']]+=int(r['金额'])
print(json.dumps(dict(c),ensure_ascii=False))
PY`,
  );
  assert.deepEqual(JSON.parse(result), { 东: 17, 西: 20 });
  check("append-and-combine-same-sandbox");
  await reconnected.close();
  await run(
    s,
    "printf original >/tmp/spike-outside; ln -s /tmp/spike-outside /workspace/attachments/link",
  );
  let rejected = false;
  try {
    await s.files.writeFiles([
      { path: "/workspace/attachments/link", data: "changed" },
    ]);
  } catch {
    rejected = true;
  }
  const outside = (await run(s, "cat /tmp/spike-outside")).trim();
  check("native-upload-symlink", {
    rejected,
    outsideChanged: outside !== "original",
  });
  async function* interrupted() {
    yield Buffer.alloc(65536, 1);
    await new Promise((r) => setTimeout(r, 200));
    throw new Error("fictional-source-cancelled");
  }
  await assert.rejects(
    s.files.writeFiles([
      { path: "/workspace/attachments/cancel.part", data: interrupted() },
    ]),
  );
  check("source-stream-cancellation", {
    partialState: (
      await run(
        s,
        "python -c \"import os; p='/workspace/attachments/cancel.part'; print(os.path.getsize(p) if os.path.exists(p) else 'absent')\"",
      )
    ).trim(),
  });
  const shortCfg = new ConnectionConfig({
    domain: url.href,
    apiKey: (await readFile(process.env.SPIKE_KEY_FILE, "utf8")).trim(),
    useServerProxy: true,
    requestTimeoutSeconds: 1,
    disableMetrics: true,
  });
  const short = await Sandbox.connect({
    sandboxId: s.id,
    connectionConfig: shortCfg,
  });
  let produced = 0;
  async function* slow() {
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 250));
      produced++;
      yield Buffer.alloc(65536);
    }
  }
  const started = performance.now();
  try {
    await assert.rejects(
      short.files.writeFiles([
        { path: "/workspace/attachments/timeout.part", data: slow() },
      ]),
    );
    check("sdk-upload-timeout", {
      ms: Math.round(performance.now() - started),
    });
  } finally {
    await short.close();
    await shortCfg.closeTransport();
  }
  await new Promise((r) => setTimeout(r, 3200));
  check("after-timeout", {
    producedChunks: produced,
    partialState: (
      await run(
        s,
        "python -c \"import os; p='/workspace/attachments/timeout.part'; print(os.path.getsize(p) if os.path.exists(p) else 'absent')\"",
      )
    ).trim(),
  });
  const t = await create();
  assert.equal(
    (
      await run(
        t,
        "python -c \"import os; print(os.path.exists('/workspace/attachments/昨天.csv'))\"",
      )
    ).trim(),
    "False",
  );
  check("new-sandbox-isolation");
} finally {
  for (const s of live) {
    try {
      await s.kill();
    } finally {
      await s.close();
    }
  }
  const manager = SandboxManager.create({ connectionConfig: cfg });
  const remaining = await manager.listSandboxInfos({
    metadata: { "bubblepilot.experiment": owner },
    page: 1,
    pageSize: 100,
  });
  assert.equal(remaining.items.length, 0);
  check("cleanup", { remaining: 0 });
  await manager.close();
  await cfg.closeTransport();
}
