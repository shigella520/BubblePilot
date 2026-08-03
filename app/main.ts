import { buildApplication } from "./application.js";
import { loadConfig } from "./config.js";
import { AiManagementService } from "../modules/ai/ai-management-service.js";
import { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import { OpenAiCompatibleClient } from "../modules/ai/openai-compatible-client.js";
import { PostgresAiRepository } from "../modules/ai/postgres-ai-repository.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import { AuthService } from "../modules/auth/auth-service.js";
import { PostgresAuthRepository } from "../modules/auth/postgres-auth-repository.js";
import { DataExportService } from "../modules/export/export-service.js";
import { PostgresDataExportRepository } from "../modules/export/postgres-export-repository.js";
import { PostgresArchiveRepository } from "../modules/archive/postgres-archive-repository.js";
import {
  MessageRetentionService,
  MessageRetentionWorker,
} from "../modules/archive/message-retention-service.js";
import { BlueBubblesRestReplyGateway } from "../modules/integrations/bluebubbles/rest-reply-gateway.js";
import { createDefaultNodeRegistry } from "../modules/workflow/node-registry.js";
import { InProcessWorkflowExecutionDispatcher } from "../modules/workflow/execution-dispatcher.js";
import { PostgresWorkflowRepository } from "../modules/workflow/postgres-workflow-repository.js";
import { WorkflowEngine } from "../modules/workflow/workflow-engine.js";

const config = loadConfig();
const repository = new PostgresArchiveRepository(config.databaseUrl);
const workflowRepository = new PostgresWorkflowRepository(config.databaseUrl);
const aiRepository = new PostgresAiRepository(config.databaseUrl);
const authRepository = new PostgresAuthRepository(config.databaseUrl);
const dataExportRepository = new PostgresDataExportRepository(
  config.databaseUrl,
);
const messageRetention =
  config.messageRetentionDays > 0
    ? new MessageRetentionWorker(
        new MessageRetentionService(repository, config.messageRetentionDays),
      )
    : undefined;
const authService = new AuthService(authRepository, {
  loginPasswordHash: config.loginPasswordHash,
  sensitiveOperationPasswordHash: config.sensitiveOperationPasswordHash,
  sessionTtlSeconds: config.adminSessionTtlSeconds,
  sensitiveOperationTtlSeconds: config.sensitiveOperationTtlSeconds,
});
const secretResolver = new EnvironmentSecretResolver();
const aiClient = new OpenAiCompatibleClient(secretResolver);
const aiRouting = new AiRoutingService(aiRepository, aiClient, secretResolver);
const aiManagement = new AiManagementService(
  aiRepository,
  aiClient,
  secretResolver,
);
const replyGateway = new BlueBubblesRestReplyGateway({
  serverUrl: config.blueBubblesServerUrl,
  accessToken: config.blueBubblesAccessToken,
  method: config.blueBubblesSendMethod,
  timeoutMs: config.blueBubblesRequestTimeoutMs,
});
const workflowEngine = new WorkflowEngine(
  workflowRepository,
  createDefaultNodeRegistry(workflowRepository, replyGateway, {
    archive: repository,
    aiRouting,
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
  ai: { repository: aiRepository, management: aiManagement },
  workflow: {
    repository: workflowRepository,
    engine: workflowEngine,
    dispatcher: workflowDispatcher,
  },
  dataExport: {
    repository: dataExportRepository,
    service: new DataExportService(dataExportRepository),
  },
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
