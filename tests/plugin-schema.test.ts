import { describe, expect, it } from "vitest";
import {
  compileMcpSchema,
  mcpModelDefinition,
  mcpModelContract,
  decodeMcpArguments,
  mcpSchemaValidator,
  validateMcpArguments,
  PluginArgumentsError,
} from "../modules/plugins/plugin-schema.js";
import {
  strictToolParameters,
  compatibleToolParameters,
  restoreToolArguments,
} from "../modules/ai/tool-schema.js";

describe("MCP contracts remain independent of model strict schemas", () => {
  it("uses real fields for ordinary tools while preserving optional null semantics", () => {
    const tool = {
      name: "run_command",
      description: "Fictional command tool",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1, maxLength: 32768 },
          timeout_seconds: {
            type: "integer",
            minimum: 1,
            maximum: 120,
            default: 60,
          },
          label: { type: ["string", "null"] },
        },
        required: ["command"],
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    };
    const original = structuredClone(tool);
    const contract = mcpModelContract(tool);
    expect(contract.argumentEncoding).toBe("direct");
    expect(
      Object.keys(contract.definition.parameters.properties as object),
    ).toEqual(["command", "timeout_seconds", "label"]);
    const command = 'python - <<\'PY\'\nprint("fictional \\"chart\\"")\nPY';
    const strict = { command, timeout_seconds: null, label: null };
    expect(
      compileMcpSchema(strictToolParameters(contract.definition))(strict),
    ).toBe(true);
    const restored: unknown = JSON.parse(
      restoreToolArguments(
        contract.definition.parameters,
        JSON.stringify(strict),
      ),
    );
    expect(restored).toEqual({ command, label: null });
    expect(() => validateMcpArguments(tool.parameters, restored)).not.toThrow();
    const compatible = compatibleToolParameters(contract.definition);
    expect(compileMcpSchema(compatible)({ command })).toBe(true);
    expect(
      compileMcpSchema(compatible)({ command, timeout_seconds: null }),
    ).toBe(false);
    expect(tool).toEqual(original);
  });
  it("does not confuse a real arguments_json field with the compatibility envelope", () => {
    const contract = mcpModelContract({
      name: "fictional_text",
      description: "Fictional",
      parameters: {
        type: "object",
        properties: { arguments_json: { type: "string" } },
        required: ["arguments_json"],
      },
    });
    expect(contract.argumentEncoding).toBe("direct");
    expect(
      compileMcpSchema(contract.definition.parameters)({
        arguments_json: "plain text",
      }),
    ).toBe(true);
  });
  const schema = {
    type: "object",
    properties: {
      schema: {
        type: "object",
        propertyNames: { pattern: "^[a-z]+$" },
        additionalProperties: { type: "integer" },
      },
      optional: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["schema"],
    additionalProperties: false,
  };
  it("preserves maps, propertyNames and optional nulls across the model envelope", () => {
    const definition = {
      name: "fictional_extract",
      description: "Fictional",
      parameters: schema,
    };
    const original = structuredClone(definition);
    const wire = mcpModelDefinition(definition);
    expect(mcpModelContract(definition).argumentEncoding).toBe("json-string");
    expect(() => strictToolParameters(wire)).not.toThrow();
    expect(() => compatibleToolParameters(wire)).not.toThrow();
    const input = { schema: { price: 12 }, optional: null };
    const normalized = restoreToolArguments(
      wire.parameters,
      JSON.stringify({ arguments_json: JSON.stringify(input) }),
    );
    expect(
      decodeMcpArguments(JSON.parse(normalized) as Record<string, unknown>),
    ).toEqual(input);
    expect(compileMcpSchema(schema)(input)).toBe(true);
    expect(compileMcpSchema(schema)({ schema: { "bad-key": 12 } })).toBe(false);
    expect(compileMcpSchema(schema)({ schema: { price: "12" } })).toBe(false);
    expect(definition).toEqual(original);
  });
  it("uses 2020-12 by default and supports local refs, tuples and unevaluatedProperties", () => {
    const validate = compileMcpSchema({
      type: "object",
      $defs: { count: { type: "integer" } },
      properties: {
        pair: {
          type: "array",
          prefixItems: [{ $ref: "#/$defs/count" }],
          items: false,
        },
      },
      unevaluatedProperties: false,
    });
    expect(validate({ pair: [2] })).toBe(true);
    expect(validate({ pair: ["2"] })).toBe(false);
    expect(validate({ pair: [2, 3] })).toBe(false);
    expect(validate({ extra: true })).toBe(false);
  });
  it("supports declared draft-07 without sharing schema IDs or mutating arguments", () => {
    const s = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "https://example.test/schema",
      type: "object",
      properties: { count: { type: "integer", default: 3 } },
    };
    const input = {};
    expect(compileMcpSchema(s)(input)).toBe(true);
    expect(input).toEqual({});
    expect(compileMcpSchema({ ...s, required: ["count"] })(input)).toBe(false);
  });
  it("accepts no-parameter schemas and rejects invalid envelopes", () => {
    expect(
      compileMcpSchema({ type: "object", additionalProperties: false })({}),
    ).toBe(true);
    for (const value of [
      {},
      { arguments_json: "{" },
      { arguments_json: "null" },
      { arguments_json: "[]" },
      { arguments_json: "{}", extra: 1 },
    ])
      expect(() => decodeMcpArguments(value)).toThrow("INVALID_TOOL_ARGUMENTS");
  });
  it("rejects unsupported dialects, external refs, unknown assertions and async schemas locally", () => {
    for (const s of [
      { $schema: "https://example.test/dialect" },
      { $ref: "https://example.test/schema" },
      { type: "object", madeUpConstraint: true },
      { $async: true, type: "object" },
    ])
      expect(() => compileMcpSchema(s)).toThrow("SCHEMA_");
  });
  it("validates structured outputs using the same dialect without leaking payloads", () => {
    const validate = mcpSchemaValidator.getValidator({
      type: "object",
      properties: { result: { type: "integer" } },
      required: ["result"],
    });
    expect(validate({ result: 1 }).valid).toBe(true);
    expect(validate({ result: "secret" })).toEqual({
      valid: false,
      data: undefined,
      errorMessage: "MCP output does not match its approved schema",
    });
  });
  it("reports only approved argument names and validation keywords", () => {
    const contract = {
      type: "object",
      properties: { timeout_seconds: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    };
    try {
      validateMcpArguments(contract, { timeout_seconds: null });
      throw new Error("Expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginArgumentsError);
      expect((error as PluginArgumentsError).issues).toEqual([
        { field: "timeout_seconds", code: "type" },
      ]);
    }
    try {
      validateMcpArguments(contract, {
        "fictional-private-field": "private-value",
      });
      throw new Error("Expected validation failure");
    } catch (error) {
      expect(
        JSON.stringify((error as PluginArgumentsError).issues),
      ).not.toContain("fictional-private");
      expect((error as PluginArgumentsError).issues).toEqual([
        { code: "additionalProperties" },
      ]);
    }
    expect(() => validateMcpArguments(contract, {})).not.toThrow();
  });
});
