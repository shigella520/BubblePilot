import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  apiRequest,
  downloadFile,
  isSessionInvalidationError,
  setSessionInvalidationHandler,
} from "../apps/web/src/services/api.js";

function errorResponse(code: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message: "Fictional authentication response.",
        correlationId: "00000000-0000-4000-8000-000000000001",
      },
    }),
    {
      status: 401,
      headers: { "content-type": "application/json" },
    },
  );
}

afterEach(() => {
  setSessionInvalidationHandler(null);
  vi.unstubAllGlobals();
});

describe("Web API session invalidation", () => {
  it("invalidates the local session for authenticated API requests", async () => {
    const invalidated = vi.fn();
    setSessionInvalidationHandler(invalidated);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(errorResponse("UNAUTHORIZED"))),
    );

    await expect(apiRequest("/api/v1/chats")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(invalidated).toHaveBeenCalledOnce();
  });

  it("invalidates the local session for protected downloads", async () => {
    const invalidated = vi.fn();
    setSessionInvalidationHandler(invalidated);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(errorResponse("UNAUTHORIZED"))),
    );

    await expect(
      downloadFile("/api/v1/exports/fictional/download"),
    ).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(invalidated).toHaveBeenCalledOnce();
  });

  it("keeps the current session when supplied credentials are invalid", async () => {
    const invalidated = vi.fn();
    setSessionInvalidationHandler(invalidated);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(errorResponse("INVALID_CREDENTIALS"))),
    );

    await expect(apiRequest("/api/v1/auth/sensitive")).rejects.toMatchObject({
      status: 401,
      code: "INVALID_CREDENTIALS",
    });
    expect(invalidated).not.toHaveBeenCalled();
  });

  it("classifies an invalidated session as a completed logout", () => {
    expect(
      isSessionInvalidationError(
        new ApiError(
          401,
          "UNAUTHORIZED",
          "Fictional expired session.",
          "00000000-0000-4000-8000-000000000001",
        ),
      ),
    ).toBe(true);
  });

  it("does not classify network and credential errors as completed logout", () => {
    expect(
      isSessionInvalidationError(new Error("Fictional network failure.")),
    ).toBe(false);
    expect(
      isSessionInvalidationError(
        new ApiError(
          401,
          "INVALID_CREDENTIALS",
          "Fictional invalid credentials.",
          null,
        ),
      ),
    ).toBe(false);
  });
});
