export interface AiRawRequestReference {
  status: "available" | "unavailable";
}

export interface StoredAiResponse {
  body: string;
  bytes: number;
  truncated: boolean;
  httpStatus: number;
  error: Record<string, string>;
  requestIds: Record<string, string>;
}

interface StoredExecutionRequests {
  readonly responses: Map<string, StoredAiResponse>;
  readonly requests: Map<string, string>;
}

/**
 * Process-local diagnostic storage. Request and response bodies are deliberately kept out
 * of repositories, logs, and audit metadata.
 */
export class AiRawRequestStore {
  private readonly executions = new Map<string, StoredExecutionRequests>();

  constructor(private readonly executionLimit = 20) {
    if (!Number.isInteger(executionLimit) || executionLimit < 1) {
      throw new Error("AI raw request execution limit must be positive.");
    }
  }

  record(executionId: string, requestHash: string, requestBody: string): void {
    let execution = this.executions.get(executionId);
    if (execution === undefined) {
      execution = { requests: new Map(), responses: new Map() };
    } else {
      this.executions.delete(executionId);
    }
    this.executions.set(executionId, execution);
    while (this.executions.size > this.executionLimit) {
      const oldestExecutionId = this.executions.keys().next().value;
      if (oldestExecutionId === undefined) break;
      this.executions.delete(oldestExecutionId);
    }
    execution.requests.set(requestHash, requestBody);
  }

  recordResponse(
    executionId: string,
    clientRequestId: string,
    body: string,
    httpStatus: number,
    headers: Headers,
  ): void {
    // Do not resurrect an execution evicted while its request was in flight.
    const execution = this.executions.get(executionId);
    if (!execution || !clientRequestId) return;
    const bytes = Buffer.from(body, "utf8");
    const limit = 64 * 1024;
    let retained = bytes.subarray(0, limit);
    if (bytes.length > limit) {
      let end = limit;
      while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
      retained = bytes.subarray(0, end);
    }
    const error: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(body);
      const candidate =
        parsed && typeof parsed === "object" && "error" in parsed
          ? parsed.error
          : null;
      if (typeof candidate === "string")
        error.message = candidate.slice(0, 2000);
      else if (candidate && typeof candidate === "object") {
        for (const key of ["message", "code", "type", "param"]) {
          const value = (candidate as Record<string, unknown>)[key];
          if (typeof value === "string" || typeof value === "number")
            error[key] = String(value).slice(0, 2000);
        }
      }
    } catch {
      /* Non-JSON responses remain available as plain text. */
    }
    const requestIds: Record<string, string> = {};
    for (const key of [
      "x-request-id",
      "request-id",
      "openai-request-id",
      "cf-ray",
      "x-amzn-requestid",
      "x-ms-request-id",
    ]) {
      const value = headers.get(key)?.trim();
      if (value) requestIds[key] = value.slice(0, 512);
    }
    execution.responses.set(clientRequestId, {
      body: retained.toString("utf8"),
      bytes: bytes.length,
      truncated: bytes.length > limit,
      httpStatus,
      error,
      requestIds,
    });
  }

  getResponse(
    executionId: string,
    clientRequestId: string,
  ): StoredAiResponse | null {
    return (
      this.executions.get(executionId)?.responses.get(clientRequestId) ?? null
    );
  }

  reference(executionId: string, requestHash: string): AiRawRequestReference {
    return {
      status:
        this.get(executionId, requestHash) === null
          ? "unavailable"
          : "available",
    };
  }

  get(executionId: string, requestHash: string): string | null {
    return this.executions.get(executionId)?.requests.get(requestHash) ?? null;
  }
}
