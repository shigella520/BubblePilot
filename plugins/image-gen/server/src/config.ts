import { readFileSync } from "node:fs";
import { z } from "zod";

export const qualities = ["low", "medium", "high", "auto"] as const;
export type Quality = (typeof qualities)[number];
export const sizes = ["1024x1024", "1536x1024", "1024x1536", "auto"] as const;
export type Size = (typeof sizes)[number];

const integer = (value: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(value);
const cidr = z
  .string()
  .regex(/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/u);

const configObject = z
  .object({
    PORT: integer(8080, 1, 65535),
    /** Explicit bind address; when unset, choose the first non-excluded IPv4. */
    LISTEN_HOST: z.string().min(1).optional(),
    /** Comma-separated CIDRs the HTTP server must never bind to (e.g. the LAN). */
    LISTEN_EXCLUDE_CIDR: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean),
      )
      .pipe(z.array(cidr)),
    MAX_MCP_SESSIONS: integer(8, 1, 64),
    SESSION_TTL_SECONDS: integer(900, 60, 3600),
    WORKSPACE_MAX_FILES: integer(16, 2, 64),
    WORKSPACE_MAX_MIB: integer(64, 16, 256),
    ATTACHMENT_IMPORT_TIMEOUT_SECONDS: integer(45, 5, 180),
    IMAGE_API_BASE_URL: z.url().refine((value) => {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }),
    IMAGE_MODEL: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,100}$/u)
      .default("gpt-image-2"),
    IMAGE_DEFAULT_QUALITY: z.enum(qualities).default("medium"),
    IMAGE_MAX_QUALITY: z.enum(["low", "medium", "high"]).default("high"),
    IMAGE_TIMEOUT_SECONDS: integer(150, 10, 600),
    IMAGE_DAILY_LIMIT: integer(20, 0, 10000),
    IMAGE_SESSION_LIMIT: integer(4, 1, 100),
    IMAGE_QUOTA_TIMEZONE: z
      .string()
      .default("Asia/Shanghai")
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format();
          return true;
        } catch {
          return false;
        }
      }),
    /** auto: single input uses `image`, multiple inputs use repeated `image[]`. */
    IMAGE_EDIT_FIELD: z.enum(["auto", "image", "image[]"]).default("auto"),
    QUOTA_FILE: z.string().min(1).default("/data/quota.json"),
    MCP_BEARER_TOKEN: z.string().optional(),
    MCP_BEARER_TOKEN_FILE: z.string().optional(),
    IMAGE_API_KEY: z.string().optional(),
    IMAGE_API_KEY_FILE: z.string().optional(),
  })
  .strict();
export const configSchema = configObject
  .refine((c) => !!c.MCP_BEARER_TOKEN !== !!c.MCP_BEARER_TOKEN_FILE, {
    path: ["MCP_BEARER_TOKEN"],
    message: "Provide exactly one of MCP_BEARER_TOKEN or MCP_BEARER_TOKEN_FILE",
  })
  .refine((c) => !!c.IMAGE_API_KEY !== !!c.IMAGE_API_KEY_FILE, {
    path: ["IMAGE_API_KEY"],
    message: "Provide exactly one of IMAGE_API_KEY or IMAGE_API_KEY_FILE",
  })
  .refine(
    (c) =>
      c.IMAGE_DEFAULT_QUALITY === "auto" ||
      qualities.indexOf(c.IMAGE_DEFAULT_QUALITY) <=
        qualities.indexOf(c.IMAGE_MAX_QUALITY),
    {
      path: ["IMAGE_DEFAULT_QUALITY"],
      message: "Default quality must not exceed the maximum",
    },
  );
export type Config = Omit<
  z.infer<typeof configSchema>,
  | "MCP_BEARER_TOKEN"
  | "MCP_BEARER_TOKEN_FILE"
  | "IMAGE_API_KEY"
  | "IMAGE_API_KEY_FILE"
>;

const ownKeys = new Set(Object.keys(configObject.shape));

function secret(value: string | undefined, file: string | undefined) {
  const raw = (file ? readFileSync(file, "utf8") : (value ?? "")).trim();
  if (raw.length < 24 || raw.length > 4096 || /[\r\n]/u.test(raw))
    throw new Error("Invalid secret");
  return raw;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const relevant = Object.fromEntries(
    Object.entries(env).filter(([key]) => ownKeys.has(key)),
  );
  const result = configSchema.safeParse(relevant);
  if (!result.success)
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  const {
    MCP_BEARER_TOKEN,
    MCP_BEARER_TOKEN_FILE,
    IMAGE_API_KEY,
    IMAGE_API_KEY_FILE,
    ...config
  } = result.data;
  return {
    config: config satisfies Config,
    token: secret(MCP_BEARER_TOKEN, MCP_BEARER_TOKEN_FILE),
    apiKey: secret(IMAGE_API_KEY, IMAGE_API_KEY_FILE),
  };
}

/** Clamp a requested quality to the configured ceiling; auto keeps upstream choice. */
export function effectiveQuality(
  requested: Quality | undefined,
  config: Pick<Config, "IMAGE_DEFAULT_QUALITY" | "IMAGE_MAX_QUALITY">,
): Quality {
  const quality = requested ?? config.IMAGE_DEFAULT_QUALITY;
  if (quality === "auto")
    return config.IMAGE_MAX_QUALITY === "high"
      ? "auto"
      : config.IMAGE_MAX_QUALITY;
  return qualities.indexOf(quality) >
    qualities.indexOf(config.IMAGE_MAX_QUALITY)
    ? config.IMAGE_MAX_QUALITY
    : quality;
}
