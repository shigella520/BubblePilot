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

/** Separates the readable message from "CODE · request id" diagnostics. */
export const diagnosticSeparator = "\n诊断：";

const hasChinese = (text: string) => /[\u3400-\u9fff]/u.test(text);

/** Readable fallback when the server message is not user-facing Chinese. */
function statusMessage(status: number): string {
  if (status === 401) return "登录已过期，请重新登录。";
  if (status === 403) return "需要敏感操作授权或没有权限执行该操作。";
  if (status === 404) return "对象不存在或已被删除，请刷新后重试。";
  if (status === 409) return "数据已被其他操作修改，请刷新后重试。";
  if (status === 413) return "提交的内容过大。";
  if (status === 400 || status === 422)
    return "提交的内容不符合要求，请检查后重试。";
  if (status === 429) return "操作太频繁，请稍后再试。";
  if (status >= 500) return "服务暂时不可用，请稍后重试。";
  return "请求未能完成。";
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    const knownMessages: Record<string, string> = {
      NETWORK_SETTINGS_CONFLICT:
        "外部网络配置已被其他操作修改，请刷新后重新编辑。",
      NETWORK_SETTINGS_MOVED: "可信域名已迁移，请到系统设置 → 外部网络修改。",
      NETWORK_SETTINGS_UNAVAILABLE: "外部网络配置暂不可用，请刷新重试。",
      TRIGGER_REFERENCED:
        "该触发器已有执行记录引用，不能直接删除。请先停用它；执行历史会保留以确保审计完整。",
      TRIGGER_NOT_FOUND: "触发器不存在，可能已被删除。",
      CHAT_PARTICIPANT_IDENTITIES_CONFLICT:
        "成员映射已被其他操作更新，请重新打开后再保存。",
      CHAT_PARTICIPANT_NOT_DISCOVERED:
        "成员映射中包含尚未在该聊天历史出现的发送者 ID。",
      MEMORY_CHAT_UNAVAILABLE: "请先启用该聊天的监听，再启用长期检索。",
      MEMORY_DISABLED: "该聊天未启用长期检索，或全局长期检索已关闭。",
      MEMORY_DATABASE_NOT_READY:
        "数据库尚未安装 pgvector，暂不能启用长期检索。",
      MEMORY_GENERATION_UNAVAILABLE: "请先配置并保存向量模型。",
      DATA_RETENTION_VERSION_CONFLICT:
        "数据保留设置已被其他操作修改，请刷新后重试。",
    };
    const known = knownMessages[cause.code];
    const message =
      known ??
      (hasChinese(cause.message) ? cause.message : statusMessage(cause.status));
    // Codes, request ids and untranslated server text are diagnostics only.
    const diagnostic = [
      cause.code,
      cause.correlationId,
      !known && !hasChinese(cause.message) && cause.message
        ? cause.message
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return diagnostic
      ? `${message}${diagnosticSeparator}${diagnostic}`
      : message;
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

export function notifySessionInvalidation(): void {
  sessionInvalidationHandler?.();
}
