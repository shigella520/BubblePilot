import {
  ApiError,
  isSessionInvalidationError,
  notifySessionInvalidation,
  type ApiErrorBody,
} from "./api";
/** Multipart upload with progress; use the same session invalidation contract. */
export function apiUpload<T>(
  path: string,
  body: FormData,
  onProgress: (percent: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", path);
    request.withCredentials = true;
    request.timeout = 60_000;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () =>
      reject(new Error("上传连接失败，请刷新列表确认后重试。"));
    request.ontimeout = () =>
      reject(new Error("上传超时，请刷新列表确认结果。"));
    request.onload = () => {
      try {
        const payload = JSON.parse(request.responseText) as ApiErrorBody & {
          data: T;
        };
        if (request.status >= 200 && request.status < 300)
          resolve(payload.data);
        else {
          const error = new ApiError(
            request.status,
            payload.error?.code ?? "UPLOAD_FAILED",
            payload.error?.message ?? "上传失败。",
            null,
          );
          if (isSessionInvalidationError(error)) notifySessionInvalidation();
          reject(error);
        }
      } catch {
        reject(new Error("上传响应无效，请刷新列表确认结果。"));
      }
    };
    request.send(body);
  });
}
