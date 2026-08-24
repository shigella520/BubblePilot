export interface AiRawRequestReference {
  status: "available" | "unavailable";
}

interface StoredExecutionRequests {
  readonly requests: Map<string, string>;
}

/**
 * Process-local diagnostic storage. Request bodies are deliberately kept out
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
      execution = { requests: new Map() };
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
