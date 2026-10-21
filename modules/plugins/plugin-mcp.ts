import type { TrustedHostsProvider } from "../shared/network-settings.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
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
import Ajv from "ajv";
import { safeFetch } from "./plugin-network.js";
import { digest } from "./plugin-package.js";
import {
  pluginError,
  pluginLimits,
  type Connection,
  type ApprovedTool,
} from "./plugin-types.js";
import { strictToolParameters } from "../ai/tool-schema.js";
const ajv = new Ajv.default({
  strict: false,
  allErrors: false,
  validateFormats: false,
});
export class PluginMcp {
  constructor(
    private readonly trustedHosts: TrustedHostsProvider = () =>
      Promise.resolve([]),
  ) {}
  private readonly client = new Client(
    { name: "bubblepilot", version: "1.0.0" },
    { capabilities: {} },
  );
  private transport?: StreamableHTTPClientTransport;
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
        ),
      },
    );
    try {
      await this.client.connect(this.transport as Transport, {
        timeout: pluginLimits.timeoutMs,
        signal: signal ?? AbortSignal.timeout(pluginLimits.timeoutMs),
      });
    } catch {
      await this.close();
      pluginError("MCP_CONNECT_FAILED", 502);
    }
  }
  async discover(
    server: string,
    signal?: AbortSignal,
  ): Promise<ApprovedTool[]> {
    const tools: ApprovedTool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await this.client.listTools(cursor ? { cursor } : {}, {
        timeout: pluginLimits.timeoutMs,
        ...(signal ? { signal } : {}),
      });
      for (const tool of result.tools) {
        if (
          tool.name.length > 256 ||
          (tool.description?.length ?? 0) > 4096 ||
          JSON.stringify(tool.inputSchema).length > pluginLimits.textBytes
        )
          pluginError("TOOL_DEFINITION_TOO_LARGE");
        const definition = {
          name: tool.name,
          description: tool.description ?? tool.name,
          parameters: tool.inputSchema,
        };
        strictToolParameters(definition);
        ajv.compile(tool.inputSchema);
        tools.push({ server, definition, hash: digest(definition) });
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
    if (!ajv.validate(tool.definition.parameters, args))
      pluginError("INVALID_TOOL_ARGUMENTS");
    const result = await this.client
      .callTool(
        {
          name: tool.definition.name,
          arguments: args as Record<string, unknown>,
        },
        undefined,
        { signal, timeout: Math.max(1, timeout) },
      )
      .catch((error: unknown) => {
        if (signal.aborted) pluginError("MCP_CANCELLED");
        if (error instanceof StreamableHTTPError) {
          if (error.code === 402) pluginError("BILLING_REQUIRED");
          if (error.code === 429) pluginError("RATE_LIMITED");
          if (error.code === 401 || error.code === 403)
            pluginError("REMOTE_AUTH_DENIED");
        }
        if (error instanceof McpError) {
          if (error.code === -32001) pluginError("MCP_TIMEOUT", 504);
          pluginError("MCP_PROTOCOL_ERROR", 502);
        }
        pluginError("MCP_TRANSPORT_ERROR", 502);
      });
    signal.throwIfAborted();
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
    await this.transport?.terminateSession().catch(() => undefined);
    await this.client.close().catch(() => undefined);
  }
}
