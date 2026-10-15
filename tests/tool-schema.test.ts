import { describe, expect, it } from "vitest";
import type { AiToolDefinition } from "../modules/ai/ai-types.js";
import {
  strictToolParameters,
  restoreToolArguments,
} from "../modules/ai/tool-schema.js";
import { memoryTools } from "../modules/memory/memory-service.js";
import {
  chatMessageQuerySchema,
  chatCountQuerySchema,
  chatExtremaQuerySchema,
} from "../modules/memory/chat-query-types.js";
import {
  memorySearchSchema,
  chatExcerptSchema,
} from "../modules/memory/memory-types.js";
import {
  allToolDefinitions,
  assertStrictSchema,
} from "./support/tool-schema-fixtures.js";

const tool = (parameters: Record<string, unknown>): AiToolDefinition => ({
  name: "fictional",
  description: "test",
  parameters,
});
describe("strict tool schema", () => {
  it("compiles every application tool and capability probe without mutating definitions", () => {
    const definitions = allToolDefinitions();
    expect(definitions.map((t) => t.name).sort()).toEqual([
      "capability_probe",
      "count_chat_messages",
      "get_chat_message_extrema",
      "query_chat_messages",
      "read_chat_excerpt",
      "search_chat_history",
      "search_memes",
      "select_meme",
      "view_chat_image",
      "web_search",
    ]);
    for (const definition of definitions) {
      const original = structuredClone(definition);
      const strict = strictToolParameters(definition);
      assertStrictSchema(strict);
      expect(
        strictToolParameters({ ...definition, parameters: strict }),
      ).toEqual(strict);
      expect(definition).toEqual(original);
    }
  });
  it("keeps constraints inside nullable branches and leaves required values nonnullable", () => {
    const schema = strictToolParameters(
      tool({
        type: "object",
        properties: {
          query: { type: "string" },
          mode: { type: "string", enum: ["first", "last"], default: "first" },
          nested: {
            type: "object",
            properties: { n: { type: "integer", minimum: 1 } },
          },
          items: {
            type: "array",
            items: { type: "object", properties: { x: { type: "boolean" } } },
          },
        },
        required: ["query"],
        $schema: "fictional",
      }),
    );
    expect(schema).toMatchObject({
      required: ["query", "mode", "nested", "items"],
      properties: {
        query: { type: "string" },
        mode: {
          anyOf: [
            { type: "string", enum: ["first", "last"] },
            { type: "null" },
          ],
        },
      },
    });
    expect(JSON.stringify(schema)).not.toContain('"default"');
    assertStrictSchema(schema);
  });
  it.each([
    { type: "object", properties: { x: { $ref: "#/thing" } } },
    {
      type: "object",
      properties: { x: { type: "string", not: { const: "bad" } } },
    },
    {
      type: "object",
      properties: {},
      additionalProperties: { type: "string" },
    },
    { type: "object", properties: {}, required: ["unknown"] },
    { type: "object", properties: { x: { type: "array", items: true } } },
  ])(
    "rejects unsupported definitions with the tool and schema path",
    (parameters) => {
      expect(() => strictToolParameters(tool(parameters))).toThrow(
        /fictional at \//,
      );
    },
  );
});

describe("wire argument restoration", () => {
  it("restores input defaults and filters for all history tools", () => {
    const schemas = [
      chatMessageQuerySchema,
      chatCountQuerySchema,
      chatExtremaQuerySchema,
      memorySearchSchema,
      chatExcerptSchema,
    ];
    for (const [i, definition] of memoryTools.entries()) {
      const requiredValues = {
        pick: "first",
        query: "fictional",
        ref: "M1",
      } as Record<string, string>;
      const args = Object.fromEntries(
        Object.keys(definition.parameters.properties as object).map((k) => [
          k,
          (definition.parameters.required as string[] | undefined)?.includes(k)
            ? requiredValues[k]
            : null,
        ]),
      );
      const restored = JSON.parse(
        restoreToolArguments(definition.parameters, JSON.stringify(args)),
      ) as Record<string, unknown>;
      expect(Object.values(restored)).not.toContain(null);
      expect(schemas[i]!.safeParse(restored).success).toBe(true);
    }
    const query = memoryTools[0]!;
    expect(
      chatMessageQuerySchema.parse(
        JSON.parse(
          restoreToolArguments(query.parameters, '{"limit":null,"order":null}'),
        ),
      ),
    ).toMatchObject({ limit: 20, order: "desc" });
  });
  it("preserves intentional null, invalid inputs, unknown properties and array positions", () => {
    const s = {
      type: "object",
      properties: {
        id: { type: ["string", "null"] },
        query: { type: "string" },
        limit: { type: "integer" },
        nested: { type: "object", properties: { x: { type: "string" } } },
        items: {
          type: "array",
          items: { type: "object", properties: { x: { type: "string" } } },
        },
      },
      required: ["id", "query"],
    };
    const value = {
      id: null,
      query: null,
      limit: null,
      unknown: null,
      nested: { x: null },
      items: [null, { x: null }],
    };
    expect(JSON.parse(restoreToolArguments(s, JSON.stringify(value)))).toEqual({
      id: null,
      query: null,
      unknown: null,
      nested: {},
      items: [null, {}],
    });
    expect(restoreToolArguments(s, "invalid json")).toBe("invalid json");
    expect(JSON.parse(restoreToolArguments(s, '{"limit":"wrong"}'))).toEqual({
      limit: "wrong",
    });
    expect(JSON.parse(restoreToolArguments(s, "{}"))).toEqual({});
  });
  it("handles unions without deleting fields when matching branches disagree", () => {
    const s = {
      type: "object",
      properties: {
        choice: {
          anyOf: [
            { type: "object", properties: { x: { type: "string" } } },
            { type: "object", properties: { x: { type: ["string", "null"] } } },
          ],
        },
        optional: { anyOf: [{ type: "string" }, { type: "integer" }] },
      },
    };
    expect(
      JSON.parse(
        restoreToolArguments(s, '{"choice":{"x":null},"optional":null}'),
      ),
    ).toEqual({ choice: { x: null } });
  });
});
