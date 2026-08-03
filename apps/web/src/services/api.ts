export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    correlationId?: string;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly correlationId: string | null,
  ) {
    super(message);
  }
}

export function isSessionInvalidationError(cause: unknown): cause is ApiError {
  return (
    cause instanceof ApiError &&
    cause.status === 401 &&
    cause.code === "UNAUTHORIZED"
  );
}

type SessionInvalidationHandler = () => void;

let sessionInvalidationHandler: SessionInvalidationHandler | null = null;

export function setSessionInvalidationHandler(
  handler: SessionInvalidationHandler | null,
): () => void {
  sessionInvalidationHandler = handler;
  return () => {
    if (sessionInvalidationHandler === handler) {
      sessionInvalidationHandler = null;
    }
  };
}

async function responseError(response: Response): Promise<ApiError> {
  const payload = (await response.json().catch(() => ({}))) as ApiErrorBody;
  const error = new ApiError(
    response.status,
    payload.error?.code ?? "REQUEST_FAILED",
    payload.error?.message ?? "请求未能完成。",
    payload.error?.correlationId ?? null,
  );
  if (isSessionInvalidationError(error)) {
    sessionInvalidationHandler?.();
  }
  return error;
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw await responseError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const payload = (await response.json()) as { data: T };
  return payload.data;
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JSON 顶层必须是对象。");
  }
  return parsed as Record<string, unknown>;
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.correlationId === null
      ? cause.message
      : `${cause.message}（${cause.code} · ${cause.correlationId}）`;
  }
  return cause instanceof Error ? cause.message : "请求未能完成。";
}

export async function downloadFile(
  path: string,
): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) {
    throw await responseError(response);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/u.exec(disposition);
  return {
    blob: await response.blob(),
    filename: match?.[1] ?? "bubblepilot-export.jsonl",
  };
}
