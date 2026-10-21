import { z } from "zod";
import { ApplicationError } from "../../app/errors.js";
import type { AiToolDefinition } from "../ai/ai-types.js";
export const pluginLimits = {
  archiveBytes: 10 * 1024 * 1024,
  expandedBytes: 30 * 1024 * 1024,
  files: 500,
  textBytes: 256 * 1024,
  timeoutMs: 30_000,
  tools: 100,
  catalogueCharacters: 24000,
  plugins: 10,
} as const;
export function pluginError(code: string, status = 400): never {
  throw new ApplicationError(
    `PLUGIN_${code}`,
    `插件操作未完成：${code}`,
    status,
  );
}
export interface PluginSkill {
  id: string;
  name: string;
  description: string;
  file: string;
  references: string[];
  contentHash: string;
}
export interface PluginServer {
  name: string;
  url: string;
  headers: Record<string, string>;
}
export interface PluginPackage {
  name: string;
  version: string;
  description: string;
  format: "portable-1" | "codex";
  skills: PluginSkill[];
  servers: PluginServer[];
  files: Record<string, string>;
  hash: string;
}
export interface ApprovedTool {
  server: string;
  definition: AiToolDefinition;
  hash: string;
}
export const connectionSchema = z
  .object({
    url: z.string().url(),
    allowPrivate: z.boolean().default(false),
    auth: z.enum(["none", "bearer", "header"]).default("none"),
    header: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9-]*$/)
      .default("X-Api-Key"),
    secret: z.string().max(8192).optional(),
  })
  .strict();
export type Connection = z.infer<typeof connectionSchema>;
export interface PluginConfiguration {
  connections: Record<string, Connection>;
  tools: ApprovedTool[];
  disabledSkills: string[];
  disabledTools: string[];
}
export interface InstalledPlugin {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  revision: string;
  package: PluginPackage;
  config: PluginConfiguration;
}
export const importSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((value) => {
        const u = new URL(value);
        return (
          u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash
        );
      }, "Use a public HTTPS Git URL without credentials"),
    ref: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/)
      .max(200)
      .optional(),
    directory: z.string().min(1).max(1024).optional(),
  })
  .strict();
