import { describe, expect, it } from "vitest";
import {
  compileMcpSchema,
  mcpModelDefinition,
  decodeMcpArguments,
  mcpSchemaValidator,
} from "../modules/plugins/plugin-schema.js";
import {
  strictToolParameters,
  restoreToolArguments,
} from "../modules/ai/tool-schema.js";

describe("MCP contracts remain independent of model strict schemas", () => {
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
    expect(() => strictToolParameters(wire)).not.toThrow();
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
});
