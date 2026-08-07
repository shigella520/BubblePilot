import { z } from "zod";

const logLevels = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

const runtimeSecretSchema = z
  .string()
  .min(32)
  .refine(
    (value) => !value.startsWith("CHANGE_ME"),
    "Replace the example secret before startup.",
  );

const externalSecretSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !value.startsWith("CHANGE_ME"),
    "Replace the example secret before startup.",
  );

const passwordHashSchema = z
  .string()
  .regex(
    /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/u,
    "Use a BubblePilot scrypt password hash.",
  );

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    APP_HOST: z.string().min(1).default("0.0.0.0"),
    APP_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
    DATABASE_URL: z.string().min(1),
    API_ACCESS_TOKEN: runtimeSecretSchema,
    SETTINGS_ENCRYPTION_KEY: runtimeSecretSchema.optional(),
    APP_LOGIN_PASSWORD_HASH: passwordHashSchema,
    SENSITIVE_OPERATION_PASSWORD_HASH: passwordHashSchema,
    ADMIN_SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(900)
      .max(604_800)
      .default(43_200),
    SENSITIVE_OPERATION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(3_600)
      .default(300),
    SESSION_COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),
    BLUEBUBBLES_WEBHOOK_SECRET: runtimeSecretSchema,
    BLUEBUBBLES_SERVER_URL: z.string().url(),
    BLUEBUBBLES_ACCESS_TOKEN: externalSecretSchema,
    BLUEBUBBLES_SEND_METHOD: z
      .enum(["private-api", "apple-script"])
      .default("private-api"),
    BLUEBUBBLES_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(30_000),
    ENABLE_WEB_SEARCH: z
      .preprocess(
        (value) =>
          typeof value === "string"
            ? ["1", "true", "yes", "on"].includes(value.toLowerCase())
            : value,
        z.boolean(),
      )
      .default(false),
    SEARXNG_BASE_URL: z.string().url().default("http://searxng:8080"),
    SEARXNG_ENGINES: z.string().default(""),
    SEARXNG_LANGUAGE: z
      .string()
      .trim()
      .min(2)
      .max(35)
      .regex(/^[a-z0-9_-]+$/iu)
      .default("zh-CN"),
    MONITORED_CHAT_IDS: z.string().default(""),
    MESSAGE_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(0)
      .max(36_500)
      .default(90),
    WEBHOOK_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(10_485_760)
      .default(1_048_576),
    RATE_LIMIT_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3_600)
      .default(60),
    ADMIN_RATE_LIMIT_MAX: z.coerce
      .number()
      .int()
      .min(10)
      .max(100_000)
      .default(600),
    WEBHOOK_RATE_LIMIT_MAX: z.coerce
      .number()
      .int()
      .min(10)
      .max(100_000)
      .default(300),
    WORKFLOW_MAX_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(256)
      .default(4),
    WORKFLOW_QUEUE_CAPACITY: z.coerce
      .number()
      .int()
      .min(0)
      .max(10_000)
      .default(64),
    WORKFLOW_QUEUE_WAIT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(300_000)
      .default(30_000),
    STALE_RETRY_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .max(86_400)
      .default(300),
    LOG_LEVEL: z.enum(logLevels).default("info"),
  })
  .refine(
    (value) =>
      value.APP_LOGIN_PASSWORD_HASH !== value.SENSITIVE_OPERATION_PASSWORD_HASH,
    {
      message: "Login and sensitive operation passwords must be different.",
      path: ["SENSITIVE_OPERATION_PASSWORD_HASH"],
    },
  );

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  apiAccessToken: string;
  settingsEncryptionKey: string;
  loginPasswordHash: string;
  sensitiveOperationPasswordHash: string;
  adminSessionTtlSeconds: number;
  sensitiveOperationTtlSeconds: number;
  sessionCookieSecure: "auto" | "true" | "false";
  blueBubblesWebhookSecret: string;
  blueBubblesServerUrl: string;
  blueBubblesAccessToken: string;
  blueBubblesSendMethod: "private-api" | "apple-script";
  blueBubblesRequestTimeoutMs: number;
  enableWebSearch?: boolean;
  searxngBaseUrl?: string;
  searxngEngines?: readonly string[];
  searxngLanguage?: string;
  monitoredChatIds: ReadonlySet<string>;
  messageRetentionDays: number;
  webhookBodyLimitBytes: number;
  rateLimitWindowSeconds: number;
  adminRateLimitMax: number;
  webhookRateLimitMax: number;
  workflowMaxConcurrency: number;
  workflowQueueCapacity: number;
  workflowQueueWaitMs: number;
  staleRetrySeconds: number;
  logLevel: (typeof logLevels)[number];
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const monitoredChatIds = new Set(
    parsed.MONITORED_CHAT_IDS.split(",")
      .map((chatId) => chatId.trim())
      .filter((chatId) => chatId.length > 0),
  );
  const searxngEngines = [
    ...new Set(
      parsed.SEARXNG_ENGINES.split(",")
        .map((engine) => engine.trim())
        .filter((engine) => /^[a-z0-9_-]+$/iu.test(engine)),
    ),
  ];

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.APP_HOST,
    port: parsed.APP_PORT,
    databaseUrl: parsed.DATABASE_URL,
    apiAccessToken: parsed.API_ACCESS_TOKEN,
    settingsEncryptionKey:
      parsed.SETTINGS_ENCRYPTION_KEY ?? parsed.API_ACCESS_TOKEN,
    loginPasswordHash: parsed.APP_LOGIN_PASSWORD_HASH,
    sensitiveOperationPasswordHash: parsed.SENSITIVE_OPERATION_PASSWORD_HASH,
    adminSessionTtlSeconds: parsed.ADMIN_SESSION_TTL_SECONDS,
    sensitiveOperationTtlSeconds: parsed.SENSITIVE_OPERATION_TTL_SECONDS,
    sessionCookieSecure: parsed.SESSION_COOKIE_SECURE,
    blueBubblesWebhookSecret: parsed.BLUEBUBBLES_WEBHOOK_SECRET,
    blueBubblesServerUrl: parsed.BLUEBUBBLES_SERVER_URL.replace(/\/$/, ""),
    blueBubblesAccessToken: parsed.BLUEBUBBLES_ACCESS_TOKEN,
    blueBubblesSendMethod: parsed.BLUEBUBBLES_SEND_METHOD,
    blueBubblesRequestTimeoutMs: parsed.BLUEBUBBLES_REQUEST_TIMEOUT_MS,
    enableWebSearch: parsed.ENABLE_WEB_SEARCH,
    searxngBaseUrl: parsed.SEARXNG_BASE_URL.replace(/\/+$/u, ""),
    searxngEngines,
    searxngLanguage: parsed.SEARXNG_LANGUAGE,
    monitoredChatIds,
    messageRetentionDays: parsed.MESSAGE_RETENTION_DAYS,
    webhookBodyLimitBytes: parsed.WEBHOOK_BODY_LIMIT_BYTES,
    rateLimitWindowSeconds: parsed.RATE_LIMIT_WINDOW_SECONDS,
    adminRateLimitMax: parsed.ADMIN_RATE_LIMIT_MAX,
    webhookRateLimitMax: parsed.WEBHOOK_RATE_LIMIT_MAX,
    workflowMaxConcurrency: parsed.WORKFLOW_MAX_CONCURRENCY,
    workflowQueueCapacity: parsed.WORKFLOW_QUEUE_CAPACITY,
    workflowQueueWaitMs: parsed.WORKFLOW_QUEUE_WAIT_MS,
    staleRetrySeconds: parsed.STALE_RETRY_SECONDS,
    logLevel: parsed.LOG_LEVEL,
  };
}
