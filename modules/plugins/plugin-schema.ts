import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import type { AiToolDefinition } from "../ai/ai-types.js";
import {
  compatibleToolParameters,
  strictToolParameters,
  ToolSchemaError,
} from "../ai/tool-schema.js";
import { ApplicationError } from "../../app/errors.js";
import { pluginError } from "./plugin-types.js";

/** Each contract has an isolated reference registry. No remote schema loading or mutation. */
export function compileMcpSchema(
  schema: Record<string, unknown>,
): ValidateFunction {
  const dialect = schema.$schema;
  const Constructor =
    dialect === undefined ||
    dialect === "https://json-schema.org/draft/2020-12/schema"
      ? Ajv2020.default
      : dialect === "https://json-schema.org/draft/2019-09/schema"
        ? Ajv2019.default
        : dialect === "http://json-schema.org/draft-07/schema#" ||
            dialect === "http://json-schema.org/draft-07/schema"
          ? Ajv.default
          : null;
  if (!Constructor) pluginError("SCHEMA_DIALECT_UNSUPPORTED");
  try {
    const validate = new Constructor({
      strictSchema: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
      allowUnionTypes: true,
      validateFormats: false,
      allErrors: false,
    }).compile(schema);
    if ("$async" in validate && validate.$async)
      pluginError("SCHEMA_UNSUPPORTED");
    return validate;
  } catch {
    return pluginError("SCHEMA_UNSUPPORTED");
  }
}

export class PluginArgumentsError extends ApplicationError {
  constructor(readonly issues: { field?: string; code: string }[]) {
    super(
      "PLUGIN_INVALID_TOOL_ARGUMENTS",
      "插件操作未完成：INVALID_TOOL_ARGUMENTS",
      400,
    );
  }
}

/** Return only approved schema field names and validator keywords, never input values. */
export function validateMcpArguments(
  schema: Record<string, unknown>,
  args: unknown,
): void {
  const validate = compileMcpSchema(schema);
  if (validate(args)) return;
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, unknown>)
      : {};
  const allowedCodes = new Set([
    "type",
    "required",
    "additionalProperties",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "pattern",
    "enum",
    "const",
    "format",
    "anyOf",
    "oneOf",
    "minItems",
    "maxItems",
    "uniqueItems",
  ]);
  const issues = (validate.errors ?? []).slice(0, 5).map((issue) => {
    const first = issue.instancePath
      .split("/")[1]
      ?.replace(/~1/g, "/")
      .replace(/~0/g, "~");
    const missing =
      issue.keyword === "required" &&
      typeof issue.params.missingProperty === "string"
        ? issue.params.missingProperty
        : undefined;
    const field = first || missing;
    return {
      ...(field && Object.hasOwn(properties, field) ? { field } : {}),
      code: allowedCodes.has(issue.keyword) ? issue.keyword : "invalid",
    };
  });
  throw new PluginArgumentsError(
    issues.length ? issues : [{ code: "invalid" }],
  );
}

export const mcpSchemaValidator: jsonSchemaValidator = {
  getValidator<T>(schema: Record<string, unknown>) {
    const validate = compileMcpSchema(schema);
    return (input: unknown) =>
      validate(input)
        ? { valid: true as const, data: input as T, errorMessage: undefined }
        : {
            valid: false as const,
            data: undefined,
            errorMessage: "MCP output does not match its approved schema",
          };
  },
};

export interface McpModelContract {
  definition: AiToolDefinition;
  argumentEncoding: "direct" | "json-string";
}

/** Choose once per registered tool, independent of Provider fallback or argument contents. */
export function mcpModelContract(tool: AiToolDefinition): McpModelContract {
  try {
    // Keep optional fields optional here; each Provider applies its own wire mode.
    // Close declared objects so malformed/legacy envelopes cannot reach MCP as extras.
    const parameters = compatibleToolParameters(tool);
    strictToolParameters({ ...tool, parameters });
    return {
      definition: { ...tool, parameters },
      argumentEncoding: "direct",
    };
  } catch (error) {
    if (!(error instanceof ToolSchemaError)) throw error;
    return {
      definition: envelopedMcpDefinition(tool),
      argumentEncoding: "json-string",
    };
  }
}

export function mcpModelDefinition(tool: AiToolDefinition): AiToolDefinition {
  return mcpModelContract(tool).definition;
}

/** Preserve complex MCP contracts that the model Schema adapter cannot represent. */
function envelopedMcpDefinition(tool: AiToolDefinition): AiToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "object",
      properties: {
        arguments_json: {
          type: "string",
          description:
            "A JSON-encoded object of MCP tool arguments. Follow this original input schema exactly; omit optional fields rather than inventing nulls. Schema: " +
            JSON.stringify(tool.parameters),
        },
      },
      required: ["arguments_json"],
      additionalProperties: false,
    },
  };
}

export function decodeMcpArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(args).length !== 1 || typeof args.arguments_json !== "string")
    pluginError("INVALID_TOOL_ARGUMENTS");
  try {
    const value: unknown = JSON.parse(args.arguments_json);
    if (!value || typeof value !== "object" || Array.isArray(value))
      pluginError("INVALID_TOOL_ARGUMENTS");
    return value as Record<string, unknown>;
  } catch {
    throw new PluginArgumentsError([
      { field: "arguments_json", code: "invalid_json_object" },
    ]);
  }
}
