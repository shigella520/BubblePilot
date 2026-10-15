import type { AiToolDefinition } from "./ai-types.js";

type Schema = Record<string, unknown>;
function object(value: unknown): value is Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const annotations = new Set(["$schema", "default", "examples", "title"]);
const keywords = new Set([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "anyOf",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
]);
const types = new Set([
  "object",
  "array",
  "string",
  "integer",
  "number",
  "boolean",
  "null",
]);

export class ToolSchemaError extends Error {
  constructor(tool: string, path: string) {
    super(`Invalid strict tool schema: ${tool} at ${path}`);
  }
}

/** Build a wire-only schema. Business definitions and defaults stay untouched. */
export function strictToolParameters(tool: AiToolDefinition): Schema {
  const visit = (value: unknown, path: string, depth: number): Schema => {
    const fail = (suffix = ""): never => {
      throw new ToolSchemaError(tool.name, path + suffix);
    };
    if (!object(value) || depth > 64) return fail();
    const result: Schema = {};
    for (const [key, entry] of Object.entries(value)) {
      if (annotations.has(key)) continue;
      if (!keywords.has(key)) return fail(`/${key}`);
      result[key] = structuredClone(entry);
    }
    if (value.anyOf !== undefined) {
      if (!Array.isArray(value.anyOf) || value.anyOf.length === 0)
        return fail("/anyOf");
      // Avoid ambiguous sibling constraints and branch normalization semantics.
      if (
        Object.keys(value).some(
          (k) => !annotations.has(k) && k !== "anyOf" && k !== "description",
        )
      )
        return fail("/anyOf");
      result.anyOf = value.anyOf.map((branch, i) =>
        visit(branch, `${path}/anyOf/${i}`, depth + 1),
      );
      return result;
    }
    const declared = Array.isArray(value.type) ? value.type : [value.type];
    if (
      declared.some((t) => typeof t !== "string" || !types.has(t)) ||
      declared.length === 0
    )
      return fail("/type");
    if (
      declared.length > 1 &&
      declared.some((t) => t === "object" || t === "array") &&
      declared.filter((t) => t !== "null").length > 1
    )
      return fail("/type");
    if (value.const !== undefined) {
      if (value.enum !== undefined) return fail("/const");
      result.enum = [value.const];
      delete result.const;
    }
    if (declared.includes("object")) {
      if (
        !object(value.properties) ||
        (value.additionalProperties !== undefined &&
          value.additionalProperties !== false)
      )
        return fail("/properties");
      const required = value.required ?? [];
      if (
        !Array.isArray(required) ||
        required.some(
          (k) =>
            typeof k !== "string" ||
            !Object.hasOwn(value.properties as Schema, k),
        )
      )
        return fail("/required");
      result.properties = Object.fromEntries(
        Object.entries(value.properties).map(([key, child]) => {
          const converted = visit(
            child,
            `${path}/properties/${key}`,
            depth + 1,
          );
          return [
            key,
            required.includes(key) || acceptsNull(child)
              ? converted
              : { anyOf: [converted, { type: "null" }] },
          ];
        }),
      );
      result.required = Object.keys(value.properties);
      result.additionalProperties = false;
    } else if (
      value.properties !== undefined ||
      value.required !== undefined ||
      value.additionalProperties !== undefined
    )
      return fail("/properties");
    if (declared.includes("array"))
      result.items = visit(value.items, `${path}/items`, depth + 1);
    else if (value.items !== undefined) return fail("/items");
    return result;
  };
  if (tool.parameters.type !== "object")
    throw new ToolSchemaError(tool.name, "/type");
  return visit(tool.parameters, "", 0);
}

function acceptsNull(schema: unknown): boolean {
  if (!object(schema)) return false;
  if (schema.anyOf instanceof Array) return schema.anyOf.some(acceptsNull);
  if (schema.const !== undefined) return schema.const === null;
  if (Array.isArray(schema.enum) && !schema.enum.includes(null)) return false;
  return (
    schema.type === "null" ||
    (Array.isArray(schema.type) && schema.type.includes("null"))
  );
}

function matchesType(schema: Schema, value: unknown): boolean {
  if (schema.const !== undefined && schema.const !== value) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (Array.isArray(schema.anyOf))
    return schema.anyOf.some((s) => object(s) && matchesType(s, value));
  const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
  return declared.some((t) =>
    t === "null"
      ? value === null
      : t === "object"
        ? object(value)
        : t === "array"
          ? Array.isArray(value)
          : t === "integer"
            ? Number.isInteger(value)
            : typeof value === t,
  );
}

/** Only wire-introduced null placeholders become omissions; never repair input. */
export function restoreToolArguments(
  schema: Schema,
  argumentsJson: string,
): string {
  const visit = (s: unknown, value: unknown): unknown => {
    if (!object(s)) return value;
    if (Array.isArray(s.anyOf)) {
      const candidates = s.anyOf
        .filter((b) => object(b) && matchesType(b, value))
        .map((b) => visit(b, value));
      if (
        candidates.length &&
        candidates.every(
          (v) => JSON.stringify(v) === JSON.stringify(candidates[0]),
        )
      )
        return candidates[0];
      return value;
    }
    if (object(value) && object(s.properties)) {
      const required = Array.isArray(s.required) ? s.required : [];
      return Object.fromEntries(
        Object.entries(value).flatMap(([key, v]) => {
          const child = Object.hasOwn(s.properties as Schema, key)
            ? (s.properties as Schema)[key]
            : undefined;
          if (
            child !== undefined &&
            v === null &&
            !required.includes(key) &&
            !acceptsNull(child)
          )
            return [];
          return [[key, visit(child, v)]];
        }),
      );
    }
    if (Array.isArray(value)) return value.map((v) => visit(s.items, v));
    return value;
  };
  try {
    return JSON.stringify(visit(schema, JSON.parse(argumentsJson)));
  } catch {
    return argumentsJson;
  }
}
