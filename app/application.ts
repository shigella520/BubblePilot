import { randomUUID } from "node:crypto";

import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import { z, ZodError } from "zod";

import type { ArchiveRepository } from "../modules/archive/archive-repository.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import { IngestionService } from "../modules/ingestion/ingestion-service.js";
import type { AppConfig } from "./config.js";
import { ApplicationError } from "./errors.js";
import { decodeCursor, encodeCursor } from "./pagination.js";
import { readBearerToken, secretsEqual } from "./security.js";

const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

const chatParametersSchema = z.object({
  chatId: z.string().uuid(),
});

export interface ApplicationOptions {
  logger?: boolean;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function webhookToken(request: FastifyRequest): string | undefined {
  const headerToken = firstHeader(
    request.headers["x-bubblepilot-webhook-secret"],
  );
  if (headerToken !== undefined) {
    return headerToken;
  }

  if (
    request.query !== null &&
    typeof request.query === "object" &&
    "token" in request.query
  ) {
    const token = (request.query as { token?: unknown }).token;
    return typeof token === "string" ? token : undefined;
  }

  return undefined;
}

function clientErrorStatus(error: unknown): number | null {
  if (error === null || typeof error !== "object" || !("statusCode" in error)) {
    return null;
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500
    ? statusCode
    : null;
}

export function buildApplication(
  config: AppConfig,
  repository: ArchiveRepository,
  options: ApplicationOptions = {},
): FastifyInstance {
  const application = Fastify({
    bodyLimit: config.webhookBodyLimitBytes,
    genReqId: () => randomUUID(),
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? { level: config.logLevel },
  });
  const ingestion = new IngestionService(
    new BlueBubblesWebhookAdapter(),
    repository,
    config.monitoredChatIds,
  );

  application.setErrorHandler((error, request, reply) => {
    if (error instanceof ApplicationError) {
      void reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          correlationId: request.id,
        },
      });
      return;
    }

    if (error instanceof ZodError) {
      void reply.status(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "The request parameters are invalid.",
          correlationId: request.id,
        },
      });
      return;
    }

    const statusCode = clientErrorStatus(error);
    if (statusCode !== null) {
      void reply.status(statusCode).send({
        error: {
          code:
            statusCode === 413
              ? "WEBHOOK_PAYLOAD_TOO_LARGE"
              : "INVALID_REQUEST",
          message:
            statusCode === 413
              ? "The request body exceeds the configured limit."
              : "The request could not be parsed.",
          correlationId: request.id,
        },
      });
      return;
    }

    request.log.error(
      { err: error, correlationId: request.id },
      "Request failed",
    );
    void reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
        correlationId: request.id,
      },
    });
  });

  application.get("/health/live", () => ({ status: "ok" }));

  application.get("/health/ready", async (_request, reply) => {
    const ready = await repository.isReady();
    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? "ready" : "unavailable" });
  });

  application.post("/api/v1/webhooks/bluebubbles", async (request, reply) => {
    if (!secretsEqual(webhookToken(request), config.blueBubblesWebhookSecret)) {
      throw new ApplicationError(
        "INVALID_WEBHOOK_SECRET",
        "Webhook authentication failed.",
        401,
      );
    }

    const result = await ingestion.ingest(request.body, request.id);
    request.log.info(
      {
        correlationId: result.correlationId,
        eventId: result.eventId,
        ingestionStatus: result.status,
        messageId: result.messageId,
      },
      "BlueBubbles webhook processed",
    );

    return reply.status(202).send({ data: result });
  });

  const requireApiToken = (request: FastifyRequest): Promise<void> => {
    const candidate = readBearerToken(request.headers.authorization);
    if (!secretsEqual(candidate, config.apiAccessToken)) {
      return Promise.reject(
        new ApplicationError(
          "UNAUTHORIZED",
          "A valid API access token is required.",
          401,
        ),
      );
    }
    return Promise.resolve();
  };

  application.get(
    "/api/v1/chats",
    { preHandler: requireApiToken },
    async (request) => {
      const query = pageQuerySchema.parse(request.query);
      const chats = await repository.listChats({
        limit: query.limit,
        cursor: decodeCursor(query.cursor),
      });
      const last = chats.at(-1);
      return {
        data: chats,
        page: {
          nextCursor: encodeCursor(
            last === undefined
              ? undefined
              : { timestamp: last.updatedAt, id: last.id },
          ),
        },
      };
    },
  );

  application.get(
    "/api/v1/chats/:chatId/messages",
    { preHandler: requireApiToken },
    async (request) => {
      const parameters = chatParametersSchema.parse(request.params);
      const query = pageQuerySchema.parse(request.query);
      const messages = await repository.listMessages(parameters.chatId, {
        limit: query.limit,
        cursor: decodeCursor(query.cursor),
      });
      const last = messages.at(-1);
      return {
        data: messages,
        page: {
          nextCursor: encodeCursor(
            last === undefined
              ? undefined
              : { timestamp: last.sentAt, id: last.id },
          ),
        },
      };
    },
  );

  application.addHook("onClose", async () => {
    await repository.close();
  });

  return application;
}
