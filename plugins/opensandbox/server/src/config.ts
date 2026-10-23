import { readFileSync } from "node:fs";
import { z } from "zod";

const integer = (value: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(value);
export const configSchema = z.object({
  PORT: integer(8080, 1, 65535),
  MAX_CONCURRENT_SANDBOXES: integer(1, 1, 8),
  MAX_MCP_SESSIONS: integer(64, 1, 256),
  SANDBOX_TTL_SECONDS: integer(600, 60, 1800),
  SANDBOX_MEMORY_MIB: integer(512, 128, 4096),
  SANDBOX_IMAGE: z
    .string()
    .regex(
      /^(?:python:3\.12[a-zA-Z0-9_.-]*|ghcr\.io\/shigella520\/bubblepilot-sandbox-python(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127})?)@sha256:[a-f0-9]{64}$/,
    ),
  ADAPTER_INSTANCE_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  OPENSANDBOX_URL: z.url().refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  }),
  MCP_TOKEN_FILE: z.string().min(1),
  OPENSANDBOX_API_KEY_FILE: z.string().min(1),
});
export type Config = z.infer<typeof configSchema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = configSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  const secret = (path: string) => {
    const value = readFileSync(path, "utf8").trim();
    if (value.length < 24 || value.length > 4096 || /[\r\n]/.test(value))
      throw new Error("Invalid secret file");
    return value;
  };
  return {
    config: result.data,
    token: secret(result.data.MCP_TOKEN_FILE),
    apiKey: secret(result.data.OPENSANDBOX_API_KEY_FILE),
  };
}
