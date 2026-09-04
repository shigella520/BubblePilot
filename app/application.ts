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
import type { WebSearchTool } from "../modules/ai/web-search-tool.js";
import type { WebSearchSettingsService } from "../modules/ai/web-search-settings-service.js";
import { webSearchSettingsUpdateSchema } from "../modules/ai/web-search-settings-types.js";
import type { ImageInputSettingsService } from "../modules/ai/image-input-settings-service.js";
import type { SummarySettingsService } from "../modules/workflow/summary-settings-service.js";
import type {
  ConversationContextService,
  ConversationSummaryWorker,
  ConversationCompressionContentView,
  ConversationCompressionView,
} from "../modules/workflow/conversation-context-service.js";
import { summarySettingsUpdateSchema } from "../modules/workflow/summary-settings-types.js";
import { imageInputSettingsUpdateSchema } from "../modules/ai/image-input-settings-types.js";
import type { NativeImageInputService } from "../modules/ai/native-image-input.js";
import type {
  ImageSummaryScheduler,
  ImageSummaryWorker,
} from "../modules/ai/image-summary-service.js";
import type { ImageSummaryRepository } from "../modules/ai/image-summary-repository.js";
import {
  messageImageMediaSources,
  messageImageMediaViews,
} from "../modules/ai/message-image-media.js";
import type {
  AiMutationResult,
  AiRepository,
} from "../modules/ai/ai-repository.js";
import type { AiRawRequestStore } from "../modules/ai/ai-raw-request-store.js";
import {
  aiProviderConfigurationSchema,
  aiProviderEnabledSchema,
  aiProviderReorderSchema,
  aiProviderUpdateSchema,
  aiRouteConfigurationSchema,
  aiRouteEnabledSchema,
  aiRouteUpdateSchema,
  aiUsageHoursSchema,
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
import type { LinkPreviewEnricher } from "../modules/integrations/bluebubbles/link-preview-enricher.js";
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
import {
  exportWorkflowManifest,
  importWorkflowManifest,
  WorkflowManifestPreviewSigner,
  workflowManifestSchema,
  type WorkflowBindingCatalog,
  type WorkflowCapability,
} from "../modules/workflow/workflow-manifest.js";
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
const compressionListQuerySchema = pageQuerySchema.extend({
  chatId: z.string().uuid().optional(),
  status: z
    .enum(["queued", "running", "succeeded", "failed", "superseded"])
    .optional(),
  reason: z
    .enum([
      "initial-catchup",
      "message-threshold",
      "policy-rebuild",
      "backlog-fast-forward",
    ])
    .optional(),
  provider: z.string().max(100).optional(),
  startedFrom: z.string().datetime({ offset: true }).optional(),
  startedTo: z.string().datetime({ offset: true }).optional(),
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

function validTimeZone(value: string): boolean {
  try {
    void new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const aiUsageQuerySchema = z.object({
  hours: z.preprocess(
    (value) => (value === undefined ? 24 : value),
    z.coerce.number().pipe(aiUsageHoursSchema),
  ),
  timeZone: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .default("UTC")
    .refine(validTimeZone, "Invalid IANA time zone."),
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
const messageParametersSchema = z.object({ messageId: z.string().uuid() });
const messageImageQuerySchema = z.object({
  attachmentRef: z.string().min(1).max(255),
});
const executionAttemptParametersSchema = executionParametersSchema.extend({
  attemptId: z.string().uuid(),
});
const aiProviderParametersSchema = z.object({ providerId: z.string().uuid() });
const aiRouteParametersSchema = z.object({ routeId: z.string().uuid() });
const dataExportParametersSchema = z.object({ exportId: z.string().uuid() });
const expectedVersionQuerySchema = z.object({
  expectedVersion: z.coerce.number().int().positive(),
});

const passwordBodySchema = z.object({
  password: z.string().min(1).max(1_024),
});

const chatMonitoringBodySchema = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().positive(),
});

const chatParticipantNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
    message: "Participant names must not contain control characters.",
  });

const chatParticipantIdentitySchema = z
  .object({
    senderId: z.string().trim().min(1).max(500),
    realName: chatParticipantNameSchema.nullable(),
    nickname: chatParticipantNameSchema.nullable(),
  })
  .strict()
  .refine(
    (identity) => identity.realName !== null || identity.nickname !== null,
    { message: "A participant identity requires a real name or nickname." },
  );

const chatParticipantIdentitiesBodySchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    identities: z.array(chatParticipantIdentitySchema).max(100),
  })
  .strict()
  .superRefine((body, context) => {
    const senderIds = new Set<string>();
    for (const [index, identity] of body.identities.entries()) {
      if (senderIds.has(identity.senderId)) {
        context.addIssue({
          code: "custom",
          path: ["identities", index, "senderId"],
          message: "Participant sender IDs must be unique.",
        });
      }
      senderIds.add(identity.senderId);
    }
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

const workflowVersionBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  definition: z.unknown(),
});

const workflowManifestExportQuerySchema = z.object({
  mode: z.enum(["portable", "instance-bound"]).default("portable"),
});

const workflowManifestPreviewBodySchema = z.object({
  manifest: z.unknown(),
  bindings: z.record(z.string(), z.string().min(1)).default({}),
});

const workflowManifestImportBodySchema = workflowManifestPreviewBodySchema
  .extend({
    previewToken: z.string().min(1).max(4_096),
    mode: z.enum(["create", "new-version"]).default("create"),
    targetWorkflowId: z.string().uuid().optional(),
  })
  .superRefine((body, context) => {
    if (body.mode === "new-version" && body.targetWorkflowId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["targetWorkflowId"],
        message: "targetWorkflowId is required for new-version imports.",
      });
    }
  });

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

function cursorPage<T>(
  items: readonly T[],
  limit: number,
  cursorFor: (item: T) => { timestamp: string; id: string },
) {
  const data = items.slice(0, limit);
  const last = data.at(-1);
  return {
    data,
    page: {
      nextCursor:
        items.length > limit && last !== undefined
          ? encodeCursor(cursorFor(last))
          : null,
    },
  };
}

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
  webRoot?: string | false;
  auth?: AuthService;
  ai?: {
    repository: AiRepository;
    management: AiManagementService;
    searchTool?: WebSearchTool;
    searchSettings?: WebSearchSettingsService;
    imageInputSettings?: ImageInputSettingsService;
    rawRequestStore?: AiRawRequestStore;
    summarySettings?: SummarySettingsService;
  };
  workflow?: {
    repository: WorkflowRepository;
    engine: MessageAutomation;
    dispatcher?: WorkflowExecutionDispatcher;
    contextState?: {
      close(): Promise<void>;
      listCompressions?(input: {
        limit: number;
        cursor?: { timestamp: Date; id: string };
        id?: string;
        chatId?: string;
        status?: "queued" | "running" | "succeeded" | "failed" | "superseded";
        reason?:
          | "initial-catchup"
          | "message-threshold"
          | "policy-rebuild"
          | "backlog-fast-forward";
        provider?: string;
        startedFrom?: Date;
        startedTo?: Date;
      }): Promise<readonly ConversationCompressionView[]>;
      getCompressionContent?(
        compressionId: string,
      ): Promise<ConversationCompressionContentView | null>;
    };
    conversationSummary?: ConversationContextService;
    summaryWorker?: ConversationSummaryWorker;
  };
  dataExport?: {
    repository: DataExportRepository;
    service: DataExportService;
  };
  blueBubbles?: {
    settings: BlueBubblesSettingsService;
    linkPreviewEnricher?: LinkPreviewEnricher;
  };
  messageRetention?: MessageRetentionWorker;
  imageSummary?: {
    scheduler: ImageSummaryScheduler;
    worker: ImageSummaryWorker;
    repository: ImageSummaryRepository;
    imageInput: NativeImageInputService;
  };
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
  const webRoot = options.webRoot ?? resolve(process.cwd(), "public");
  if (webRoot !== false && existsSync(webRoot)) {
    void application.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
      index: ["index.html"],
      wildcard: false,
      dotfiles: "ignore",
    });
  }
  const ingestion = new IngestionService(
    new BlueBubblesWebhookAdapter(),
    repository,
    config.monitoredChatIds,
    options.blueBubbles?.linkPreviewEnricher,
    options.imageSummary?.scheduler,
    options.workflow?.conversationSummary,
    options.ai?.summarySettings,
    options.workflow?.summaryWorker === undefined
      ? undefined
      : () => options.workflow?.summaryWorker?.trigger(),
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
    options.imageSummary?.worker.start();
    options.workflow?.summaryWorker?.start();
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
      options.ai?.searchSettings?.repository.isReady() ?? Promise.resolve(true),
      options.ai?.imageInputSettings?.repository.isReady() ??
        Promise.resolve(true),
      options.ai?.summarySettings?.repository.isReady() ??
        Promise.resolve(true),
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
        const dispatchOptions =
          outcome.summaryTrigger === undefined
            ? undefined
            : { summaryTrigger: outcome.summaryTrigger };
        automation = await (options.workflow.dispatcher === undefined
          ? options.workflow.engine.handleMessage(
              outcome.automationEnvelope,
              dispatchOptions,
            )
          : options.workflow.dispatcher.dispatch(
              outcome.automationEnvelope,
              dispatchOptions,
            ));
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
        const query = pageQuerySchema.parse(request.query);
        const events =
          (await options.auth?.listAuditEvents({
            limit: query.limit + 1,
            cursor: decodeCursor(query.cursor),
          })) ?? [];
        return cursorPage(events, query.limit, (event) => ({
          timestamp: event.occurredAt,
          id: event.id,
        }));
      },
    );
  }

  application.get(
    "/api/v1/inbound-events",
    { preHandler: requireAdmin },
    async (request) => {
      const query = pageQuerySchema.parse(request.query);
      const events = await repository.listInboundEvents({
        limit: query.limit + 1,
        cursor: decodeCursor(query.cursor),
      });
      return cursorPage(events, query.limit, (event) => ({
        timestamp: event.receivedAt,
        id: event.id,
      }));
    },
  );

  application.get(
    "/api/v1/chats",
    { preHandler: requireAdmin },
    async (request) => {
      const query = pageQuerySchema.parse(request.query);
      const chats = await repository.listChats({
        limit: query.limit + 1,
        cursor: decodeCursor(query.cursor),
      });
      return cursorPage(chats, query.limit, (chat) => ({
        timestamp: chat.updatedAt,
        id: chat.id,
      }));
    },
  );

  application.get(
    "/api/v1/chat-monitoring",
    { preHandler: requireAdmin },
    async (request) => {
      const query = pageQuerySchema.parse(request.query);
      const chats = await repository.listChatMonitoring({
        limit: query.limit + 1,
        cursor: decodeCursor(query.cursor),
      });
      return cursorPage(chats, query.limit, (chat) => ({
        timestamp: chat.updatedAt,
        id: chat.id,
      }));
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

  application.delete(
    "/api/v1/chats/:chatId",
    { preHandler: requireSensitive("chat.delete", "chat") },
    async (request) => {
      const parameters = chatParametersSchema.parse(request.params);
      const query = expectedVersionQuerySchema.parse(request.query);
      const result = await repository.deleteChat({
        chatId: parameters.chatId,
        expectedVersion: query.expectedVersion,
      });
      if (result.status === "not-found") {
        throw new ApplicationError(
          "CHAT_NOT_FOUND",
          "The chat does not exist or is unavailable.",
          404,
        );
      }
      if (result.status === "still-enabled") {
        throw new ApplicationError(
          "CHAT_STILL_ENABLED",
          "Disable monitoring before deleting the chat.",
          409,
        );
      }
      if (result.status === "conflict") {
        throw new ApplicationError(
          "CHAT_DELETE_CONFLICT",
          "The chat changed; refresh before retrying.",
          409,
        );
      }
      return { data: { deleted: true } };
    },
  );

  application.get(
    "/api/v1/chats/:chatId/participants",
    { preHandler: requireSensitive("chat.participants.view", "chat") },
    async (request) => {
      const parameters = chatParametersSchema.parse(request.params);
      const participants = await repository.getChatParticipants(
        parameters.chatId,
      );
      if (participants === null) {
        throw new ApplicationError(
          "CHAT_NOT_FOUND",
          "The chat does not exist or is unavailable.",
          404,
        );
      }
      return { data: participants };
    },
  );

  application.put(
    "/api/v1/chats/:chatId/participants",
    { preHandler: requireSensitive("chat.participants.update", "chat") },
    async (request) => {
      const parameters = chatParametersSchema.parse(request.params);
      const body = chatParticipantIdentitiesBodySchema.parse(request.body);
      const result = await repository.saveChatParticipantIdentities({
        chatId: parameters.chatId,
        expectedVersion: body.expectedVersion,
        identities: body.identities,
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
          "CHAT_PARTICIPANT_IDENTITIES_CONFLICT",
          "The participant mapping changed; refresh before retrying.",
          409,
        );
      }
      if (result.status === "invalid-sender") {
        throw new ApplicationError(
          "CHAT_PARTICIPANT_NOT_DISCOVERED",
          "Every mapped sender ID must already appear in this chat history.",
          400,
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
      const fetchedMessages = await repository.searchMessages({
        chatId: query.chatId ?? null,
        keyword: query.q ?? null,
        senderId: query.senderId ?? null,
        sentFrom:
          query.sentFrom === undefined ? null : new Date(query.sentFrom),
        sentTo: query.sentTo === undefined ? null : new Date(query.sentTo),
        limit: query.limit + 1,
        cursor: decodeCursor(query.cursor),
      });
      const messagePage = cursorPage(
        fetchedMessages,
        query.limit,
        (message) => ({ timestamp: message.sentAt, id: message.id }),
      );
      const messages = messagePage.data;
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
      return {
        data: messages.map((item) => ({
          ...item,
          executions: executionsByMessage.get(item.providerMessageId) ?? [],
        })),
        page: messagePage.page,
      };
    },
  );

  application.get(
    "/api/v1/messages/:messageId/media",
    { preHandler: requireSensitive("message.content.view", "message") },
    async (request) => {
      const parameters = messageParametersSchema.parse(request.params);
      const archived = await repository.findMessage(parameters.messageId);
      if (archived === null) {
        throw new ApplicationError(
          "MESSAGE_NOT_FOUND",
          "The message does not exist or is unavailable.",
          404,
        );
      }
      const sources = messageImageMediaSources(archived);
      const summariesByMessage =
        await options.imageSummary?.repository.listForMessageIds([
          parameters.messageId,
        ]);
      const summaries = summariesByMessage?.get(parameters.messageId) ?? [];
      return {
        data: {
          messageId: parameters.messageId,
          contentRedactedAt: archived.contentRedactedAt,
          items: messageImageMediaViews(sources, summaries).map((item) => ({
            ...item,
            previewUrl: `/api/v1/messages/${encodeURIComponent(parameters.messageId)}/image?${new URLSearchParams({ attachmentRef: item.attachmentRef }).toString()}`,
          })),
        },
      };
    },
  );

  application.get(
    "/api/v1/messages/:messageId/image",
    { preHandler: requireSensitive("message.content.view", "message") },
    async (request, reply) => {
      const parameters = messageParametersSchema.parse(request.params);
      const query = messageImageQuerySchema.parse(request.query);
      const archived = await repository.findMessage(parameters.messageId);
      if (archived === null || archived.contentRedactedAt !== null) {
        throw new ApplicationError(
          "MESSAGE_IMAGE_NOT_FOUND",
          "The message image does not exist or is unavailable.",
          404,
        );
      }
      const source = messageImageMediaSources(archived).find(
        (item) => item.source.attachmentRef === query.attachmentRef,
      );
      if (source === undefined || options.imageSummary === undefined) {
        throw new ApplicationError(
          "MESSAGE_IMAGE_NOT_FOUND",
          "The message image does not exist or is unavailable.",
          404,
        );
      }
      const loaded = await options.imageSummary.imageInput.loadForSummary(
        source.source,
      );
      if (loaded.status === "failed") {
        throw new ApplicationError(
          "MESSAGE_IMAGE_PREVIEW_UNAVAILABLE",
          "The message image preview is currently unavailable.",
          404,
        );
      }
      const data =
        /^data:(image\/(?:gif|jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/u.exec(
          loaded.part.dataUrl,
        );
      if (data?.[1] === undefined || data[2] === undefined) {
        throw new ApplicationError(
          "MESSAGE_IMAGE_PREVIEW_INVALID",
          "The message image preview could not be decoded.",
          500,
        );
      }
      return reply
        .type(data[1])
        .header("Cache-Control", "private, max-age=300")
        .send(Buffer.from(data[2], "base64"));
    },
  );

  if (options.dataExport !== undefined) {
    const dataExport = options.dataExport.service;

    application.get(
      "/api/v1/exports",
      { preHandler: requireAdmin },
      async (request) => {
        const query = pageQuerySchema.parse(request.query);
        const jobs = await dataExport.list(dataExportOwner(request), {
          limit: query.limit + 1,
          cursor: decodeCursor(query.cursor),
        });
        return cursorPage(jobs, query.limit, (job) => ({
          timestamp: job.createdAt,
          id: job.id,
        }));
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
      "/api/v1/ai/search/status",
      { preHandler: requireAdmin },
      async () => ({
        data: {
          enabled: config.enableWebSearch ?? false,
          backend: "searxng",
          ready:
            (config.enableWebSearch ?? false) &&
            options.ai?.searchTool !== undefined
              ? await options.ai.searchTool.isReady()
              : false,
        },
      }),
    );

    application.get(
      "/api/v1/ai/search/settings",
      { preHandler: requireAdmin },
      async () => {
        if (options.ai?.searchSettings === undefined) {
          throw new ApplicationError(
            "AI_WEB_SEARCH_SETTINGS_UNAVAILABLE",
            "Web search settings are unavailable.",
            503,
          );
        }
        return { data: await options.ai.searchSettings.view() };
      },
    );

    application.put(
      "/api/v1/ai/search/settings",
      {
        preHandler: requireAuditedAdmin(
          "ai.web-search.settings.update",
          "ai-web-search-settings",
        ),
      },
      async (request) => {
        if (options.ai?.searchSettings === undefined) {
          throw new ApplicationError(
            "AI_WEB_SEARCH_SETTINGS_UNAVAILABLE",
            "Web search settings are unavailable.",
            503,
          );
        }
        const result = await options.ai.searchSettings.update(
          webSearchSettingsUpdateSchema.parse(request.body),
        );
        if (result.status === "conflict") {
          throw new ApplicationError(
            "AI_WEB_SEARCH_SETTINGS_CONFLICT",
            "Web search settings changed; refresh before retrying.",
            409,
          );
        }
        return { data: result.value };
      },
    );

    application.get(
      "/api/v1/ai/image-input/settings",
      { preHandler: requireAdmin },
      async () => {
        if (options.ai?.imageInputSettings === undefined)
          throw new ApplicationError(
            "AI_IMAGE_INPUT_SETTINGS_UNAVAILABLE",
            "Image input settings are unavailable.",
            503,
          );
        return { data: await options.ai.imageInputSettings.view() };
      },
    );

    application.get(
      "/api/v1/ai/summary/settings",
      { preHandler: requireAdmin },
      async () => {
        if (options.ai?.summarySettings === undefined)
          throw new ApplicationError(
            "AI_SUMMARY_SETTINGS_UNAVAILABLE",
            "Summary settings are unavailable.",
            503,
          );
        return { data: await options.ai.summarySettings.view() };
      },
    );

    application.put(
      "/api/v1/ai/summary/settings",
      {
        preHandler: requireAuditedAdmin(
          "ai.summary.settings.update",
          "conversation-summary-settings",
        ),
      },
      async (request) => {
        if (options.ai?.summarySettings === undefined)
          throw new ApplicationError(
            "AI_SUMMARY_SETTINGS_UNAVAILABLE",
            "Summary settings are unavailable.",
            503,
          );
        const result = await options.ai.summarySettings.update(
          summarySettingsUpdateSchema.parse(request.body),
        );
        if (result.status === "conflict")
          throw new ApplicationError(
            "AI_SUMMARY_SETTINGS_CONFLICT",
            "Summary settings changed; refresh before retrying.",
            409,
          );
        if (
          result.value.enabled &&
          options.workflow?.conversationSummary !== undefined
        ) {
          void options.workflow.conversationSummary
            .enqueuePolicyRebuild({
              routeId: result.value.providerRouteId,
              baseMessageWindow: result.value.baseMessageWindow,
              redundancyMessageWindow: result.value.redundancyMessageWindow,
              includeFromMe: result.value.includeFromMe,
              timeZone: result.value.timeZone,
              summaryPolicyVersion: result.value.policyVersion ?? 1,
              correlationId: request.id,
            })
            .catch(() => {
              // Rebuild is best-effort; queued messages will retry on arrival.
            });
        }
        return { data: result.value };
      },
    );

    application.put(
      "/api/v1/ai/image-input/settings",
      {
        preHandler: requireAuditedAdmin(
          "ai.image-input.settings.update",
          "ai-image-input-settings",
        ),
      },
      async (request) => {
        if (options.ai?.imageInputSettings === undefined)
          throw new ApplicationError(
            "AI_IMAGE_INPUT_SETTINGS_UNAVAILABLE",
            "Image input settings are unavailable.",
            503,
          );
        const result = await options.ai.imageInputSettings.update(
          imageInputSettingsUpdateSchema.parse(request.body),
        );
        if (result.status === "conflict")
          throw new ApplicationError(
            "AI_IMAGE_INPUT_SETTINGS_CONFLICT",
            "Image input settings changed; refresh before retrying.",
            409,
          );
        return { data: result.value };
      },
    );

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

    application.get(
      "/api/v1/ai/usage",
      { preHandler: requireAdmin },
      async (request) => {
        const query = aiUsageQuerySchema.parse(request.query);
        return {
          data: await options.ai!.repository.getUsage({
            hours: query.hours,
            timeZone: query.timeZone,
            now: new Date(),
          }),
        };
      },
    );
  }

  if (options.workflow !== undefined) {
    const workflowRepository = options.workflow.repository;
    const manifestSigner = new WorkflowManifestPreviewSigner(
      `${config.settingsEncryptionKey}:workflow-manifest-preview:v1`,
    );
    const workflowBindingCatalog =
      async (): Promise<WorkflowBindingCatalog> => {
        const chats = [];
        let chatCursor: { timestamp: Date; id: string } | null = null;
        do {
          const page = await repository.listChats({
            limit: 100,
            cursor: chatCursor,
          });
          chats.push(...page);
          const last = page.at(-1);
          chatCursor =
            page.length === 100 && last !== undefined
              ? { timestamp: new Date(last.updatedAt), id: last.id }
              : null;
        } while (chatCursor !== null);
        const routes = await (options.ai?.management.listRoutes() ??
          Promise.resolve([]));
        const providers = await options.ai?.management.listProviders();
        const providersById = new Map(
          (providers ?? []).map((provider) => [provider.id, provider]),
        );
        return {
          aiRoutes: routes.map((route) => {
            const capabilities = new Set<WorkflowCapability>(["text"]);
            for (const providerId of route.effectiveProviderIds) {
              const provider = providersById.get(providerId);
              if (provider?.capabilities?.functionCalling)
                capabilities.add("function-calling");
              if (provider?.capabilities?.hostedWebSearch)
                capabilities.add("hosted-search");
              if (provider?.capabilities?.imageInput)
                capabilities.add("image-input");
            }
            return {
              id: route.id,
              name: route.name,
              capabilities: [...capabilities],
            };
          }),
          chats: chats.map((chat) => ({
            id: chat.providerChatId,
            name: chat.displayName ?? chat.providerChatId,
            capabilities: [],
          })),
        };
      };

    application.get(
      "/api/v1/workflows/schema",
      { preHandler: requireAdmin },
      () => ({
        data: z.toJSONSchema(workflowManifestSchema, {
          target: "draft-2020-12",
          unrepresentable: "any",
        }),
      }),
    );

    application.get(
      "/api/v1/workflows/schema/guide",
      { preHandler: requireAdmin },
      () => ({
        data: {
          format: "BubblePilotWorkflow bubblepilot.io/v1 JSON",
          rules: [
            "Use spec for workflow logic and bindings for external AI routes and chats.",
            "Use providerRouteRef and chatRefs in node config; summary Provider is global and never belongs in a node; never invent instance IDs.",
            "Keep node IDs stable, connect every node, and keep the graph acyclic.",
            "set-variable is deprecated; use render-text with Context paths for new workflows.",
            "Import always creates an unpublished candidate version.",
          ],
          contextPaths: [
            "context.event.message.text",
            "context.event.message.senderId",
            "context.event.message.attachments",
            "context.event.message.linkPreview",
            "context.event.chat.providerChatId",
            "context.history.messages",
            "context.history.participants",
            "context.outputs.<node-id>.<output>",
          ],
          standardPrompt:
            "Create one BubblePilotWorkflow JSON document matching the supplied JSON Schema and Binding Catalog. Use only listed action blocks and logical binding refs. Do not include secrets, database IDs, Markdown fences, comments, or YAML. Return JSON only.",
          deprecatedNodes: ["set-variable"],
          actionBlocks: listActionBlockDefinitions(),
          example: {
            $schema: "/api/v1/workflows/schema",
            kind: "BubblePilotWorkflow",
            apiVersion: "bubblepilot.io/v1",
            metadata: {
              name: "示例工作流",
              description: "收到消息后结束，用于展示清单结构。",
            },
            spec: {
              maxSteps: 8,
              startNodeId: "message-trigger",
              nodes: [
                {
                  id: "message-trigger",
                  type: "message-trigger",
                  version: 1,
                  config: {
                    provider: "bluebubbles",
                    chatRefs: [],
                    senderIds: [],
                    contentTypes: ["text"],
                    includeFromMe: false,
                    enabled: false,
                    text: null,
                  },
                  onSuccess: "done",
                },
                {
                  id: "done",
                  type: "end",
                  version: 1,
                  config: { result: "succeeded" },
                },
              ],
            },
            bindings: { aiRoutes: {}, chats: {} },
          },
        },
      }),
    );

    application.get(
      "/api/v1/workflows/binding-catalog",
      { preHandler: requireAdmin },
      async () => ({ data: await workflowBindingCatalog() }),
    );

    application.get(
      "/api/v1/workflows/:workflowId/versions/:version/export",
      { preHandler: requireAdmin },
      async (request, reply) => {
        const parameters = workflowVersionParametersSchema.parse(
          request.params,
        );
        const query = workflowManifestExportQuerySchema.parse(request.query);
        const principal = principals.get(request);
        if (
          query.mode === "instance-bound" &&
          principal?.kind === "session" &&
          options.auth !== undefined &&
          !(await options.auth.hasSensitiveGrant(principal.sessionId))
        ) {
          await audit(
            request,
            "workflow.export",
            "workflow",
            parameters.workflowId,
            "denied",
            principal,
            { reason: "sensitive-auth-required" },
          );
          throw new ApplicationError(
            "SENSITIVE_AUTH_REQUIRED",
            "Sensitive operation verification is required.",
            403,
          );
        }
        const version = await workflowRepository.getWorkflowVersion(
          parameters.workflowId,
          parameters.version,
        );
        if (version === null) {
          throw new ApplicationError(
            "WORKFLOW_NOT_FOUND",
            "The workflow version does not exist.",
            404,
          );
        }
        const manifest = exportWorkflowManifest({
          definition: version.definition,
          mode: query.mode,
          catalog: await workflowBindingCatalog(),
          schemaUrl: "/api/v1/workflows/schema",
        });
        sensitiveAudits.set(request, {
          action: "workflow.export",
          targetType: "workflow",
        });
        const safeName =
          version.workflowName
            .replace(/[^a-zA-Z0-9._-]+/gu, "-")
            .replace(/^-+|-+$/gu, "") || "workflow";
        return reply
          .header(
            "content-disposition",
            `attachment; filename="${safeName}.bubblepilot-workflow.json"`,
          )
          .send({ data: manifest });
      },
    );

    application.post(
      "/api/v1/workflows/import/preview",
      { preHandler: requireAdmin },
      async (request) => {
        const body = workflowManifestPreviewBodySchema.parse(request.body);
        const catalog = await workflowBindingCatalog();
        const result = importWorkflowManifest({
          manifest: body.manifest,
          catalog,
          selections: body.bindings,
        });
        const preview =
          result.manifest === null
            ? null
            : manifestSigner.issue(result.manifest, catalog);
        return {
          data: {
            valid: result.issues.every((issue) => issue.severity !== "error"),
            normalizedManifest: result.manifest,
            previewToken: preview?.token ?? null,
            expiresAt: preview?.expiresAt ?? null,
            bindings: result.resolutions,
            errors: result.issues.filter((issue) => issue.severity === "error"),
            warnings: result.issues.filter(
              (issue) => issue.severity === "warning",
            ),
            summary:
              result.manifest === null
                ? null
                : {
                    name: result.manifest.metadata.name,
                    description: result.manifest.metadata.description,
                    nodeCount: result.manifest.spec.nodes.length,
                  },
          },
        };
      },
    );

    application.post(
      "/api/v1/workflows/import",
      { preHandler: requireSensitive("workflow.import", "workflow") },
      async (request, reply) => {
        const body = workflowManifestImportBodySchema.parse(request.body);
        const catalog = await workflowBindingCatalog();
        const parsedManifest = workflowManifestSchema.safeParse(body.manifest);
        if (!parsedManifest.success) {
          throw new ApplicationError(
            "WORKFLOW_MANIFEST_INVALID",
            "The workflow manifest is invalid.",
            400,
          );
        }
        const tokenState = manifestSigner.verify(
          body.previewToken,
          parsedManifest.data,
          catalog,
        );
        if (tokenState !== "valid") {
          throw new ApplicationError(
            tokenState === "expired"
              ? "WORKFLOW_IMPORT_PREVIEW_EXPIRED"
              : "WORKFLOW_IMPORT_PREVIEW_INVALID",
            tokenState === "expired"
              ? "The workflow import preview has expired."
              : "The workflow import preview no longer matches the manifest or binding catalog.",
            tokenState === "expired" ? 410 : 409,
          );
        }
        const result = importWorkflowManifest({
          manifest: parsedManifest.data,
          catalog,
          selections: body.bindings,
        });
        if (result.definition === null || result.issues.length > 0) {
          throw new ApplicationError(
            "WORKFLOW_MANIFEST_INVALID",
            result.issues[0]?.message ?? "The workflow manifest is invalid.",
            400,
          );
        }
        const version =
          body.mode === "create"
            ? await workflowRepository.createWorkflow(
                parsedManifest.data.metadata.name,
                result.definition as never,
              )
            : await workflowRepository.createWorkflowVersion(
                body.targetWorkflowId!,
                result.definition as never,
                parsedManifest.data.metadata.name,
              );
        if (version === null) {
          throw new ApplicationError(
            "WORKFLOW_NOT_FOUND",
            "The target workflow does not exist.",
            404,
          );
        }
        return reply.status(201).send({
          data: {
            workflowId: version.workflowId,
            workflowVersion: version.version,
            status: version.status,
            definition: version.definition,
            warnings: result.issues.filter(
              (issue) => issue.severity === "warning",
            ),
          },
        });
      },
    );
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
            aiProviderAttempts: (
              (await options.ai?.repository.listAttempts(executionId)) ?? []
            ).map((attempt) => ({
              ...attempt,
              rawRequest: options.ai?.rawRequestStore?.reference(
                executionId,
                attempt.diagnostics?.requestHash ?? "",
              ) ?? { status: "unavailable" as const },
            })),
            aiToolExecutions:
              (await options.ai?.repository.listToolExecutions(executionId)) ??
              [],
            aiImageInputs:
              (await options.ai?.repository.listImageInputs(executionId)) ?? [],
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
        const definition = workflowDefinition(body.definition);
        const version = await workflowRepository.createWorkflow(body.name, {
          ...definition,
          name: body.name,
        });
        return reply.status(201).send({ data: version });
      },
    );

    application.post(
      "/api/v1/workflows/:workflowId/versions",
      { preHandler: requireAdmin },
      async (request, reply) => {
        const parameters = workflowParametersSchema.parse(request.params);
        const body = workflowVersionBodySchema.parse(request.body);
        const definition = workflowDefinition(body.definition);
        const name = body.name ?? definition.name;
        const version = await workflowRepository.createWorkflowVersion(
          parameters.workflowId,
          { ...definition, name },
          name,
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
        const routePolicies = new Map<
          string,
          "disabled" | "auto" | "required"
        >();
        for (const node of candidate?.definition.nodes ?? []) {
          const routeId =
            node.type === "ai-chat" ? node.config.providerRouteId : undefined;
          if (routeId === undefined) continue;
          const policy =
            node.type === "ai-chat"
              ? (node.config.webSearch ?? "disabled")
              : "disabled";
          const current = routePolicies.get(routeId);
          const rank = { disabled: 0, auto: 1, required: 2 };
          if (current === undefined || rank[policy] > rank[current]) {
            routePolicies.set(routeId, policy);
          }
        }
        for (const [routeId, webSearch] of routePolicies) {
          if (
            options.ai === undefined ||
            !(await options.ai.management.isRoutePublishable(
              routeId,
              webSearch,
            ))
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
        const triggerNode = version.definition.nodes.find(
          (node) => node.type === "message-trigger",
        );
        if (triggerNode?.type === "message-trigger") {
          const conditions = triggerConditions({
            chatIds: triggerNode.config.chatIds,
            senderIds: triggerNode.config.senderIds,
            contentTypes: triggerNode.config.contentTypes,
            text: triggerNode.config.text,
            timeWindow: null,
          });
          const existing = (await workflowRepository.listTriggers()).find(
            (trigger) => trigger.workflowId === parameters.workflowId,
          );
          if (existing === undefined) {
            await workflowRepository.createTrigger({
              name: `${version.workflowName} · 收到消息`,
              workflowId: parameters.workflowId,
              workflowVersion: version.version,
              conditions,
              includeFromMe: triggerNode.config.includeFromMe,
              enabled: triggerNode.config.enabled,
            });
          } else {
            await workflowRepository.updateTrigger(existing.id, {
              name: `${version.workflowName} · 收到消息`,
              conditions,
              includeFromMe: triggerNode.config.includeFromMe,
            });
            await workflowRepository.updateTriggerEnabled(
              existing.id,
              triggerNode.config.enabled,
            );
          }
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
          schemaVersion: "3",
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
            linkPreview: {
              status: "not-requested",
              errorCode: null,
              items: [],
            },
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
      { preHandler: requireAdmin },
      async (request) => {
        const query = executionListQuerySchema.parse(request.query);
        const executions = await workflowRepository.listExecutions({
          limit: query.limit + 1,
          statuses: executionStatuses(query.status),
          cursor: decodeCursor(query.cursor),
        });
        return cursorPage(executions, query.limit, (execution) => ({
          timestamp: execution.createdAt,
          id: execution.id,
        }));
      },
    );

    application.get(
      "/api/v1/conversation-compressions",
      { preHandler: requireAdmin },
      async (request) => {
        const query = compressionListQuerySchema.parse(request.query);
        const cursor = decodeCursor(query.cursor);
        const items =
          (await options.workflow?.contextState?.listCompressions?.({
            limit: query.limit + 1,
            ...(cursor === null ? {} : { cursor }),
            ...(query.chatId === undefined ? {} : { chatId: query.chatId }),
            ...(query.status === undefined ? {} : { status: query.status }),
            ...(query.reason === undefined ? {} : { reason: query.reason }),
            ...(query.provider === undefined
              ? {}
              : { provider: query.provider }),
            ...(query.startedFrom === undefined
              ? {}
              : { startedFrom: new Date(query.startedFrom) }),
            ...(query.startedTo === undefined
              ? {}
              : { startedTo: new Date(query.startedTo) }),
          })) ?? [];
        return cursorPage(items, query.limit, (item) => ({
          timestamp: item.startedAt,
          id: item.id,
        }));
      },
    );

    application.post(
      "/api/v1/conversation-compressions/rebuild",
      {
        preHandler: requireSensitive(
          "conversation-summary.rebuild",
          "conversation-summary",
        ),
      },
      async (request) => {
        const summarySettings = options.ai?.summarySettings;
        const conversationSummary = options.workflow?.conversationSummary;
        if (
          summarySettings === undefined ||
          conversationSummary === undefined
        ) {
          throw new ApplicationError(
            "AI_SUMMARY_SETTINGS_UNAVAILABLE",
            "Summary settings are unavailable.",
            503,
          );
        }
        const settings = await summarySettings.view();
        if (!settings.enabled || settings.providerRouteId === "") {
          throw new ApplicationError(
            "AI_SUMMARY_NOT_ENABLED",
            "Enable a summary Provider route before rebuilding summaries.",
            409,
          );
        }
        const queued = await conversationSummary.enqueuePolicyRebuild({
          routeId: settings.providerRouteId,
          baseMessageWindow: settings.baseMessageWindow,
          redundancyMessageWindow: settings.redundancyMessageWindow,
          includeFromMe: settings.includeFromMe,
          timeZone: settings.timeZone,
          summaryPolicyVersion: settings.policyVersion,
          correlationId: request.id,
        });
        return {
          data: { queued, summaryPolicyVersion: settings.policyVersion },
        };
      },
    );

    application.get(
      "/api/v1/conversation-compressions/:compressionId/content",
      {
        preHandler: requireSensitive(
          "conversation-summary.content.view",
          "conversation-compression",
        ),
      },
      async (request, reply) => {
        const parameters = z
          .object({ compressionId: z.string().uuid() })
          .parse(request.params);
        const content =
          (await options.workflow?.contextState?.getCompressionContent?.(
            parameters.compressionId,
          )) ?? null;
        if (content === null) {
          throw new ApplicationError(
            "CONVERSATION_COMPRESSION_NOT_FOUND",
            "The conversation compression operation does not exist.",
            404,
          );
        }
        return reply
          .header("cache-control", "no-store")
          .header("pragma", "no-cache")
          .send({ data: content });
      },
    );

    application.get(
      "/api/v1/conversation-compressions/:compressionId",
      { preHandler: requireAdmin },
      async (request) => {
        const parameters = z
          .object({ compressionId: z.string().uuid() })
          .parse(request.params);
        const items =
          (await options.workflow?.contextState?.listCompressions?.({
            limit: 1,
            id: parameters.compressionId,
          })) ?? [];
        const item = items[0];
        if (item === undefined) {
          throw new ApplicationError(
            "CONVERSATION_COMPRESSION_NOT_FOUND",
            "The conversation compression operation does not exist.",
            404,
          );
        }
        return { data: item };
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
      { preHandler: requireAdmin },
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

    application.get(
      "/api/v1/executions/:executionId/ai-attempts/:attemptId/raw-request",
      {
        preHandler: requireSensitive(
          "execution.ai-request.view",
          "workflow-execution",
        ),
      },
      async (request) => {
        const parameters = executionAttemptParametersSchema.parse(
          request.params,
        );
        const execution = await workflowRepository.getExecution(
          parameters.executionId,
        );
        if (execution === null) {
          throw new ApplicationError(
            "EXECUTION_NOT_FOUND",
            "The workflow execution does not exist.",
            404,
          );
        }
        const attempt = (
          (await options.ai?.repository.listAttempts(parameters.executionId)) ??
          []
        ).find((candidate) => candidate.id === parameters.attemptId);
        if (attempt === undefined) {
          throw new ApplicationError(
            "AI_PROVIDER_ATTEMPT_NOT_FOUND",
            "The AI provider attempt does not exist in this execution.",
            404,
          );
        }
        const requestBody = options.ai?.rawRequestStore?.get(
          parameters.executionId,
          attempt.diagnostics?.requestHash ?? "",
        );
        if (requestBody === undefined || requestBody === null) {
          throw new ApplicationError(
            "AI_RAW_REQUEST_UNAVAILABLE",
            "The raw AI request is no longer available in this process.",
            404,
          );
        }
        return {
          data: {
            attemptId: attempt.id,
            requestHash: attempt.diagnostics?.requestHash ?? null,
            body: requestBody,
          },
        };
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
        limit: query.limit + 1,
        cursor: decodeCursor(query.cursor),
      });
      return cursorPage(messages, query.limit, (message) => ({
        timestamp: message.sentAt,
        id: message.id,
      }));
    },
  );

  application.delete(
    "/api/v1/chats/:chatId/summary",
    {
      preHandler: requireSensitive(
        "conversation-summary.clear",
        "conversation-summary",
      ),
    },
    async (request) => {
      const parameters = chatParametersSchema.parse(request.params);
      const conversationSummary = options.workflow?.conversationSummary;
      if (conversationSummary === undefined) {
        throw new ApplicationError(
          "AI_SUMMARY_SETTINGS_UNAVAILABLE",
          "Summary state is unavailable.",
          503,
        );
      }
      const result = await conversationSummary.clearChatSummary(
        parameters.chatId,
      );
      if (result === null) {
        throw new ApplicationError(
          "CHAT_NOT_FOUND",
          "The chat does not exist.",
          404,
        );
      }
      return { data: { chatId: parameters.chatId, ...result } };
    },
  );

  application.addHook("onClose", async () => {
    await options.imageSummary?.worker.stop();
    await options.workflow?.summaryWorker?.stop();
    await options.messageRetention?.stop();
    await Promise.all([
      repository.close(),
      options.auth?.close() ?? Promise.resolve(),
      options.workflow?.repository.close() ?? Promise.resolve(),
      options.workflow?.contextState?.close() ?? Promise.resolve(),
      options.ai?.repository.close() ?? Promise.resolve(),
      options.ai?.searchSettings?.repository.close() ?? Promise.resolve(),
      options.ai?.imageInputSettings?.repository.close() ?? Promise.resolve(),
      options.dataExport?.repository.close() ?? Promise.resolve(),
      options.blueBubbles?.settings.repository.close() ?? Promise.resolve(),
      options.imageSummary?.repository.close() ?? Promise.resolve(),
    ]);
  });

  return application;
}
