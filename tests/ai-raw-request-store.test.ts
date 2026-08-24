import { describe, expect, it } from "vitest";

import { AiRawRequestStore } from "../modules/ai/ai-raw-request-store.js";

describe("AiRawRequestStore", () => {
  it("keeps every request for the most recently active executions", () => {
    const store = new AiRawRequestStore(2);
    store.record("execution-a", "hash-a1", '{"request":"a1"}');
    store.record("execution-b", "hash-b1", '{"request":"b1"}');
    store.record("execution-a", "hash-a2", '{"request":"a2"}');
    store.record("execution-c", "hash-c1", '{"request":"c1"}');

    expect(store.get("execution-a", "hash-a1")).toBe('{"request":"a1"}');
    expect(store.get("execution-a", "hash-a2")).toBe('{"request":"a2"}');
    expect(store.reference("execution-b", "hash-b1")).toEqual({
      status: "unavailable",
    });
    expect(store.reference("execution-c", "hash-c1")).toEqual({
      status: "available",
    });
  });

  it("rejects invalid capacities", () => {
    expect(() => new AiRawRequestStore(0)).toThrow(
      "AI raw request execution limit must be positive.",
    );
  });
});
