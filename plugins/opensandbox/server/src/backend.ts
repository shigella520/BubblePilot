import {
  ConnectionConfig,
  Sandbox,
  SandboxManager,
} from "@alibaba-group/opensandbox";
import type { Config } from "./config.js";

export interface CommandResult {
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}
export interface Handle {
  id: string;
  run(
    command: string,
    signal: AbortSignal,
    seconds: number,
  ): Promise<CommandResult>;
  close(): Promise<void>;
}
export interface Backend {
  create: (owner: string, signal: AbortSignal) => Promise<Handle>;
  remove: (id: string) => Promise<boolean>;
  owned: (owner?: string) => Promise<string[]>;
  close(): Promise<void>;
}
export const OUTPUT_BYTES = 1024 * 1024;
export interface OutputEvent {
  type: string;
  text?: string;
  error?: Record<string, unknown>;
}
export async function collectOutput(
  events: AsyncIterable<OutputEvent>,
  cap = OUTPUT_BYTES,
): Promise<CommandResult> {
  const started = Date.now();
  let stdout = "",
    stderr = "",
    bytes = 0,
    complete = false,
    failed = false;
  let exitCode: number | null = null;
  for await (const event of events) {
    if (event.type === "stdout" || event.type === "stderr") {
      // Execd emits log records; release 1.1.0 strips their line terminators.
      // Keep records separate instead of turning e.g. 12 and 34 into 1234.
      const previous = event.type === "stdout" ? stdout : stderr;
      const separator = previous && !previous.endsWith("\n") ? "\n" : "";
      const data = Buffer.from(separator + (event.text ?? ""));
      const remaining = cap - bytes;
      // TextDecoder avoids emitting half a UTF-8 code point at the output boundary.
      const text = new TextDecoder().decode(data.subarray(0, remaining), {
        stream: data.length > remaining,
      });
      if (event.type === "stdout") stdout += text;
      else stderr += text;
      bytes += data.length;
      if (bytes > cap)
        return {
          status: "output_limit_sandbox_invalidated",
          exitCode: null,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          truncated: true,
        };
    }
    if (event.type === "error") {
      failed = true;
      const raw = event.error?.exit_code ?? event.error?.evalue;
      if (
        (typeof raw === "number" && Number.isInteger(raw)) ||
        (typeof raw === "string" && /^-?\d+$/.test(raw))
      )
        exitCode = Number(raw);
    }
    if (event.type === "execution_complete") {
      complete = true;
      break;
    }
  }
  if (complete && !failed) exitCode = 0;
  return {
    status: complete
      ? exitCode === 0
        ? "completed"
        : "command_failed"
      : "result_unknown",
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - started,
    truncated: false,
  };
}
export function sdkBackend(config: Config, apiKey: string): Backend {
  const connectionConfig = new ConnectionConfig({
    domain: config.OPENSANDBOX_URL,
    apiKey,
    requestTimeoutSeconds: 40,
    useServerProxy: true,
  });
  const manager = SandboxManager.create({ connectionConfig });
  const metadata = { "bubblepilot.adapter": config.ADAPTER_INSTANCE_ID };
  return {
    async create(owner, signal) {
      const sandbox = await Sandbox.create({
        connectionConfig,
        image: config.SANDBOX_IMAGE,
        timeoutSeconds: config.SANDBOX_TTL_SECONDS,
        resource: { memory: `${config.SANDBOX_MEMORY_MIB}Mi` },
        metadata: { ...metadata, "bubblepilot.session": owner },
        signal,
      });
      return {
        id: sandbox.id,
        async run(command, signal, seconds) {
          return collectOutput(
            sandbox.commands.runStream(
              command,
              { background: false, timeoutSeconds: seconds },
              signal,
            ),
          );
        },
        close: () => sandbox.close(),
      };
    },
    async remove(id) {
      // Deletion acceptance is not proof of runtime cleanup. Confirm absence separately.
      try {
        await manager.killSandbox(id, AbortSignal.timeout(10000));
      } catch {
        /* Confirm through the list even after a lost deletion response. */
      }
      return !(await this.owned()).includes(id);
    },
    async owned(owner) {
      const ids: string[] = [];
      for (let page = 1; page <= 100; page++) {
        const result = await manager.listSandboxInfos({
          metadata: {
            ...metadata,
            ...(owner ? { "bubblepilot.session": owner } : {}),
          },
          page,
          pageSize: 100,
        });
        for (const item of result.items)
          if (
            item.metadata?.["bubblepilot.adapter"] ===
              config.ADAPTER_INSTANCE_ID &&
            (!owner || item.metadata?.["bubblepilot.session"] === owner)
          )
            ids.push(item.id);
        if (result.items.length < 100) return ids;
      }
      throw new Error("Reconciliation limit exceeded");
    },
    close: () => manager.close(),
  };
}
