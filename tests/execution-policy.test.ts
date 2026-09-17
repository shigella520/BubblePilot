import { describe, it, expect } from "vitest";
import {
  executionPolicy,
  resolveGenerationPolicy,
  generationLengthInstruction,
} from "../modules/ai/execution-policy.js";
import { workflowDefinitionSchema } from "../modules/workflow/workflow-definition.js";
import {
  chatExcerptSchema,
  memorySearchSchema,
} from "../modules/memory/memory-types.js";
import { fitToolOutput } from "../modules/ai/agent-budget.js";

describe("generation and retrieval policy", () => {
  const definition = (config: Record<string, unknown>) => ({
    schemaVersion: "1",
    name: "fictional",
    startNodeId: "ai",
    nodes: [
      {
        id: "ai",
        type: "ai-chat",
        version: 1,
        config: {
          providerRouteId: "11111111-1111-4111-8111-111111111111",
          promptTemplate: "虚构问题",
          ...config,
        },
        onSuccess: "done",
      },
      { id: "done", type: "end", version: 1, config: { result: "succeeded" } },
    ],
  });
  it("preserves omitted legacy limits and explicitly opts into new defaults", () => {
    expect(resolveGenerationPolicy({})).toMatchObject({
      maxOutputTokens: 1024,
      maxOutputCharacters: 4000,
    });
    expect(
      resolveGenerationPolicy({
        targetOutputCharacters: executionPolicy.chat.targetCharacters,
      }),
    ).toMatchObject({ maxOutputTokens: 8192, maxOutputCharacters: 6000 });
    expect(
      workflowDefinitionSchema.safeParse(
        definition({ targetOutputCharacters: 2000 }),
      ).success,
    ).toBe(true);
    expect(
      workflowDefinitionSchema.safeParse(
        definition({ targetOutputCharacters: 2000, maxOutputCharacters: 4000 }),
      ).success,
    ).toBe(false);
    expect(
      workflowDefinitionSchema.safeParse(
        definition({ targetOutputCharacters: 4001 }),
      ).success,
    ).toBe(false);
    expect(generationLengthInstruction(2000)).toContain("JSON");
  });
  it("validates retrieval limits and zero-sided expansion", () => {
    expect(chatExcerptSchema.parse({ ref: "M1" })).toEqual({
      ref: "M1",
      before: 8,
      after: 8,
    });
    expect(
      chatExcerptSchema.parse({ ref: "M1", before: 0, after: 20 }).before,
    ).toBe(0);
    expect(chatExcerptSchema.safeParse({ ref: "M1", before: 21 }).success).toBe(
      false,
    );
    expect(
      memorySearchSchema.safeParse({ query: "虚构", limit: 20 }).success,
    ).toBe(true);
    expect(
      memorySearchSchema.safeParse({ query: "虚构", limit: 21 }).success,
    ).toBe(false);
  });
  it("keeps complete evidence and updates returned count on budget fitting", () => {
    const result = fitToolOutput(
      JSON.stringify({
        status: "succeeded",
        returnedCount: 2,
        evidence: [
          { ref: "M1", text: "甲".repeat(100) },
          { ref: "M2", text: "乙".repeat(100) },
        ],
      }),
      270,
    );
    expect(result.truncated).toBe(true);
    const payload = JSON.parse(result.content!) as {
      returnedCount: number;
      evidence: { ref: string; text: string }[];
    };
    expect(payload.returnedCount).toBe(payload.evidence.length);
    expect(payload.evidence[0]).toEqual({ ref: "M1", text: "甲".repeat(100) });
  });
});
