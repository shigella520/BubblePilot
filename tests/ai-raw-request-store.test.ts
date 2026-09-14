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

  it("isolates responses for identical requests and evicts them with their execution", () => {
    const store = new AiRawRequestStore(1);
    store.record("a", "same-hash", "request");
    store.recordResponse(
      "a",
      "attempt1",
      '{"error":{"message":"fixture bad parameter","code":"bad","type":"invalid","param":"tools"}}',
      400,
      new Headers({ "x-request-id": "fixture-id", "set-cookie": "private" }),
    );
    store.recordResponse(
      "a",
      "attempt2",
      "<html>Service unavailable</html>",
      503,
      new Headers(),
    );
    expect(store.getResponse("a", "attempt1")).toMatchObject({
      httpStatus: 400,
      error: {
        message: "fixture bad parameter",
        code: "bad",
        type: "invalid",
        param: "tools",
      },
      requestIds: { "x-request-id": "fixture-id" },
    });
    expect(JSON.stringify(store.getResponse("a", "attempt1"))).not.toContain(
      "private",
    );
    expect(store.getResponse("a", "attempt2")?.body).toBe(
      "<html>Service unavailable</html>",
    );
    store.recordResponse("a", "empty", "", 503, new Headers());
    expect(store.getResponse("a", "empty")?.body).toBe("");
    store.recordResponse("a", "large", "中".repeat(30000), 503, new Headers());
    const large = store.getResponse("a", "large")!;
    expect(large.truncated).toBe(true);
    expect(large.bytes).toBe(90000);
    expect(Buffer.byteLength(large.body)).toBeLessThanOrEqual(65536);
    expect(large.body).not.toContain("�");
    store.record("b", "other", "request");
    store.recordResponse("a", "late", "late", 200, new Headers());
    expect(store.getResponse("a", "attempt1")).toBeNull();
    expect(store.getResponse("a", "late")).toBeNull();
  });

  it("rejects invalid capacities", () => {
    expect(() => new AiRawRequestStore(0)).toThrow(
      "AI raw request execution limit must be positive.",
    );
  });
});
