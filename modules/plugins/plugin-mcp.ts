import { boundedClose } from "./bounded-close.js";
import type { TrustedHostsProvider } from "../shared/network-settings.js";
import {
  McpError,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  pluginFailureGuidance,
  pluginResultErrorCode,
} from "./plugin-guidance.js";
import {
  StreamableHTTPError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ApplicationError } from "../../app/errors.js";
import { compileMcpSchema, mcpSchemaValidator } from "./plugin-schema.js";
import { safeFetch } from "./plugin-network.js";
import { digest } from "./plugin-package.js";
import {
  pluginError,
  pluginLimits,
  type Connection,
  type ApprovedTool,
} from "./plugin-types.js";
function mcpFailure(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted) pluginError("MCP_CANCELLED");
  if (error instanceof ApplicationError) throw error;
  if (error instanceof UnauthorizedError)
    pluginError("REMOTE_AUTH_DENIED", 502);
  if (error instanceof Error && error.name === "TimeoutError")
    pluginError("MCP_TIMEOUT", 504);
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401 || error.code === 403)
      pluginError("REMOTE_AUTH_DENIED", 502);
    if (error.code === 402) pluginError("BILLING_REQUIRED", 502);
    if (error.code === 429) pluginError("RATE_LIMITED", 502);
  }
  if (error instanceof McpError) {
    if (error.code === -32001) pluginError("MCP_TIMEOUT", 504);
    pluginError("MCP_PROTOCOL_ERROR", 502);
  }
  pluginError("MCP_TRANSPORT_ERROR", 502);
}
export class PluginMcp {
  constructor(
    private readonly trustedHosts: TrustedHostsProvider = () =>
      Promise.resolve([]),
  ) {}
  private readonly client = new Client(
    { name: "bubblepilot", version: "1.0.0" },
    { capabilities: {}, jsonSchemaValidator: mcpSchemaValidator },
  );
  private transport?: StreamableHTTPClientTransport;
  private callMetrics:
    { responseBytes: number; tooLarge: boolean; abort: () => void } | undefined;
  async connect(connection: Connection, signal?: AbortSignal) {
    const headers: Record<string, string> = {};
    if (connection.auth !== "none") {
      if (!connection.secret) pluginError("SECRET_REQUIRED");
      if (/[\r\n]/.test(connection.secret)) pluginError("INVALID_SECRET");
      if (
        connection.auth === "header" &&
        /^(host|cookie|content-length|connection|origin|mcp-.*)$/i.test(
          connection.header,
        )
      )
        pluginError("INVALID_HEADER");
      headers[
        connection.auth === "bearer" ? "Authorization" : connection.header
      ] =
        connection.auth === "bearer"
          ? `Bearer ${connection.secret}`
          : connection.secret;
    }
    this.transport = new StreamableHTTPClientTransport(
      new URL(connection.url),
      {
        requestInit: { headers },
        fetch: safeFetch(
          connection.url,
          connection.allowPrivate,
          this.trustedHosts,
          (init) => {
            if (typeof init?.body !== "string") return;
            let method: unknown;
            try {
              method = (JSON.parse(init.body) as { method?: unknown }).method;
            } catch {
              return;
            }
            const metrics = this.callMetrics;
            if (method !== "tools/call" || !metrics) return;
            return (bytes, tooLarge) => {
              metrics.responseBytes = bytes;
              metrics.tooLarge = tooLarge;
              if (tooLarge) metrics.abort();
            };
          },
        ),
      },
    );
    try {
      await this.client.connect(this.transport as Transport, {
        timeout: pluginLimits.timeoutMs,
        signal: signal ?? AbortSignal.timeout(pluginLimits.timeoutMs),
      });
    } catch (error) {
      await this.close();
      mcpFailure(error, signal);
    }
  }
  async discover(
    server: string,
    signal?: AbortSignal,
  ): Promise<ApprovedTool[]> {
    const tools: ApprovedTool[] = [];
    const deadline = Date.now() + pluginLimits.timeoutMs;
    let pages = 0;
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      if (signal?.aborted) pluginError("MCP_CANCELLED");
      if (++pages > pluginLimits.tools || Date.now() >= deadline)
        pluginError("MCP_TIMEOUT", 504);
      const result = await this.client
        .listTools(cursor ? { cursor } : {}, {
          timeout: Math.max(1, deadline - Date.now()),
          ...(signal ? { signal } : {}),
        })
        .catch((error: unknown) => mcpFailure(error, signal));
      if (signal?.aborted) pluginError("MCP_CANCELLED");
      for (const tool of result.tools) {
        if (tool.execution?.taskSupport === "required")
          pluginError("MCP_TASK_REQUIRED");
        if (
          tool.name.length > 256 ||
          (tool.description?.length ?? 0) > 4096 ||
          JSON.stringify(tool).length > pluginLimits.textBytes
        )
          pluginError("TOOL_DEFINITION_TOO_LARGE");
        const definition = {
          name: tool.name,
          description: tool.description ?? tool.name,
          parameters: tool.inputSchema,
        };
        compileMcpSchema(tool.inputSchema);
        if (tool.outputSchema) compileMcpSchema(tool.outputSchema);
        tools.push({
          server,
          definition,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          hash: digest(
            tool.outputSchema
              ? { definition, outputSchema: tool.outputSchema }
              : definition,
          ),
        });
        if (tools.length > pluginLimits.tools) pluginError("TOO_MANY_TOOLS");
      }
      cursor = result.nextCursor;
      if (cursor) {
        if (seen.has(cursor)) pluginError("INVALID_PAGINATION");
        seen.add(cursor);
      }
    } while (cursor);
    if (new Set(tools.map((t) => t.definition.name)).size !== tools.length)
      pluginError("DUPLICATE_TOOL");
    return tools;
  }
  async call(
    tool: ApprovedTool,
    args: unknown,
    signal: AbortSignal,
    timeout: number,
  ) {
    if (signal.aborted) pluginError("MCP_CANCELLED");
    if (!compileMcpSchema(tool.definition.parameters)(args))
      pluginError("INVALID_TOOL_ARGUMENTS");
    // Validate against the pinned contract below, not the SDK's last-page cache.
    // Error results need not satisfy a successful outputSchema.
    const controller = new AbortController();
    const metrics = {
      responseBytes: 0,
      tooLarge: false,
      abort: () => controller.abort(),
    };
    this.callMetrics = metrics;
    const result = await this.client
      .request(
        {
          method: "tools/call",
          params: {
            name: tool.definition.name,
            arguments: args as Record<string, unknown>,
          },
        },
        CallToolResultSchema,
        {
          signal: AbortSignal.any([signal, controller.signal]),
          timeout: Math.max(1, timeout),
        },
      )
      .catch((error: unknown) => {
        if (metrics.tooLarge) pluginError("RESPONSE_TOO_LARGE", 502);
        mcpFailure(error, signal);
      });
    if (signal.aborted) pluginError("MCP_CANCELLED");
    if (
      !result.isError &&
      tool.outputSchema &&
      (result.structuredContent === undefined ||
        !compileMcpSchema(tool.outputSchema)(result.structuredContent))
    )
      pluginError("MCP_OUTPUT_INVALID", 502);
    const content = result.content;
    if (
      !Array.isArray(content) ||
      content.some(
        (c: unknown) =>
          !c || typeof c !== "object" || !("type" in c) || c.type !== "text",
      )
    )
      pluginError("UNSUPPORTED_RESULT");
    return {
      responseBytes: metrics.responseBytes,
      status: result.isError ? "error" : "success",
      content,
      ...(result.isError
        ? {
            errorCode: pluginResultErrorCode(result.structuredContent),
            ...pluginFailureGuidance,
          }
        : {}),
      ...(result.structuredContent
        ? { structuredContent: result.structuredContent }
        : {}),
    };
  }
  async close() {
    await boundedClose(async () => this.transport?.terminateSession());
    await boundedClose(() => this.client.close());
  }
}
