import { buildApplication } from "./application.js";
import { loadConfig } from "./config.js";
import { AiManagementService } from "../modules/ai/ai-management-service.js";
import { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import { OpenAiCompatibleClient } from "../modules/ai/openai-compatible-client.js";
import { AgentRunner } from "../modules/ai/agent-runner.js";
import { SearxngWebSearchTool } from "../modules/ai/web-search-tool.js";
import { PostgresAiRepository } from "../modules/ai/postgres-ai-repository.js";
import { PostgresWebSearchSettingsRepository } from "../modules/ai/postgres-web-search-settings-repository.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import { WebSearchSettingsService } from "../modules/ai/web-search-settings-service.js";
import { PostgresImageInputSettingsRepository } from "../modules/ai/postgres-image-input-settings-repository.js";
import { ImageInputSettingsService } from "../modules/ai/image-input-settings-service.js";
import { NativeImageInputService } from "../modules/ai/native-image-input.js";
import { AuthService } from "../modules/auth/auth-service.js";
import { PostgresAuthRepository } from "../modules/auth/postgres-auth-repository.js";
import { DataExportService } from "../modules/export/export-service.js";
import { PostgresDataExportRepository } from "../modules/export/postgres-export-repository.js";
import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";
import {
  MessageRetentionService,
  MessageRetentionWorker,
} from "../modules/archive/message-retention-service.js";
import { ManagedBlueBubblesReplyGateway } from "../modules/integrations/bluebubbles/managed-reply-gateway.js";
import { PostgresBlueBubblesSettingsRepository } from "../modules/integrations/bluebubbles/postgres-settings-repository.js";
import { SettingsCipher } from "../modules/integrations/bluebubbles/settings-cipher.js";
import { BlueBubblesSettingsService } from "../modules/integrations/bluebubbles/settings-service.js";
import { ManagedLinkPreviewEnricher } from "../modules/integrations/bluebubbles/link-preview-enricher.js";
import { createDefaultNodeRegistry } from "../modules/workflow/node-registry.js";
import { InProcessWorkflowExecutionDispatcher } from "../modules/workflow/execution-dispatcher.js";
import { PostgresWorkflowRepository } from "../modules/workflow/postgres-workflow-repository.js";
import { WorkflowEngine } from "../modules/workflow/workflow-engine.js";
import { ConversationContextService } from "../modules/workflow/conversation-context-service.js";

const config = loadConfig();
const repository = new PostgresArchiveRepository(
  config.databaseUrl,
  config.databaseQueryTimeoutMs,
);
const workflowRepository = new PostgresWorkflowRepository(
  config.databaseUrl,
  config.databaseQueryTimeoutMs,
);
const aiRepository = new PostgresAiRepository(
  config.databaseUrl,
  config.settingsEncryptionKey,
  config.databaseQueryTimeoutMs,
);
const webSearchSettingsRepository = new PostgresWebSearchSettingsRepository(
  config.databaseUrl,
  config.databaseQueryTimeoutMs,
);
const webSearchSettings = new WebSearchSettingsService(
  webSearchSettingsRepository,
  {
    maxAttempts: 2,
    attemptTimeoutMs: 8_000,
    retryDelayMs: 300,
    maxResults: 5,
    failurePolicy: "mode-default",
  },
);
const imageInputSettingsRepository = new PostgresImageInputSettingsRepository(
  config.databaseUrl,
  config.databaseQueryTimeoutMs,
);
const imageInputSettings = new ImageInputSettingsService(
  imageInputSettingsRepository,
  {
    enabled: false,
    includeAttachments: true,
    includeLinkPreviewImages: true,
    trustedLinkPreviewHosts: [],
    maxCurrentAttachments: 4,
    maxHistoryImages: 2,
    maxTotalImages: 6,
    maxImageBytes: 10 * 1024 * 1024,
    maxTotalBytes: 20 * 1024 * 1024,
    fetchTimeoutMs: 15_000,
    detail: "high",
  },
);
const authRepository = new PostgresAuthRepository(
  config.databaseUrl,
  config.databaseQueryTimeoutMs,
);
const dataExportRepository = new PostgresDataExportRepository(
  config.databaseUrl,
  config.databaseQueryTimeoutMs,
);
const blueBubblesSettingsRepository = new PostgresBlueBubblesSettingsRepository(
  config.databaseUrl,
  config.databaseQueryTimeoutMs,
);
const blueBubblesSettings = new BlueBubblesSettingsService(
  blueBubblesSettingsRepository,
  new SettingsCipher(config.settingsEncryptionKey),
  {
    serverUrl: config.blueBubblesServerUrl,
    accessToken: config.blueBubblesAccessToken,
    webhookSecret: config.blueBubblesWebhookSecret,
    sendMethod: config.blueBubblesSendMethod,
    requestTimeoutMs: config.blueBubblesRequestTimeoutMs,
    linkPreviewEnabled: true,
    openGraphFallbackEnabled: true,
    openGraphTimeoutMs: 5_000,
  },
);
const authService = new AuthService(authRepository, {
  loginPasswordHash: config.loginPasswordHash,
  sensitiveOperationPasswordHash: config.sensitiveOperationPasswordHash,
  sessionTtlSeconds: config.adminSessionTtlSeconds,
  sensitiveOperationTtlSeconds: config.sensitiveOperationTtlSeconds,
});
const secretResolver = new EnvironmentSecretResolver();
const aiClient = new OpenAiCompatibleClient(
  secretResolver,
  undefined,
  config.aiRequestTraceEnabled ?? false,
);
const aiRouting = new AiRoutingService(
  aiRepository,
  aiClient,
  secretResolver,
  config.enableWebSearch ?? false,
);
const webSearchTool = new SearxngWebSearchTool({
  baseUrl: config.searxngBaseUrl ?? "http://searxng:8080",
  engines: config.searxngEngines ?? [],
  language: config.searxngLanguage ?? "zh-CN",
  timeoutMs: 8_000,
  maxResults: 5,
});
const aiManagement = new AiManagementService(
  aiRepository,
  aiClient,
  secretResolver,
  config.enableWebSearch ?? false,
  webSearchTool,
);
const aiAgent = new AgentRunner(
  aiRouting,
  webSearchTool,
  aiRepository,
  webSearchSettings,
);
const conversationContext = new ConversationContextService(
  config.databaseUrl,
  aiRouting,
  config.databaseQueryTimeoutMs,
);
const messageRetention =
  config.messageRetentionDays > 0
    ? new MessageRetentionWorker(
        new MessageRetentionService(
          repository,
          config.messageRetentionDays,
          10_000,
          () => conversationContext.invalidateAll(),
        ),
      )
    : undefined;
const replyGateway = new ManagedBlueBubblesReplyGateway(blueBubblesSettings);
const linkPreviewEnricher = new ManagedLinkPreviewEnricher(blueBubblesSettings);
const nativeImageInput = new NativeImageInputService(
  imageInputSettings,
  blueBubblesSettings,
  aiRepository,
);
const workflowEngine = new WorkflowEngine(
  workflowRepository,
  createDefaultNodeRegistry(workflowRepository, replyGateway, {
    archive: repository,
    aiRouting,
    aiAgent,
    imageInput: nativeImageInput,
    conversationContext,
  }),
  {
    maxConcurrency: config.workflowMaxConcurrency,
    queueCapacity: config.workflowQueueCapacity,
    queueWaitMs: config.workflowQueueWaitMs,
  },
);
const workflowDispatcher = new InProcessWorkflowExecutionDispatcher(
  workflowEngine,
);
const application = buildApplication(config, repository, {
  auth: authService,
  ai: {
    repository: aiRepository,
    management: aiManagement,
    searchTool: webSearchTool,
    searchSettings: webSearchSettings,
    imageInputSettings,
  },
  workflow: {
    repository: workflowRepository,
    engine: workflowEngine,
    dispatcher: workflowDispatcher,
    contextState: conversationContext,
  },
  dataExport: {
    repository: dataExportRepository,
    service: new DataExportService(dataExportRepository),
  },
  blueBubbles: { settings: blueBubblesSettings, linkPreviewEnricher },
  ...(messageRetention === undefined ? {} : { messageRetention }),
});

const shutdown = async (signal: string) => {
  application.log.info({ signal }, "Shutting down BubblePilot");
  await application.close();
  process.exitCode = 0;
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await application.listen({ host: config.host, port: config.port });
} catch (error) {
  application.log.fatal({ err: error }, "BubblePilot failed to start");
  await application.close();
  process.exitCode = 1;
}
