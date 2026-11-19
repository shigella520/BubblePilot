// Local execd acceptance using only fictional files. Execd must run in a disposable
// sandbox on localhost:28479 with the new runtime, never against production.
import assert from "node:assert/strict";
import {
  collectOutput,
  type OutputEvent,
  type Backend,
} from "../../../plugins/opensandbox/server/src/backend.js";
import { SandboxPool } from "../../../plugins/opensandbox/server/src/lifecycle.js";
import { fileCommand } from "../../../plugins/opensandbox/server/src/files.js";
const evidence: Array<{
  types: string[];
  exitName?: unknown;
  status: string;
  exitCode: number | null;
}> = [];
const backend: Backend = {
  create: async () => ({
    id: "fictional-local-execd",
    close: async () => {},
    run: async (command, signal, seconds) => {
      const r = await fetch("http://127.0.0.1:28479/command", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-EXECD-ACCESS-TOKEN": "fictional-contract-token",
        },
        body: JSON.stringify({
          command,
          cwd: "/workspace",
          background: false,
          timeout: seconds * 1000,
        }),
        signal,
      });
      assert.equal(r.status, 200);
      const events: OutputEvent[] = [];
      async function* stream() {
        const reader = r.body!.getReader(),
          decoder = new TextDecoder();
        let pending = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, end).trimEnd();
              pending = pending.slice(end + 1);
              if (line.startsWith("data:") || line.startsWith("{")) {
                const event = JSON.parse(
                  line.startsWith("data:") ? line.slice(5) : line,
                ) as OutputEvent;
                events.push(event);
                yield event;
              }
            }
          }
        } finally {
          await reader.cancel();
        }
      }
      const result = await collectOutput(stream());
      evidence.push({
        types: events.map((e) => e.type),
        exitName: events.find((e) => e.type === "error")?.error?.ename,
        status: result.status,
        exitCode: result.exitCode,
      });
      return result;
    },
  }),
  remove: async () => true,
  owned: async () => [],
  close: async () => {},
};
const pool = new SandboxPool(backend, 1, 600000),
  session = pool.newSession();
const signal = () => AbortSignal.timeout(30000);
await session.prepare(signal());
assert.equal(
  (
    await session.run(
      fileCommand({
        op: "write",
        path: "/workspace/chart.svg",
        text: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="blue"/></svg>',
      }),
      10,
      signal(),
    )
  ).status,
  "completed",
);
const failed = await session.run(
  "bp-render-svg chart.svg chart.png",
  10,
  signal(),
);
assert.equal(failed.status, "command_failed");
assert.equal(failed.exitCode, 1);
assert.equal(JSON.parse(failed.stdout).code, "svg_path_denied");
assert.equal(session.ended, false);
assert.equal(evidence.at(-1)?.exitName, "CommandExecError");
assert.ok(!evidence.at(-1)?.types.includes("execution_complete"));
const corrected = await session.run(
  "bp-render-svg /workspace/chart.svg /workspace/chart.png",
  10,
  signal(),
);
assert.equal(corrected.status, "completed");
assert.equal(JSON.parse(corrected.stdout).status, "rendered");
const validated = await session.run(
  "python -c \"from PIL import Image; im=Image.open('/workspace/chart.png'); im.verify(); print('PNG valid')\"",
  10,
  signal(),
);
assert.equal(validated.exitCode, 0);
assert.equal(validated.stdout.trim(), "PNG valid");
session.invalidate();
await pool.sweep();
assert.equal(pool.used, 0);
console.log(
  JSON.stringify(
    {
      result: "passed",
      scenario:
        "write -> invalid relative path -> same-session correction -> PNG verification",
      evidence,
    },
    null,
    2,
  ),
);
