import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import type { AiToolDefinition } from "../ai/ai-types.js";
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

/** MCP JSON Schema is not the model's strict-schema subset. Preserve it verbatim. */
export function mcpModelDefinition(tool: AiToolDefinition): AiToolDefinition {
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
    return pluginError("INVALID_TOOL_ARGUMENTS");
  }
}
