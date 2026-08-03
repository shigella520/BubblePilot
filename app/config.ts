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

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_HOST: z.string().min(1).default("0.0.0.0"),
  APP_PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  DATABASE_URL: z.string().min(1),
  API_ACCESS_TOKEN: runtimeSecretSchema,
  BLUEBUBBLES_WEBHOOK_SECRET: runtimeSecretSchema,
  MONITORED_CHAT_IDS: z.string().default(""),
  WEBHOOK_BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(10_485_760)
    .default(1_048_576),
  LOG_LEVEL: z.enum(logLevels).default("info"),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  apiAccessToken: string;
  blueBubblesWebhookSecret: string;
  monitoredChatIds: ReadonlySet<string>;
  webhookBodyLimitBytes: number;
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

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.APP_HOST,
    port: parsed.APP_PORT,
    databaseUrl: parsed.DATABASE_URL,
    apiAccessToken: parsed.API_ACCESS_TOKEN,
    blueBubblesWebhookSecret: parsed.BLUEBUBBLES_WEBHOOK_SECRET,
    monitoredChatIds,
    webhookBodyLimitBytes: parsed.WEBHOOK_BODY_LIMIT_BYTES,
    logLevel: parsed.LOG_LEVEL,
  };
}
