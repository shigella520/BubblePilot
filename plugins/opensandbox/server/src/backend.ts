import {
  TransferFailure,
  transferFailureReasons,
} from "./attachment-contract.js";
import { randomBytes } from "node:crypto";
import { attachmentCommand } from "./attachment-helper.js";
import type { TransferInput, TransferResult } from "./attachment-contract.js";
import {
  ConnectionConfig,
  Sandbox,
  SandboxManager,
} from "@alibaba-group/opensandbox";
import type { Config } from "./config.js";
import {
  imageExportCommand,
  ImageExportError,
  imageExportErrors,
  readImageResponse,
} from "./image-export.js";

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
  exportImage?(path: string, signal: AbortSignal): Promise<Buffer>;
  run(
    command: string,
    signal: AbortSignal,
    seconds: number,
  ): Promise<CommandResult>;
  upload?(
    input: TransferInput,
    body: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<TransferResult>;
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
    requestTimeoutSeconds: Math.max(
      config.SANDBOX_CREATE_TIMEOUT_SECONDS,
      config.ATTACHMENT_IMPORT_TIMEOUT_SECONDS,
      config.SANDBOX_COMMAND_MAX_TIMEOUT_SECONDS,
      config.SANDBOX_WORKSPACE_CHECK_TIMEOUT_SECONDS,
    ),
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
        readyTimeoutSeconds: config.SANDBOX_CREATE_TIMEOUT_SECONDS,
        resource: { memory: `${config.SANDBOX_MEMORY_MIB}Mi` },
        metadata: { ...metadata, "bubblepilot.session": owner },
        signal,
      });
      return {
        id: sandbox.id,
        async exportImage(path, signal) {
          const abort = new AbortController();
          const combined = AbortSignal.any([signal, abort.signal]);
          const port = 47832;
          const token = randomBytes(32).toString("hex");
          let ready!: () => void;
          let reject!: (error: unknown) => void;
          const readiness = new Promise<void>((resolve, fail) => {
            ready = resolve;
            reject = fail;
          });
          const cancelled = () =>
            reject(new ImageExportError("image_export_failed"));
          combined.addEventListener("abort", cancelled, { once: true });
          const command = (async () => {
            let seen = false,
              count = 0;
            for await (const event of sandbox.commands.runStream(
              imageExportCommand({ path, port, token, seconds: 30 }),
              { background: false, timeoutSeconds: 30 },
              combined,
            )) {
              count += Buffer.byteLength(event.text ?? "");
              if (count > 8192)
                throw new ImageExportError("image_export_failed");
              const code = event.text?.trim().replace(/^IMAGE_ERROR:/, "");
              if (code && imageExportErrors.has(code))
                throw new ImageExportError(code);
              if (
                event.type === "stdout" &&
                event.text?.includes("IMAGE_READY")
              ) {
                seen = true;
                ready();
              }
              if (event.type === "error")
                throw new ImageExportError("image_export_failed");
            }
            if (!seen) throw new ImageExportError("image_export_failed");
          })();
          void command.catch(reject);
          try {
            combined.throwIfAborted();
            await readiness;
            const endpoint = await sandbox.getEndpoint(port);
            const url = new URL(
              `${connectionConfig.protocol}://${endpoint.endpoint}`,
            );
            if (url.origin !== new URL(config.OPENSANDBOX_URL).origin)
              throw new ImageExportError("image_export_failed");
            const response = await fetch(url, {
              signal: combined,
              redirect: "error",
              headers: {
                ...connectionConfig.headers,
                ...endpoint.headers,
                "X-Transfer-Token": token,
              },
            });
            const data = await readImageResponse(response, combined);
            await command;
            combined.throwIfAborted();
            return data;
          } finally {
            abort.abort();
            combined.removeEventListener("abort", cancelled);
            await command.catch(() => undefined);
          }
        },
        async run(command, signal, seconds) {
          return collectOutput(
            sandbox.commands.runStream(
              command,
              { background: false, timeoutSeconds: seconds },
              signal,
            ),
          );
        },
        async upload(input, body, signal) {
          const controller = new AbortController();
          const combined = AbortSignal.any([signal, controller.signal]);
          let ready!: () => void;
          let failed!: (e: unknown) => void;
          const readiness = new Promise<void>((resolve, reject) => {
            ready = resolve;
            failed = reject;
          });
          const port = 47831;
          const token = randomBytes(32).toString("hex");
          const command = (async () => {
            let seen = false;
            let outputBytes = 0;
            for await (const event of sandbox.commands.runStream(
              attachmentCommand({
                ...input,
                port,
                token,
                acceptTimeoutSeconds: config.ATTACHMENT_IMPORT_TIMEOUT_SECONDS,
              }),
              {
                background: false,
                timeoutSeconds: config.ATTACHMENT_IMPORT_TIMEOUT_SECONDS,
              },
              combined,
            )) {
              outputBytes += Buffer.byteLength(event.text ?? "");
              if (outputBytes > 8192)
                throw new Error("Attachment helper output limit");
              if (
                event.type === "stdout" &&
                event.text?.includes("ATTACHMENT_READY")
              ) {
                seen = true;
                ready();
              }
              if (event.type === "error")
                throw new Error("Attachment helper failed");
            }
            if (!seen) throw new Error("Attachment helper unavailable");
          })();
          void command.catch(failed);
          try {
            await readiness;
            combined.throwIfAborted();
            const endpoint = await sandbox.getEndpoint(port);
            const target = new URL(
              `${connectionConfig.protocol}://${endpoint.endpoint}`,
            );
            if (target.origin !== new URL(config.OPENSANDBOX_URL).origin)
              throw new Error("Attachment proxy origin mismatch");
            const response = await fetch(target, {
              method: "POST",
              redirect: "error",
              signal: combined,
              headers: {
                ...connectionConfig.headers,
                ...endpoint.headers,
                "X-Transfer-Token": token,
                "Content-Length": String(input.size),
                "Content-Type": "application/octet-stream",
              },
              body,
              duplex: "half",
            });
            const reader = (
              response.body as ReadableStream<Uint8Array>
            ).getReader();
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            try {
              for (;;) {
                const item = await reader.read();
                if (item.done) break;
                bytes += item.value.byteLength;
                if (bytes > 4096) throw new Error("Invalid import result");
                chunks.push(item.value);
              }
            } finally {
              await reader.cancel().catch(() => undefined);
            }
            const text = Buffer.concat(chunks).toString("utf8");
            if (text.length > 4096) throw new Error("Invalid import result");
            if (!response.ok) {
              const failure = JSON.parse(text) as { error?: unknown };
              throw new TransferFailure(
                typeof failure.error === "string" &&
                  transferFailureReasons.has(failure.error)
                  ? failure.error
                  : "file_import_failed",
              );
            }
            const result = JSON.parse(text) as TransferResult;
            if (
              result.status !== "imported" ||
              result.sha256 !== input.sha256 ||
              result.size !== input.size ||
              !Number.isSafeInteger(result.expandedBytes) ||
              result.expandedBytes < 0 ||
              result.expandedBytes > input.limits.expandedMiB * 1024 * 1024 ||
              !Number.isSafeInteger(result.expandedFiles) ||
              result.expandedFiles < 0 ||
              result.expandedFiles > input.limits.expandedFiles ||
              (result.expandedPath !== undefined &&
                result.expandedPath !==
                  `/workspace/attachments/${input.id}/expanded`) ||
              result.sandbox_path !==
                `/workspace/attachments/${input.id}/${input.filename}`
            )
              throw new Error("Invalid import result");
            await command;
            combined.throwIfAborted();
            return result;
          } finally {
            controller.abort();
            await command.catch(() => undefined);
          }
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
