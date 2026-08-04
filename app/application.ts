import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import { z, ZodError } from "zod";

import type { AiManagementService } from "../modules/ai/ai-management-service.js";
import type {
  AiMutationResult,
  AiRepository,
} from "../modules/ai/ai-repository.js";
import {
  aiProviderConfigurationSchema,
  aiProviderEnabledSchema,
  aiProviderReorderSchema,
  aiProviderUpdateSchema,
  aiRouteConfigurationSchema,
  aiRouteEnabledSchema,
  aiRouteUpdateSchema,
} from "../modules/ai/ai-types.js";
import type {
  ArchiveRepository,
  AutomationOutcome,
} from "../modules/archive/archive-repository.js";
import type { MessageRetentionWorker } from "../modules/archive/message-retention-service.js";
import type { AuthService } from "../modules/auth/auth-service.js";
import type {
  AdminPrincipal,
  AdminSessionView,
  AuditOutcome,
} from "../modules/auth/auth-types.js";
import type { DataExportRepository } from "../modules/export/export-repository.js";
import type { DataExportService } from "../modules/export/export-service.js";
import {
  dataExportConfirmSchema,
  dataExportScopeSchema,
  type DataExportMutationResult,
  type DataExportOwner,
  type DataExportReadResult,
} from "../modules/export/export-types.js";
import { BlueBubblesWebhookAdapter } from "../modules/integrations/bluebubbles/webhook-adapter.js";
import type { BlueBubblesSettingsService } from "../modules/integrations/bluebubbles/settings-service.js";
import { blueBubblesSettingsUpdateSchema } from "../modules/integrations/bluebubbles/settings-types.js";
import { IngestionService } from "../modules/ingestion/ingestion-service.js";
import { FixedWindowRateLimiter } from "../modules/reliability/rate-limiter.js";
import { WorkflowCapacityError } from "../modules/workflow/execution-gate.js";
import { listActionBlockDefinitions } from "../modules/workflow/action-blocks.js";
import type { WorkflowExecutionDispatcher } from "../modules/workflow/execution-dispatcher.js";
import { findPotentialTriggerConflicts } from "../modules/workflow/trigger-conflicts.js";
import {
  matchTrigger,
  parseTriggerConditions,
} from "../modules/workflow/trigger-matcher.js";
import { parseWorkflowDefinition } from "../modules/workflow/workflow-definition.js";
import { validateWorkflowGraph } from "../modules/workflow/workflow-graph.js";
import type { MessageAutomation } from "../modules/workflow/workflow-engine.js";
import type {
  ExecutionRecoveryClaim,
  WorkflowExecutionStatus,
  WorkflowRepository,
} from "../modules/workflow/workflow-repository.js";
import type { MessageEnvelope } from "../modules/ingestion/message-envelope.js";
import type { AppConfig } from "./config.js";
import { sha256 } from "./canonical-json.js";
import { ApplicationError } from "./errors.js";
import { decodeCursor, encodeCursor } from "./pagination.js";
import { readBearerToken, secretsEqual } from "./security.js";

const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

const workflowExecutionStatusSchema = z.enum([
  "created",
  "running",
  "retrying",
  "succeeded",
  "skipped",
  "failed",
  "dead-lettered",
  "closed",
]);

const executionListQuerySchema = pageQuerySchema.extend({
  status: z.string().min(1).max(200).optional(),
});

const chatParametersSchema = z.object({
  chatId: z.string().uuid(),
});

const workflowParametersSchema = z.object({
  workflowId: z.string().uuid(),
});

const workflowVersionParametersSchema = workflowParametersSchema.extend({
  version: z.coerce.number().int().positive(),
});

const triggerParametersSchema = z.object({ triggerId: z.string().uuid() });
const executionParametersSchema = z.object({ executionId: z.string().uuid() });
const aiProviderParametersSchema = z.object({ providerId: z.string().uuid() });
const aiRouteParametersSchema = z.object({ routeId: z.string().uuid() });
const dataExportParametersSchema = z.object({ exportId: z.string().uuid() });
const expectedVersionQuerySchema = z.object({
  expectedVersion: z.coerce.number().int().positive(),
});

const passwordBodySchema = z.object({
  password: z.string().min(1).max(1_024),
});

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const chatMonitoringBodySchema = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().positive(),
});

const messageSearchQuerySchema = pageQuerySchema
  .extend({
    chatId: z.string().uuid().optional(),
    q: z.string().trim().min(1).max(200).optional(),
    senderId: z.string().trim().min(1).max(500).optional(),
    sentFrom: z.string().datetime({ offset: true }).optional(),
    sentTo: z.string().datetime({ offset: true }).optional(),
  })
  .refine(
    (value) =>
      value.sentFrom === undefined ||
      value.sentTo === undefined ||
      Date.parse(value.sentFrom) <= Date.parse(value.sentTo),
    { message: "sentFrom must not be later than sentTo." },
  );

const workflowBodySchema = z.object({
  name: z.string().min(1).max(120),
  definition: z.unknown(),
});

const workflowVersionBodySchema = z.object({ definition: z.unknown() });

const triggerBodySchema = z.object({
  name: z.string().min(1).max(120),
  workflowId: z.string().uuid(),
  workflowVersion: z.number().int().positive(),
  conditions: z.unknown(),
  includeFromMe: z.literal(false).default(false),
  enabled: z.boolean().default(false),
});

const triggerStatusBodySchema = z.object({ enabled: z.boolean() });
const triggerUpdateBodySchema = triggerBodySchema.pick({
  name: true,
  conditions: true,
  includeFromMe: true,
});

const triggerPreviewBodySchema = z.object({
  conditions: z.unknown(),
  includeFromMe: z.boolean().default(false),
  sample: z.object({
    providerChatId: z.string().min(1),
    senderId: z.string().nullable(),
    sentAt: z.string().datetime({ offset: true }).optional(),
    contentType: z.enum(["text", "attachment", "mixed", "unknown"]),
    text: z.string().nullable(),
    isFromMe: z.boolean().default(false),
  }),
});

export interface ApplicationOptions {
  logger?: boolean;
  auth?: AuthService;
  ai?: {
    repository: AiRepository;
    management: AiManagementService;
  };
  workflow?: {
    repository: WorkflowRepository;
    engine: MessageAutomation;
    dispatcher?: WorkflowExecutionDispatcher;
  };
  dataExport?: {
    repository: DataExportRepository;
    service: DataExportService;
  };
  blueBubbles?: {
    settings: BlueBubblesSettingsService;
  };
  messageRetention?: MessageRetentionWorker;
}

function aiMutationValue<T>(
  result: AiMutationResult<T>,
  notFoundCode: string,
  notFoundMessage: string,
): T {
  if (result.status === "ok") {
    return result.value;
  }
  if (result.status === "not-found") {
    throw new ApplicationError(notFoundCode, notFoundMessage, 404);
  }
  throw new ApplicationError("AI_CONFIGURATION_CONFLICT", result.reason, 409);
}

function dataExportMutationValue(
  result: DataExportMutationResult,
): DataExportMutationResult & { status: "ok" } {
  if (result.status === "ok") return result;
  if (result.status === "not-found") {
    throw new ApplicationError(
      "DATA_EXPORT_NOT_FOUND",
      "The data export does not exist or is unavailable.",
      404,
    );
  }
  if (result.status === "expired") {
    throw new ApplicationError(
      "DATA_EXPORT_EXPIRED",
      "The data export has expired; create a new preview.",
      410,
    );
  }
  throw new ApplicationError("DATA_EXPORT_CONFLICT", result.reason, 409);
}

function dataExportReadValue(
  result: DataExportReadResult,
): Extract<DataExportReadResult, { status: "ok" }> {
  if (result.status === "ok") return result;
  if (result.status === "expired") {
    throw new ApplicationError(
      "DATA_EXPORT_EXPIRED",
      "The data export has expired; create a new preview.",
      410,
    );
  }
  if (result.status === "not-ready") {
    throw new ApplicationError(
      "DATA_EXPORT_NOT_READY",
      "The data export must be confirmed before download.",
      409,
    );
  }
  if (result.status === "conflict") {
    throw new ApplicationError(
      "DATA_EXPORT_SNAPSHOT_CONFLICT",
      "The export snapshot changed; create a new preview.",
      409,
    );
  }
  throw new ApplicationError(
    "DATA_EXPORT_NOT_FOUND",
    "The data export does not exist or is unavailable.",
    404,
  );
}

function executionStatuses(
  value: string | undefined,
): WorkflowExecutionStatus[] {
  if (value === undefined) return [];
  return z
    .array(workflowExecutionStatusSchema)
    .min(1)
    .max(8)
    .parse([...new Set(value.split(",").map((status) => status.trim()))]);
}

function executionRecoveryError(
  result: Exclude<ExecutionRecoveryClaim, { status: "created" }>,
): never {
  if (result.status === "not-found") {
    throw new ApplicationError(
      "EXECUTION_NOT_FOUND",
      "The workflow execution does not exist.",
      404,
    );
  }
  const errors = {
    "execution-not-recoverable": [
      "EXECUTION_NOT_RECOVERABLE",
      "Only failed, dead-lettered, or stale retrying executions can be retried.",
    ],
    "execution-retry-still-active": [
      "EXECUTION_RETRY_STILL_ACTIVE",
      "The scheduled retry is still active and cannot be recovered manually yet.",
    ],
    "recovery-already-created": [
      "EXECUTION_RECOVERY_ALREADY_CREATED",
      "A recovery execution has already been created for this execution.",
    ],
    "source-message-unavailable": [
      "EXECUTION_SOURCE_UNAVAILABLE",
      "The locked source message or workflow version is unavailable.",
    ],
    "outbound-result-unknown": [
      "EXECUTION_OUTBOUND_RESULT_UNKNOWN",
      "The outbound result is unknown and must not be resent blindly.",
    ],
    "outbound-already-confirmed": [
      "EXECUTION_OUTBOUND_ALREADY_CONFIRMED",
      "The execution already has a confirmed outbound delivery.",
    ],
  } as const;
  const [code, message] = errors[result.reason];
  throw new ApplicationError(code, message, 409);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const adminSessionCookieName = "bubblepilot_session";

function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (cookieHeader === undefined) {
    return undefined;
  }
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = item.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function secureSessionCookie(
  config: AppConfig,
  request: FastifyRequest,
): boolean {
  if (config.sessionCookieSecure !== "auto") {
    return config.sessionCookieSecure === "true";
  }
  const forwardedProtocol = firstHeader(request.headers["x-forwarded-proto"])
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  return forwardedProtocol === "https" || request.protocol === "https";
}

function sessionCookie(
  config: AppConfig,
  request: FastifyRequest,
  token: string,
): string {
  const secure = secureSessionCookie(config, request) ? "; Secure" : "";
  return `${adminSessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.adminSessionTtlSeconds}${secure}`;
}

function expiredSessionCookie(
  config: AppConfig,
  request: FastifyRequest,
): string {
  const secure = secureSessionCookie(config, request) ? "; Secure" : "";
  return `${adminSessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
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

function workflowDefinition(value: unknown) {
  try {
    return parseWorkflowDefinition(value);
  } catch (error) {
    throw new ApplicationError(
      "INVALID_WORKFLOW_DEFINITION",
      error instanceof Error ? error.message : "The workflow is invalid.",
      400,
      { cause: error },
    );
  }
}

function triggerConditions(value: unknown) {
  try {
    return parseTriggerConditions(value);
  } catch (error) {
    throw new ApplicationError(
      "INVALID_TRIGGER_CONDITIONS",
      error instanceof Error ? error.message : "The trigger is invalid.",
      400,
      { cause: error },
    );
  }
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
  const webRoot = resolve(process.cwd(), "public");
  if (existsSync(webRoot)) {
    void application.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
      index: ["index.html"],
      wildcard: false,
    });
  }
  const ingestion = new IngestionService(
    new BlueBubblesWebhookAdapter(),
    repository,
    config.monitoredChatIds,
  );
  const adminRateLimiter = new FixedWindowRateLimiter(
    config.adminRateLimitMax,
    config.rateLimitWindowSeconds * 1_000,
  );
  const webhookRateLimiter = new FixedWindowRateLimiter(
    config.webhookRateLimitMax,
    config.rateLimitWindowSeconds * 1_000,
  );
  application.addHook("onReady", () => {
    options.messageRetention?.start();
  });
  const fingerprint = (request: FastifyRequest): string =>
    sha256(
      `${request.ip}\n${firstHeader(request.headers["user-agent"]) ?? ""}`,
    );
  const enforceRateLimit = (
    request: FastifyRequest,
    limiter: FixedWindowRateLimiter,
  ): void => {
    const decision = limiter.consume(fingerprint(request));
    if (!decision.allowed) {
      throw new ApplicationError(
        "RATE_LIMITED",
        `Too many requests; retry after ${decision.retryAfterSeconds} seconds.`,
        429,
      );
    }
  };

  application.setErrorHandler((error, request, reply) => {
    if (error instanceof WorkflowCapacityError) {
      void reply.status(503).send({
        error: {
          code: error.code,
          message: error.message,
          correlationId: request.id,
        },
      });
      return;
    }
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
    const states = await Promise.all([
      repository.isReady(),
      options.auth?.isReady() ?? Promise.resolve(true),
      options.workflow?.repository.isReady() ?? Promise.resolve(true),
      options.ai?.repository.isReady() ?? Promise.resolve(true),
      options.dataExport?.repository.isReady() ?? Promise.resolve(true),
      options.blueBubbles?.settings.repository.isReady() ??
        Promise.resolve(true),
    ]);
    const ready = states.every(Boolean);
    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? "ready" : "unavailable" });
  });

  application.post("/api/v1/webhooks/bluebubbles", async (request, reply) => {
    enforceRateLimit(request, webhookRateLimiter);
    const webhookAuthenticated =
      options.blueBubbles === undefined
        ? secretsEqual(webhookToken(request), config.blueBubblesWebhookSecret)
        : await options.blueBubbles.settings.verifyWebhookSecret(
            webhookToken(request),
          );
    if (!webhookAuthenticated) {
      throw new ApplicationError(
        "INVALID_WEBHOOK_SECRET",
        "Webhook authentication failed.",
        401,
      );
    }

    const outcome = await ingestion.ingest(request.body, request.id);
    let automation = {
      executionIds: [] as readonly string[],
      matchedTriggerIds: [] as readonly string[],
      activeTriggerCount: 0,
    };
    let automationOutcome = outcome.result.automationOutcome;
    if (outcome.automationEnvelope !== null) {
      let decision: AutomationOutcome;
      if (options.workflow === undefined) {
        decision = "not-evaluated";
      } else {
        automation = await (options.workflow.dispatcher?.dispatch(
          outcome.automationEnvelope,
        ) ?? options.workflow.engine.handleMessage(outcome.automationEnvelope));
        decision =
          automation.activeTriggerCount === 0
            ? "no-active-triggers"
            : automation.matchedTriggerIds.length === 0
              ? "no-trigger-match"
              : "matched";
      }
      automationOutcome = await repository.recordAutomationOutcome(
        outcome.automationEnvelope.provider,
        outcome.result.eventId,
        decision,
      );
    }
    request.log.info(
      {
        correlationId: outcome.result.correlationId,
        eventId: outcome.result.eventId,
        ingestionStatus: outcome.result.status,
        automationOutcome,
        messageId: outcome.result.messageId,
        executionIds: automation.executionIds,
      },
      "BlueBubbles webhook processed",
    );

    return reply.status(202).send({
      data: {
        ...outcome.result,
        automationOutcome,
        executionIds: automation.executionIds,
        matchedTriggerIds: automation.matchedTriggerIds,
      },
    });
  });

  const principals = new WeakMap<FastifyRequest, AdminPrincipal>();
  const sessionViews = new WeakMap<FastifyRequest, AdminSessionView>();
  const sensitiveAudits = new WeakMap<
    FastifyRequest,
    { action: string; targetType: string }
  >();

  const audit = async (
    request: FastifyRequest,
    action: string,
    targetType: string,
    targetId: string | null,
    outcome: AuditOutcome,
    principal: AdminPrincipal | null = principals.get(request) ?? null,
    metadata: Readonly<Record<string, string | number | boolean | null>> = {},
  ): Promise<void> => {
    if (options.auth === undefined) {
      return;
    }
    await options.auth.recordAudit({
      actorType:
        principal === null
          ? "anonymous"
          : principal.kind === "api-token"
            ? "api-token"
            : "session",
      actorSessionId:
        principal?.kind === "session" ? principal.sessionId : null,
      action,
      targetType,
      targetId,
      outcome,
      correlationId: request.id,
      metadata,
    });
  };

  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    enforceRateLimit(request, adminRateLimiter);
    const candidate = readBearerToken(request.headers.authorization);
    if (secretsEqual(candidate, config.apiAccessToken)) {
      principals.set(request, { kind: "api-token" });
      return;
    }

    const token = readCookie(request.headers.cookie, adminSessionCookieName);
    const authenticated =
      token === undefined || options.auth === undefined
        ? null
        : await options.auth.authenticate(token);
    if (authenticated === null) {
      throw new ApplicationError(
        "UNAUTHORIZED",
        "An authenticated admin session is required.",
        401,
      );
    }
    principals.set(request, {
      kind: "session",
      sessionId: authenticated.sessionId,
    });
    sessionViews.set(request, authenticated.session);
  };

  const requireSession = async (request: FastifyRequest): Promise<void> => {
    enforceRateLimit(request, adminRateLimiter);
    const token = readCookie(request.headers.cookie, adminSessionCookieName);
    const authenticated =
      token === undefined || options.auth === undefined
        ? null
        : await options.auth.authenticate(token);
    if (authenticated === null) {
      throw new ApplicationError(
        "UNAUTHORIZED",
        "An authenticated admin session is required.",
        401,
      );
    }
    principals.set(request, {
      kind: "session",
      sessionId: authenticated.sessionId,
    });
    sessionViews.set(request, authenticated.session);
  };

  const requireSensitive =
    (action: string, targetType: string) =>
    async (request: FastifyRequest): Promise<void> => {
      await requireAdmin(request);
      const principal = principals.get(request);
      if (
        principal?.kind === "session" &&
        options.auth !== undefined &&
        !(await options.auth.hasSensitiveGrant(principal.sessionId))
      ) {
        await audit(request, action, targetType, null, "denied", principal, {
          reason: "sensitive-auth-required",
        });
        throw new ApplicationError(
          "SENSITIVE_AUTH_REQUIRED",
          "Sensitive operation verification is required.",
          403,
        );
      }
      sensitiveAudits.set(request, { action, targetType });
    };

  const requireAuditedAdmin =
    (action: string, targetType: string) =>
    async (request: FastifyRequest): Promise<void> => {
      await requireAdmin(request);
      sensitiveAudits.set(request, { action, targetType });
    };

  const dataExportOwner = (request: FastifyRequest): DataExportOwner => {
    const principal = principals.get(request);
    if (principal?.kind === "session") {
      return { actorType: "session", actorSessionId: principal.sessionId };
    }
    if (principal?.kind === "api-token") {
      return { actorType: "api-token", actorSessionId: null };
    }
    throw new ApplicationError(
      "UNAUTHORIZED",
      "An authenticated admin session is required.",
      401,
    );
  };

  if (options.blueBubbles !== undefined) {
    application.get(
      "/api/v1/integrations/bluebubbles",
      { preHandler: requireAdmin },
      async () => ({ data: await options.blueBubbles?.settings.view() }),
    );

    application.put(
      "/api/v1/integrations/bluebubbles",
      {
        preHandler: requireSensitive(
          "integration.bluebubbles.update",
          "integration-settings",
        ),
      },
      async (request) => {
        const body = blueBubblesSettingsUpdateSchema.parse(request.body);
        const result = await options.blueBubbles?.settings.update(body);
        if (result === undefined) {
          throw new ApplicationError(
            "BLUEBUBBLES_SETTINGS_UNAVAILABLE",
            "BlueBubbles settings are unavailable.",
            503,
          );
        }
        if (result.status === "conflict") {
          throw new ApplicationError(
            "BLUEBUBBLES_SETTINGS_CONFLICT",
            "BlueBubbles settings changed; refresh before retrying.",
            409,
          );
        }
        return { data: result.value };
      },
    );

    application.post(
      "/api/v1/integrations/bluebubbles/test",
      {
        preHandler: requireSensitive(
          "integration.bluebubbles.test",
          "integration-settings",
        ),
      },
      async () => ({
        data: await options.blueBubbles?.settings.testConnection(),
      }),
    );
  }

  application.addHook("onResponse", async (request, reply) => {
    const context = sensitiveAudits.get(request);
    if (context === undefined) {
      return;
    }
    const parameters =
      request.params !== null && typeof request.params === "object"
        ? Object.values(request.params).find(
            (value): value is string => typeof value === "string",
          )
        : undefined;
    await audit(
      request,
      context.action,
      context.targetType,
      parameters ?? null,
      reply.statusCode < 400 ? "succeeded" : "failed",
      undefined,
      { statusCode: reply.statusCode },
    );
  });

  if (options.auth !== undefined) {
    application.post("/api/v1/auth/session", async (request, reply) => {
      enforceRateLimit(request, adminRateLimiter);
      const body = passwordBodySchema.parse(request.body);
      const result = await options.auth?.login(body.password);
      if (result === undefined || result.status === "invalid-credentials") {
        await audit(
          request,
          "auth.login",
          "admin-session",
          null,
          "failed",
          null,
          { clientFingerprint: fingerprint(request) },
        );
        throw new ApplicationError(
          "INVALID_CREDENTIALS",
          "The supplied credentials are invalid.",
          401,
        );
      }
      const principal: AdminPrincipal = {
        kind: "session",
        sessionId: result.sessionId,
      };
      principals.set(request, principal);
      await audit(
        request,
        "auth.login",
        "admin-session",
        result.sessionId,
        "succeeded",
        principal,
        { clientFingerprint: fingerprint(request) },
      );
      return reply
        .header("set-cookie", sessionCookie(config, request, result.token))
        .status(201)
        .send({ data: result.session });
    });

    application.get(
      "/api/v1/auth/session",
      { preHandler: requireSession },
      (request) => ({ data: sessionViews.get(request) }),
    );

    application.delete(
      "/api/v1/auth/session",
      { preHandler: requireSession },
      async (request, reply) => {
        const principal = principals.get(request);
        if (principal?.kind === "session") {
          await options.auth?.logout(principal.sessionId);
          await audit(
            request,
            "auth.logout",
            "admin-session",
            principal.sessionId,
            "succeeded",
            principal,
          );
        }
        return reply
          .header("set-cookie", expiredSessionCookie(config, request))
          .status(204)
          .send();
      },
    );

    application.post(
      "/api/v1/auth/sensitive",
      { preHandler: requireSession },
      async (request) => {
        const body = passwordBodySchema.parse(request.body);
        const principal = principals.get(request);
        if (principal?.kind !== "session") {
          throw new ApplicationError(
            "UNAUTHORIZED",
            "An authenticated admin session is required.",
            401,
          );
        }
        const result = await options.auth?.verifySensitiveOperation(
          principal.sessionId,
          body.password,
        );
        if (result === undefined || result.status === "invalid-credentials") {
          await audit(
            request,
            "auth.sensitive.verify",
            "admin-session",
            principal.sessionId,
            "failed",
            principal,
          );
          throw new ApplicationError(
            "INVALID_CREDENTIALS",
            "The supplied credentials are invalid.",
            401,
          );
        }
        await audit(
          request,
          "auth.sensitive.verify",
          "admin-session",
          principal.sessionId,
          "succeeded",
          principal,
        );
        return { data: result.session };
      },
    );

    application.get(
      "/api/v1/audit-events",
      { preHandler: requireSensitive("audit.events.view", "audit") },
      async (request) => {
        const query = auditQuerySchema.parse(request.query);
        return {
          data: await options.auth?.listAuditEvents(query.limit),
          page: { nextCursor: null },
        };
      },
    );
  }

  application.get(
    "/api/v1/inbound-events",
    { preHandler: requireAdmin },
    async (request) => {
      const query = pageQuerySchema.parse(request.query);
      const events = await repository.listInboundEvents({
        limit: query.limit,
        cursor: decodeCursor(query.cursor),
      });
      const last = events.at(-1);
      return {
        data: events,
        page: {
          nextCursor: encodeCursor(
            last === undefined
              ? undefined
              : { timestamp: last.receivedAt, id: last.id },
          ),
        },
      };
    },
  );

  application.get(
    "/api/v1/chats",
    { preHandler: requireAdmin },
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
    "/api/v1/chat-monitoring",
    { preHandler: requireAdmin },
    async (request) => {
      const query = pageQuerySchema.parse(request.query);
      const chats = await repository.listChatMonitoring({
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

  application.patch(
    "/api/v1/chat-monitoring/:chatId",
    { preHandler: requireSensitive("chat.monitoring.update", "chat") },
    async (request) => {
      const parameters = chatParametersSchema.parse(request.params);
      const body = chatMonitoringBodySchema.parse(request.body);
      const result = await repository.setChatMonitoring({
        chatId: parameters.chatId,
        enabled: body.enabled,
        expectedVersion: body.expectedVersion,
      });
      if (result.status === "not-found") {
        throw new ApplicationError(
          "CHAT_NOT_FOUND",
          "The chat does not exist or is unavailable.",
          404,
        );
      }
      if (result.status === "conflict") {
        throw new ApplicationError(
          "CHAT_MONITORING_CONFLICT",
          "The chat monitoring state changed; refresh before retrying.",
          409,
        );
      }
      return { data: result.value };
    },
  );

  application.get(
    "/api/v1/messages/search",
    { preHandler: requireSensitive("message.content.search", "message") },
    async (request) => {
      const query = messageSearchQuerySchema.parse(request.query);
      const messages = await repository.searchMessages({
        chatId: query.chatId ?? null,
        keyword: query.q ?? null,
        senderId: query.senderId ?? null,
        sentFrom:
          query.sentFrom === undefined ? null : new Date(query.sentFrom),
        sentTo: query.sentTo === undefined ? null : new Date(query.sentTo),
        limit: query.limit,
        cursor: decodeCursor(query.cursor),
      });
      const executionLinks =
        options.workflow === undefined
          ? []
          : await options.workflow.repository.listExecutionsForMessages(
              messages.map((item) => item.providerMessageId),
            );
      const executionsByMessage = new Map<
        string,
        Array<{
          id: string;
          triggerId: string;
          triggerName: string;
          workflowId: string;
          workflowName: string;
          workflowVersion: number;
          correlationId: string;
          status: string;
          errorCode: string | null;
          createdAt: string;
        }>
      >();
      for (const link of executionLinks) {
        const execution = link.execution;
        const items = executionsByMessage.get(link.providerMessageId) ?? [];
        items.push({
          id: execution.id,
          triggerId: execution.triggerId,
          triggerName: execution.triggerName,
          workflowId: execution.workflowId,
          workflowName: execution.workflowName,
          workflowVersion: execution.workflowVersion,
          correlationId: execution.correlationId,
          status: execution.status,
          errorCode: execution.errorCode,
          createdAt: execution.createdAt,
        });
        executionsByMessage.set(link.providerMessageId, items);
      }
      const last = messages.at(-1);
      return {
        data: messages.map((item) => ({
          ...item,
          executions: executionsByMessage.get(item.providerMessageId) ?? [],
        })),
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

  if (options.dataExport !== undefined) {
    const dataExport = options.dataExport.service;

    application.get(
      "/api/v1/exports",
      { preHandler: requireAdmin },
      async (request) => {
        const query = auditQuerySchema.parse(request.query);
        return {
          data: await dataExport.list(dataExportOwner(request), query.limit),
          page: { nextCursor: null },
        };
      },
    );

    application.post(
      "/api/v1/exports/preview",
      {
        preHandler: requireAuditedAdmin("data.export.preview", "data-export"),
      },
      async (request, reply) => {
        const scope = dataExportScopeSchema.parse(request.body);
        const result = await dataExport.preview(
          dataExportOwner(request),
          scope,
        );
        if (result.status === "scope-unavailable") {
          throw new ApplicationError(
            "DATA_EXPORT_SCOPE_UNAVAILABLE",
            "The selected chat does not exist or is unavailable.",
            404,
          );
        }
        if (result.status === "too-large") {
          throw new ApplicationError(
            "DATA_EXPORT_SCOPE_TOO_LARGE",
            "Narrow the export range before retrying.",
            422,
          );
        }
        return reply.status(201).send({ data: result.value });
      },
    );

    application.post(
      "/api/v1/exports/:exportId/confirm",
      { preHandler: requireSensitive("data.export.create", "data-export") },
      async (request) => {
        const parameters = dataExportParametersSchema.parse(request.params);
        const body = dataExportConfirmSchema.parse(request.body);
        const result = dataExportMutationValue(
          await dataExport.confirm(
            parameters.exportId,
            dataExportOwner(request),
            body.expectedRecordCount,
            new Date(body.expectedSnapshotAt),
          ),
        );
        return { data: result.value };
      },
    );

    application.get(
      "/api/v1/exports/:exportId/download",
      {
        preHandler: requireSensitive("data.export.download", "data-export"),
      },
      async (request, reply) => {
        const parameters = dataExportParametersSchema.parse(request.params);
        const result = dataExportReadValue(
          await dataExport.read(parameters.exportId, dataExportOwner(request)),
        );
        return reply
          .header("cache-control", "no-store")
          .header("x-content-type-options", "nosniff")
          .header(
            "content-disposition",
            `attachment; filename="bubblepilot-export-${parameters.exportId}.jsonl"`,
          )
          .type("application/x-ndjson; charset=utf-8")
          .send(dataExport.render(result));
      },
    );

    application.delete(
      "/api/v1/exports/:exportId",
      { preHandler: requireSensitive("data.export.cancel", "data-export") },
      async (request) => {
        const parameters = dataExportParametersSchema.parse(request.params);
        const result = dataExportMutationValue(
          await dataExport.revoke(
            parameters.exportId,
            dataExportOwner(request),
          ),
        );
        return { data: result.value };
      },
    );
  }

  if (options.ai !== undefined) {
    const ai = options.ai.management;

    application.get(
      "/api/v1/ai/providers",
      { preHandler: requireAdmin },
      async () => ({ data: await ai.listProviders() }),
    );

    application.post(
      "/api/v1/ai/providers",
      { preHandler: requireAuditedAdmin("ai.provider.create", "ai-provider") },
      async (request, reply) => {
        const provider = aiMutationValue(
          await ai.createProvider(
            aiProviderConfigurationSchema.parse(request.body),
          ),
          "AI_PROVIDER_NOT_FOUND",
          "The AI provider does not exist.",
        );
        return reply.status(201).send({ data: provider });
      },
    );

    application.put(
      "/api/v1/ai/providers/reorder",
      { preHandler: requireAuditedAdmin("ai.provider.reorder", "ai-provider") },
      async (request) => {
        const body = aiProviderReorderSchema.parse(request.body);
        return {
          data: aiMutationValue(
            await ai.reorderProviders(body.providers),
            "AI_PROVIDER_NOT_FOUND",
            "An AI provider in the order no longer exists.",
          ),
        };
      },
    );

    application.get(
      "/api/v1/ai/providers/:providerId",
      { preHandler: requireAdmin },
      async (request) => {
        const parameters = aiProviderParametersSchema.parse(request.params);
        const provider = await ai.getProvider(parameters.providerId);
        if (provider === null) {
          throw new ApplicationError(
            "AI_PROVIDER_NOT_FOUND",
            "The AI provider does not exist.",
            404,
          );
        }
        return { data: provider };
      },
    );

    application.put(
      "/api/v1/ai/providers/:providerId",
      { preHandler: requireAuditedAdmin("ai.provider.update", "ai-provider") },
      async (request) => {
        const parameters = aiProviderParametersSchema.parse(request.params);
        const body = aiProviderUpdateSchema.parse(request.body);
        const { expectedVersion, ...configuration } = body;
        return {
          data: aiMutationValue(
            await ai.updateProvider(
              parameters.providerId,
              expectedVersion,
              configuration,
            ),
            "AI_PROVIDER_NOT_FOUND",
            "The AI provider does not exist.",
          ),
        };
      },
    );

    application.patch(
      "/api/v1/ai/providers/:providerId/enabled",
      {
        preHandler: requireAuditedAdmin(
          "ai.provider.enabled.update",
          "ai-provider",
        ),
      },
      async (request) => {
        const parameters = aiProviderParametersSchema.parse(request.params);
        const body = aiProviderEnabledSchema.parse(request.body);
        return {
          data: aiMutationValue(
            await ai.setProviderEnabled(
              parameters.providerId,
              body.expectedVersion,
              body.enabled,
            ),
            "AI_PROVIDER_NOT_FOUND",
            "The AI provider does not exist.",
          ),
        };
      },
    );

    application.delete(
      "/api/v1/ai/providers/:providerId",
      { preHandler: requireAuditedAdmin("ai.provider.delete", "ai-provider") },
      async (request) => {
        const parameters = aiProviderParametersSchema.parse(request.params);
        const query = expectedVersionQuerySchema.parse(request.query);
        return {
          data: aiMutationValue(
            await ai.deleteProvider(
              parameters.providerId,
              query.expectedVersion,
            ),
            "AI_PROVIDER_NOT_FOUND",
            "The AI provider does not exist.",
          ),
        };
      },
    );

    application.post(
      "/api/v1/ai/providers/:providerId/test",
      { preHandler: requireAuditedAdmin("ai.provider.test", "ai-provider") },
      async (request) => {
        const parameters = aiProviderParametersSchema.parse(request.params);
        const result = await ai.testProvider(parameters.providerId);
        if (result === null) {
          throw new ApplicationError(
            "AI_PROVIDER_NOT_FOUND",
            "The AI provider does not exist.",
            404,
          );
        }
        return { data: result };
      },
    );

    application.post(
      "/api/v1/ai/providers/:providerId/health/reset",
      {
        preHandler: requireAuditedAdmin(
          "ai.provider.health.reset",
          "ai-provider",
        ),
      },
      async (request) => {
        const parameters = aiProviderParametersSchema.parse(request.params);
        const provider = await ai.resetProviderHealth(parameters.providerId);
        if (provider === null) {
          throw new ApplicationError(
            "AI_PROVIDER_NOT_FOUND",
            "The AI provider does not exist.",
            404,
          );
        }
        return { data: provider };
      },
    );

    application.get(
      "/api/v1/ai/routes",
      { preHandler: requireAdmin },
      async () => ({ data: await ai.listRoutes() }),
    );

    application.post(
      "/api/v1/ai/routes",
      { preHandler: requireAuditedAdmin("ai.route.create", "ai-route") },
      async (request, reply) => {
        const route = aiMutationValue(
          await ai.createRoute(aiRouteConfigurationSchema.parse(request.body)),
          "AI_ROUTE_NOT_FOUND",
          "The AI provider route does not exist.",
        );
        return reply.status(201).send({ data: route });
      },
    );

    application.get(
      "/api/v1/ai/routes/:routeId",
      { preHandler: requireAdmin },
      async (request) => {
        const parameters = aiRouteParametersSchema.parse(request.params);
        const route = await ai.getRoute(parameters.routeId);
        if (route === null) {
          throw new ApplicationError(
            "AI_ROUTE_NOT_FOUND",
            "The AI provider route does not exist.",
            404,
          );
        }
        return { data: route };
      },
    );

    application.put(
      "/api/v1/ai/routes/:routeId",
      { preHandler: requireAuditedAdmin("ai.route.update", "ai-route") },
      async (request) => {
        const parameters = aiRouteParametersSchema.parse(request.params);
        const body = aiRouteUpdateSchema.parse(request.body);
        const { expectedVersion, ...configuration } = body;
        return {
          data: aiMutationValue(
            await ai.updateRoute(
              parameters.routeId,
              expectedVersion,
              configuration,
            ),
            "AI_ROUTE_NOT_FOUND",
            "The AI provider route does not exist.",
          ),
        };
      },
    );

    application.patch(
      "/api/v1/ai/routes/:routeId/enabled",
      {
        preHandler: requireAuditedAdmin("ai.route.enabled.update", "ai-route"),
      },
      async (request) => {
        const parameters = aiRouteParametersSchema.parse(request.params);
        const body = aiRouteEnabledSchema.parse(request.body);
        return {
          data: aiMutationValue(
            await ai.setRouteEnabled(
              parameters.routeId,
              body.expectedVersion,
              body.enabled,
            ),
            "AI_ROUTE_NOT_FOUND",
            "The AI provider route does not exist.",
          ),
        };
      },
    );

    application.delete(
      "/api/v1/ai/routes/:routeId",
      { preHandler: requireAuditedAdmin("ai.route.delete", "ai-route") },
      async (request) => {
        const parameters = aiRouteParametersSchema.parse(request.params);
        const query = expectedVersionQuerySchema.parse(request.query);
        return {
          data: aiMutationValue(
            await ai.deleteRoute(parameters.routeId, query.expectedVersion),
            "AI_ROUTE_NOT_FOUND",
            "The AI provider route does not exist.",
          ),
        };
      },
    );
  }

  if (options.workflow !== undefined) {
    const workflowRepository = options.workflow.repository;
    application.get(
      "/api/v1/workflows/action-blocks",
      { preHandler: requireAdmin },
      () => ({ data: listActionBlockDefinitions() }),
    );

    application.post(
      "/api/v1/workflows/validate",
      { preHandler: requireAdmin },
      (request) => {
        const body = workflowVersionBodySchema.parse(request.body);
        const definition =
          typeof body.definition === "object" &&
          body.definition !== null &&
          (body.definition as { schemaVersion?: unknown }).schemaVersion === "1"
            ? validateWorkflowGraph(body.definition)
            : workflowDefinition(body.definition);
        return {
          data: {
            valid: true,
            schemaVersion: definition.schemaVersion,
            nodeCount: definition.nodes.length,
            startNodeId: definition.startNodeId,
          },
        };
      },
    );
    const executionDetail = async (executionId: string) => {
      const execution = await workflowRepository.getExecution(executionId);
      return execution === null
        ? null
        : {
            ...execution,
            aiProviderAttempts:
              (await options.ai?.repository.listAttempts(executionId)) ?? [],
          };
    };

    application.get(
      "/api/v1/workflows",
      { preHandler: requireAdmin },
      async () => ({ data: await workflowRepository.listWorkflows() }),
    );

    application.post(
      "/api/v1/workflows",
      { preHandler: requireAdmin },
      async (request, reply) => {
        const body = workflowBodySchema.parse(request.body);
        const version = await workflowRepository.createWorkflow(
          body.name,
          workflowDefinition(body.definition),
        );
        return reply.status(201).send({ data: version });
      },
    );

    application.post(
      "/api/v1/workflows/:workflowId/versions",
      { preHandler: requireAdmin },
      async (request, reply) => {
        const parameters = workflowParametersSchema.parse(request.params);
        const body = workflowVersionBodySchema.parse(request.body);
        const version = await workflowRepository.createWorkflowVersion(
          parameters.workflowId,
          workflowDefinition(body.definition),
        );
        if (version === null) {
          throw new ApplicationError(
            "WORKFLOW_NOT_FOUND",
            "The workflow does not exist.",
            404,
          );
        }
        return reply.status(201).send({ data: version });
      },
    );

    application.get(
      "/api/v1/workflows/:workflowId/versions",
      { preHandler: requireAdmin },
      async (request) => {
        const parameters = workflowParametersSchema.parse(request.params);
        return {
          data: await workflowRepository.listWorkflowVersions(
            parameters.workflowId,
          ),
        };
      },
    );

    application.delete(
      "/api/v1/workflows/:workflowId",
      { preHandler: requireAdmin },
      async (request) => {
        const parameters = workflowParametersSchema.parse(request.params);
        const result = await workflowRepository.deleteWorkflow(
          parameters.workflowId,
        );
        if (result === "not-found")
          throw new ApplicationError(
            "WORKFLOW_NOT_FOUND",
            "The workflow does not exist.",
            404,
          );
        if (result === "referenced")
          throw new ApplicationError(
            "WORKFLOW_REFERENCED",
            "The workflow is referenced by triggers or execution records and cannot be deleted.",
            409,
          );
        return { data: { deleted: true } };
      },
    );

    application.post(
      "/api/v1/workflows/:workflowId/versions/:version/publish",
      {
        preHandler: requireAdmin,
      },
      async (request) => {
        const parameters = workflowVersionParametersSchema.parse(
          request.params,
        );
        const candidate = await workflowRepository.getWorkflowVersion(
          parameters.workflowId,
          parameters.version,
        );
        const routeIds = [
          ...new Set(
            candidate?.definition.nodes.flatMap((node) =>
              node.type === "ai-chat" ? [node.config.providerRouteId] : [],
            ) ?? [],
          ),
        ];
        for (const routeId of routeIds) {
          if (
            options.ai === undefined ||
            !(await options.ai.management.isRoutePublishable(routeId))
          ) {
            throw new ApplicationError(
              "AI_ROUTE_NOT_PUBLISHABLE",
              `AI provider route '${routeId}' is unavailable, disabled, or has no configured secret.`,
              409,
            );
          }
        }
        const version = await workflowRepository.publishWorkflowVersion(
          parameters.workflowId,
          parameters.version,
        );
        if (version === null) {
          throw new ApplicationError(
            "WORKFLOW_VERSION_NOT_PUBLISHABLE",
            "The workflow version does not exist or cannot be published.",
            409,
          );
        }
        return { data: version };
      },
    );

    application.patch(
      "/api/v1/workflows/:workflowId/enabled",
      {
        preHandler: requireAdmin,
      },
      async (request) => {
        const parameters = workflowParametersSchema.parse(request.params);
        const body = triggerStatusBodySchema.parse(request.body);
        const workflow = await workflowRepository.setWorkflowEnabled(
          parameters.workflowId,
          body.enabled,
        );
        if (workflow === null) {
          throw new ApplicationError(
            "WORKFLOW_NOT_TOGGLEABLE",
            "The workflow does not exist or has no published version.",
            409,
          );
        }
        return { data: workflow };
      },
    );

    application.get(
      "/api/v1/triggers",
      { preHandler: requireAdmin },
      async () => {
        const [triggers, activeBindings] = await Promise.all([
          workflowRepository.listTriggers(),
          workflowRepository.listActiveTriggerBindings(),
        ]);
        const conflicts = findPotentialTriggerConflicts(activeBindings);
        return {
          data: triggers.map((trigger) => ({
            ...trigger,
            conflictingTriggerIds: conflicts.get(trigger.id) ?? [],
          })),
        };
      },
    );

    application.post(
      "/api/v1/triggers/preview",
      { preHandler: requireAdmin },
      (request) => {
        const body = triggerPreviewBodySchema.parse(request.body);
        const sample: MessageEnvelope = {
          schemaVersion: "1",
          eventId: "preview:fictional-event",
          correlationId: request.id,
          provider: "bluebubbles",
          chat: {
            providerChatId: body.sample.providerChatId,
            type: "unknown",
            displayName: null,
          },
          message: {
            providerMessageId: "fictional-preview-message",
            senderId: body.sample.senderId,
            sentAt: body.sample.sentAt ?? new Date().toISOString(),
            text: body.sample.text,
            contentType: body.sample.contentType,
            isFromMe: body.sample.isFromMe,
            attachments: [],
            contentHash: `sha256:${"0".repeat(64)}`,
          },
          metadata: {
            isReplay: false,
            payloadHash: `sha256:${"0".repeat(64)}`,
            eventType: "preview",
            adapterVersion: "preview",
          },
        };
        return {
          data: matchTrigger(
            sample,
            triggerConditions(body.conditions),
            body.includeFromMe,
          ),
        };
      },
    );

    application.post(
      "/api/v1/triggers",
      { preHandler: requireAdmin },
      async (request, reply) => {
        const body = triggerBodySchema.parse(request.body);
        const trigger = await workflowRepository.createTrigger({
          ...body,
          conditions: triggerConditions(body.conditions),
        });
        if (trigger === null) {
          throw new ApplicationError(
            "WORKFLOW_VERSION_NOT_ACTIVE",
            "The trigger must reference an active published workflow version.",
            409,
          );
        }
        return reply.status(201).send({ data: trigger });
      },
    );

    application.patch(
      "/api/v1/triggers/:triggerId",
      { preHandler: requireAuditedAdmin("trigger.enabled.update", "trigger") },
      async (request) => {
        const parameters = triggerParametersSchema.parse(request.params);
        const body = triggerStatusBodySchema.parse(request.body);
        const trigger = await workflowRepository.updateTriggerEnabled(
          parameters.triggerId,
          body.enabled,
        );
        if (trigger === null) {
          throw new ApplicationError(
            "TRIGGER_NOT_FOUND_OR_INACTIVE_WORKFLOW",
            "The trigger does not exist or its workflow is not active.",
            409,
          );
        }
        return { data: trigger };
      },
    );

    application.put(
      "/api/v1/triggers/:triggerId",
      { preHandler: requireAdmin },
      async (request) => {
        const parameters = triggerParametersSchema.parse(request.params);
        const body = triggerUpdateBodySchema.parse(request.body);
        const trigger = await workflowRepository.updateTrigger(
          parameters.triggerId,
          {
            name: body.name,
            conditions: triggerConditions(body.conditions),
            includeFromMe: body.includeFromMe,
          },
        );
        if (trigger === null)
          throw new ApplicationError(
            "TRIGGER_NOT_FOUND",
            "The trigger does not exist.",
            404,
          );
        return { data: trigger };
      },
    );

    application.delete(
      "/api/v1/triggers/:triggerId",
      { preHandler: requireAdmin },
      async (request) => {
        const parameters = triggerParametersSchema.parse(request.params);
        const result = await workflowRepository.deleteTrigger(
          parameters.triggerId,
        );
        if (result === "not-found") {
          throw new ApplicationError(
            "TRIGGER_NOT_FOUND",
            "The trigger does not exist.",
            404,
          );
        }
        if (result === "referenced") {
          throw new ApplicationError(
            "TRIGGER_REFERENCED",
            "The trigger is referenced by execution records and cannot be deleted.",
            409,
          );
        }
        return { data: { deleted: true } };
      },
    );

    application.get(
      "/api/v1/executions",
      { preHandler: requireSensitive("execution.list", "workflow-execution") },
      async (request) => {
        const query = executionListQuerySchema.parse(request.query);
        return {
          data: await workflowRepository.listExecutions(
            query.limit,
            executionStatuses(query.status),
          ),
          page: { nextCursor: null },
        };
      },
    );

    application.get(
      "/api/v1/operations/status",
      { preHandler: requireAdmin },
      async () => {
        const [workflow, providers] = await Promise.all([
          workflowRepository.getRuntimeSummary(
            new Date(Date.now() - config.staleRetrySeconds * 1_000),
          ),
          options.ai?.management.listProviders() ?? Promise.resolve([]),
        ]);
        const executionGate = options.workflow?.engine.runtimeStatus() ?? {
          active: 0,
          queued: 0,
          maxConcurrency: config.workflowMaxConcurrency,
          queueCapacity: config.workflowQueueCapacity,
        };
        const degradedProviders = providers.filter(
          (provider) => provider.health.state !== "healthy",
        ).length;
        const messageRetention = options.messageRetention?.runtimeStatus() ?? {
          enabled: false as const,
          retentionDays: config.messageRetentionDays,
        };
        const messageRetentionFailed =
          messageRetention.enabled &&
          messageRetention.lastErrorAt !== null &&
          (messageRetention.lastSuccessAt === null ||
            messageRetention.lastErrorAt > messageRetention.lastSuccessAt);
        const alerts = [
          ...(workflow.executions.deadLettered > 0
            ? [
                {
                  code: "DEAD_LETTERED_EXECUTIONS",
                  severity: "warning" as const,
                  count: workflow.executions.deadLettered,
                },
              ]
            : []),
          ...(workflow.executions.staleRetrying > 0
            ? [
                {
                  code: "STALE_RETRYING_EXECUTIONS",
                  severity: "critical" as const,
                  count: workflow.executions.staleRetrying,
                },
              ]
            : []),
          ...(workflow.outbound.unknown > 0
            ? [
                {
                  code: "UNKNOWN_OUTBOUND_DELIVERIES",
                  severity: "critical" as const,
                  count: workflow.outbound.unknown,
                },
              ]
            : []),
          ...(degradedProviders > 0
            ? [
                {
                  code: "DEGRADED_AI_PROVIDERS",
                  severity: "warning" as const,
                  count: degradedProviders,
                },
              ]
            : []),
          ...(executionGate.queued >= executionGate.queueCapacity &&
          executionGate.queueCapacity > 0
            ? [
                {
                  code: "WORKFLOW_QUEUE_SATURATED",
                  severity: "critical" as const,
                  count: executionGate.queued,
                },
              ]
            : []),
          ...(messageRetentionFailed
            ? [
                {
                  code: "MESSAGE_RETENTION_FAILED",
                  severity: "critical" as const,
                  count: 1,
                },
              ]
            : []),
          ...(messageRetention.enabled && messageRetention.batchLimitReached
            ? [
                {
                  code: "MESSAGE_RETENTION_BACKLOG",
                  severity: "warning" as const,
                  count: messageRetention.lastRedactedCount,
                },
              ]
            : []),
        ];
        return {
          data: {
            status: alerts.some((alert) => alert.severity === "critical")
              ? "critical"
              : alerts.length > 0
                ? "attention"
                : "healthy",
            checkedAt: new Date().toISOString(),
            workflow,
            executionGate,
            aiProviders: {
              configured: providers.length,
              degraded: degradedProviders,
            },
            messageRetention,
            alerts,
          },
        };
      },
    );

    application.get(
      "/api/v1/executions/:executionId",
      {
        preHandler: requireSensitive(
          "execution.detail.view",
          "workflow-execution",
        ),
      },
      async (request) => {
        const parameters = executionParametersSchema.parse(request.params);
        const execution = await executionDetail(parameters.executionId);
        if (execution === null) {
          throw new ApplicationError(
            "EXECUTION_NOT_FOUND",
            "The workflow execution does not exist.",
            404,
          );
        }
        return { data: execution };
      },
    );

    application.post(
      "/api/v1/executions/:executionId/retry",
      {
        preHandler: requireSensitive("execution.retry", "workflow-execution"),
      },
      async (request, reply) => {
        const parameters = executionParametersSchema.parse(request.params);
        const result = await options.workflow?.engine.retryExecution(
          parameters.executionId,
          request.id,
          new Date(Date.now() - config.staleRetrySeconds * 1_000),
        );
        if (result === undefined) {
          throw new ApplicationError(
            "EXECUTION_RECOVERY_UNAVAILABLE",
            "Workflow recovery is unavailable.",
            503,
          );
        }
        if (result.status !== "created") executionRecoveryError(result);
        const execution = await executionDetail(result.execution.id);
        return reply.status(201).send({ data: execution ?? result.execution });
      },
    );

    application.post(
      "/api/v1/executions/:executionId/close",
      {
        preHandler: requireSensitive("execution.close", "workflow-execution"),
      },
      async (request) => {
        const parameters = executionParametersSchema.parse(request.params);
        const result = await options.workflow?.engine.closeExecution(
          parameters.executionId,
        );
        if (result === undefined) {
          throw new ApplicationError(
            "EXECUTION_RECOVERY_UNAVAILABLE",
            "Workflow recovery is unavailable.",
            503,
          );
        }
        if (result.status === "not-found") {
          throw new ApplicationError(
            "EXECUTION_NOT_FOUND",
            "The workflow execution does not exist.",
            404,
          );
        }
        if (result.status === "conflict") {
          throw new ApplicationError(
            "EXECUTION_NOT_CLOSEABLE",
            "Only retrying, failed, or dead-lettered executions can be closed.",
            409,
          );
        }
        const execution = await executionDetail(result.execution.id);
        return { data: execution ?? result.execution };
      },
    );
  }

  application.get(
    "/api/v1/chats/:chatId/messages",
    { preHandler: requireSensitive("message.content.view", "chat") },
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
    await options.messageRetention?.stop();
    await Promise.all([
      repository.close(),
      options.auth?.close() ?? Promise.resolve(),
      options.workflow?.repository.close() ?? Promise.resolve(),
      options.ai?.repository.close() ?? Promise.resolve(),
      options.dataExport?.repository.close() ?? Promise.resolve(),
      options.blueBubbles?.settings.repository.close() ?? Promise.resolve(),
    ]);
  });

  return application;
}
