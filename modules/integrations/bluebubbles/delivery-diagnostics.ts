import type { SendReplyCommand } from "./reply-gateway.js";

export interface DeliveryDiagnostic {
  event: "bluebubbles.delivery-diagnostic";
  kind: "text" | "attachment";
  method: "apple-script" | "private-api";
  correlationId: string | null;
  providerTempGuid: string | null;
  stage:
    | "prepare"
    | "request"
    | "http-status"
    | "response-body"
    | "response-json"
    | "receipt";
  code: string;
  durationMs: number;
  timeoutMs: number;
  timedOut: boolean;
  httpStatus: number | null;
  responseBytes: number | null;
  errorName: string | null;
  causeCodes: string[];
}

export type DeliveryDiagnosticSink = (diagnostic: DeliveryDiagnostic) => void;

// Never copy arbitrary exception messages, names, codes or nested objects to logs.
const errorNames = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "AbortError",
  "TimeoutError",
  "AggregateError",
]);
const causeCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNABORTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "UND_ERR_RESPONSE_STATUS_CODE",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
]);

function safeCauseCodes(error: unknown): string[] {
  const codes = new Set<string>();
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  for (let i = 0; i < pending.length && i < 8; i++) {
    const value = pending[i];
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (
      "code" in value &&
      typeof value.code === "string" &&
      causeCodes.has(value.code)
    )
      codes.add(value.code);
    if ("cause" in value) pending.push(value.cause);
    if (value instanceof AggregateError) {
      const nested: unknown[] = value.errors;
      pending.push(...nested.slice(0, 8));
    }
  }
  return [...codes];
}

const safeId = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;

export class DeliveryDiagnostics {
  stage: DeliveryDiagnostic["stage"] = "prepare";
  httpStatus: number | null = null;
  responseBytes: number | null = null;
  private readonly startedAt = performance.now();

  constructor(
    private readonly kind: DeliveryDiagnostic["kind"],
    private readonly method: DeliveryDiagnostic["method"],
    private readonly command: Pick<
      SendReplyCommand,
      "correlationId" | "providerTempGuid"
    >,
    private readonly timeoutMs: number,
    private readonly signal: AbortSignal,
    private readonly sink?: DeliveryDiagnosticSink,
  ) {}

  async readJson(response: Response): Promise<unknown> {
    this.stage = "response-body";
    const body = await response.text();
    this.responseBytes = Buffer.byteLength(body);
    this.stage = "response-json";
    const parsed: unknown = JSON.parse(body);
    this.stage = "receipt";
    return parsed;
  }

  report(code: string, error?: unknown): void {
    try {
      this.sink?.({
        event: "bluebubbles.delivery-diagnostic",
        kind: this.kind,
        method: this.method,
        correlationId: safeId(this.command.correlationId),
        providerTempGuid: safeId(this.command.providerTempGuid),
        stage: this.stage,
        code,
        durationMs: Math.round(performance.now() - this.startedAt),
        timeoutMs: this.timeoutMs,
        timedOut:
          this.signal.aborted ||
          (error instanceof Error && error.name === "AbortError"),
        httpStatus: this.httpStatus,
        responseBytes: this.responseBytes,
        errorName:
          error === undefined
            ? null
            : error instanceof Error && errorNames.has(error.name)
              ? error.name
              : "Other",
        causeCodes: safeCauseCodes(error),
      });
    } catch {
      // Diagnostics must never change delivery status or cause another send.
    }
  }
}
