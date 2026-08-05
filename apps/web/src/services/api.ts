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

async function apiPayload<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  return (await response.json()) as T;
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const payload = await apiPayload<{ data: T }>(path, init);
  return payload.data;
}

export interface ApiPage<T> {
  data: T;
  page: { nextCursor: string | null };
}

export function apiPageRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiPage<T>> {
  return apiPayload<ApiPage<T>>(path, init);
}

export async function apiAllPages<T>(
  path: string,
  init: RequestInit = {},
): Promise<T[]> {
  const url = new URL(path, "http://bubblepilot.local");
  const data: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    if (cursor === null) url.searchParams.delete("cursor");
    else url.searchParams.set("cursor", cursor);
    const page = await apiPageRequest<T[]>(
      `${url.pathname}${url.search}`,
      init,
    );
    data.push(...page.data);
    cursor = page.page.nextCursor;
    if (cursor !== null) {
      if (seenCursors.has(cursor)) {
        throw new Error("分页接口返回了重复游标。");
      }
      seenCursors.add(cursor);
    }
  } while (cursor !== null);
  return data;
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
    const knownMessages: Record<string, string> = {
      TRIGGER_REFERENCED:
        "该触发器已有执行记录引用，不能直接删除。请先停用它；执行历史会保留以确保审计完整。",
      TRIGGER_NOT_FOUND: "触发器不存在，可能已被删除。",
      INVALID_WORKFLOW_DEFINITION: "工作流配置无效，请检查节点连接和必填项。",
    };
    const message = knownMessages[cause.code] ?? cause.message;
    return cause.correlationId === null
      ? message
      : `${message}（${cause.code} · ${cause.correlationId}）`;
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
