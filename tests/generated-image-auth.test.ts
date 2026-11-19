import { it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { buildApplication } from "../app/application.js";
import { loadConfig } from "../app/config.js";
import { hashPassword } from "../app/security.js";
import { AuthService } from "../modules/auth/auth-service.js";
import type { GeneratedImageDelivery } from "../modules/generated-images/image-delivery.js";
import { InMemoryAuthRepository } from "./support/in-memory-auth-repository.js";
import { InMemoryArchiveRepository } from "./support/in-memory-archive-repository.js";
it.each(["png", "txt"])(
  "protects %s contents with sensitive authorization and audits successful reads",
  async (format) => {
    const login = "fictional-login",
      sensitive = "fictional-sensitive";
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://unused.example.test/test",
      API_ACCESS_TOKEN: "fictional-api-token-longer-than-thirty-two",
      APP_LOGIN_PASSWORD_HASH: await hashPassword(login),
      SENSITIVE_OPERATION_PASSWORD_HASH: await hashPassword(sensitive),
      BLUEBUBBLES_WEBHOOK_SECRET: "fictional-webhook-longer-than-thirty-two",
      BLUEBUBBLES_SERVER_URL: "https://example.test",
      BLUEBUBBLES_ACCESS_TOKEN: "fictional-gateway",
      LOG_LEVEL: "silent",
    });
    const repo = new InMemoryAuthRepository(),
      executionId = randomUUID(),
      artifactId = randomUUID();
    const read = vi.fn().mockResolvedValue({
      bytes: Buffer.from("fictional-file"),
      row: {
        filename: `fictional.${format}`,
        file_type: format,
        mime_type: format === "png" ? "image/png" : "text/plain",
      },
    });
    const delivery = {
      start: vi.fn(),
      stop: vi.fn(),
      store: {
        list: vi.fn().mockResolvedValue([{ id: artifactId, state: "bound" }]),
        read,
      },
    } as unknown as GeneratedImageDelivery;
    const auth = new AuthService(repo, {
      loginPasswordHash: config.loginPasswordHash,
      sensitiveOperationPasswordHash: config.sensitiveOperationPasswordHash,
      sessionTtlSeconds: 43200,
      sensitiveOperationTtlSeconds: 300,
    });
    const app = buildApplication(config, new InMemoryArchiveRepository(), {
      logger: false,
      webRoot: false,
      auth,
      imageDelivery: delivery,
    });
    const path = `/api/v1/executions/${executionId}/generated-images/${artifactId}/content`;
    try {
      expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(
        401,
      );
      const logged = await app.inject({
        method: "POST",
        url: "/api/v1/auth/session",
        payload: { password: login },
      });
      const headers = {
        cookie: logged.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        origin: "http://localhost",
      };
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/v1/executions/${executionId}/generated-images`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: "GET", url: path, headers })).statusCode,
      ).toBe(403);
      expect(read).not.toHaveBeenCalled();
      const unlock = await app.inject({
        method: "POST",
        url: "/api/v1/auth/sensitive",
        headers,
        payload: { password: sensitive },
      });
      expect(unlock.statusCode).toBe(200);
      const result = await app.inject({ method: "GET", url: path, headers });
      expect(result.statusCode).toBe(200);
      expect(result.headers["content-disposition"]).toContain("attachment;");
      expect(result.headers["content-type"]).toContain(
        format === "png" ? "image/png" : "text/plain",
      );
      expect(result.headers["cache-control"]).toContain("no-store");
      expect(result.headers["x-content-type-options"]).toBe("nosniff");
      expect(read).toHaveBeenLastCalledWith(artifactId, executionId);
      read.mockRejectedValueOnce(new Error("missing"));
      expect(
        (await app.inject({ method: "GET", url: path, headers })).statusCode,
      ).toBe(404);
      expect(
        repo.auditEvents.some((e) => e.action === "generated-image.read"),
      ).toBe(true);
    } finally {
      await app.close();
    }
  },
);
