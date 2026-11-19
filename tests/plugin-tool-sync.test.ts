import { describe, it, expect } from "vitest";
import {
  compareTools,
  toolContractHash,
} from "../modules/plugins/plugin-tool-sync.js";
import type { ApprovedTool } from "../modules/plugins/plugin-types.js";
const tool = (): ApprovedTool => ({
  server: "fixture",
  hash: "old",
  definition: {
    name: "lookup",
    description: "\nRead fictional public data.\n",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
});
describe("approved tool compatibility", () => {
  it("keeps ordinary sandbox approval stable when image export transport appears", () => {
    const previous = tool();
    previous.definition.name = "prepare_sandbox";
    const upgraded = {
      ...previous,
      imageExportVersion: 1 as const,
      fileExportVersion: 1 as const,
    };
    expect(compareTools(previous, upgraded).kind).toBe("unchanged");
    expect(compareTools(upgraded, previous).kind).toBe("unchanged");
    expect(previous.imageExportVersion).toBeUndefined();
  });
  it("accepts legacy hashes, description edge whitespace and object key order", () => {
    const a = tool(),
      b = tool();
    b.hash = "new";
    b.definition.description = b.definition.description.trim();
    b.definition.parameters = {
      additionalProperties: false,
      required: ["query"],
      properties: { query: { type: "string" } },
      type: "object",
    };
    expect(toolContractHash(a)).toBe(toolContractHash(b));
    expect(compareTools(a, b).kind).toBe("format");
  });
  it("allows adding optional fields to a closed simple object", () => {
    const a = tool(),
      b = tool();
    (b.definition.parameters.properties as Record<string, unknown>).limit = {
      type: "integer",
      minimum: 1,
    };
    expect(compareTools(a, b)).toMatchObject({
      kind: "compatible",
      paths: ["/definition/parameters/properties/limit"],
    });
  });
  it.each([
    "required",
    "removed",
    "type",
    "description",
    "output",
    "complex",
    "server",
    "transfer",
    "open",
  ])("requires review for %s", (kind) => {
    const a = tool(),
      b = tool();
    switch (kind) {
      case "required":
        (b.definition.parameters as Record<string, unknown>).required = [
          "query",
          "limit",
        ];
        break;
      case "removed":
        (b.definition.parameters as Record<string, unknown>).properties = {};
        break;
      case "type":
        (b.definition.parameters as Record<string, unknown>).properties = {
          query: { type: "number" },
        };
        break;
      case "description":
        b.definition.description = "Upload private data.";
        break;
      case "output":
        b.outputSchema = { type: "string" };
        break;
      case "complex":
        (b.definition.parameters as Record<string, unknown>).allOf = [];
        break;
      case "server":
        b.server = "other";
        break;
      case "transfer":
        b.attachmentTransferVersion = 1;
        break;
      case "open":
        (
          a.definition.parameters as Record<string, unknown>
        ).additionalProperties = true;
        (
          b.definition.parameters as Record<string, unknown>
        ).additionalProperties = true;
        (b.definition.parameters.properties as Record<string, unknown>).limit =
          { type: "integer" };
        break;
    }
    expect(compareTools(a, b).kind).toBe("review");
  });
  it("does not normalize enum values, array order or user string contents", () => {
    const a = tool(),
      b = tool();
    (a.definition.parameters as Record<string, unknown>).properties = {
      query: { enum: [" x", "y"] },
    };
    (b.definition.parameters as Record<string, unknown>).properties = {
      query: { enum: ["x", "y"] },
    };
    expect(compareTools(a, b).kind).toBe("review");
    expect(compareTools(a).paths).toEqual(["/removed"]);
  });
});
