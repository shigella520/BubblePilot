import { z } from "zod";

const parameterValueSchema = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.boolean(),
]);

const aiProviderConfigurationBaseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  apiKind: z.enum(["chat-completions", "responses"]),
  baseUrl: z
    .string()
    .url()
    .max(2_000)
    .refine(
      (value) => ["http:", "https:"].includes(new URL(value).protocol),
      "The AI provider base URL must use HTTP or HTTPS.",
    ),
  model: z.string().trim().min(1).max(200),
  secretRef: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
    .optional(),
  secret: z.string().min(1).max(4_096).optional(),
  parameters: z
    .record(
      z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
      parameterValueSchema,
    )
    .refine((value) => Object.keys(value).length <= 20, {
      message: "A provider can define at most 20 parameters.",
    })
    .default({}),
  requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  enabled: z.boolean().default(true),
  capabilities: z
    .object({
      functionCalling: z.boolean().default(false),
      hostedWebSearch: z.boolean().default(false),
    })
    .default({ functionCalling: false, hostedWebSearch: false }),
});

// API keys are optional: local OpenAI-compatible servers such as Ollama do
// not require authentication. Remote providers can still provide secret or
// secretRef as usual.
export const aiProviderConfigurationSchema = aiProviderConfigurationBaseSchema;

export const aiProviderUpdateSchema = aiProviderConfigurationBaseSchema.extend({
  expectedVersion: z.number().int().positive(),
});

export const aiProviderEnabledSchema = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().positive(),
});

export const aiProviderReorderSchema = z.object({
  providers: z
    .array(
      z.object({
        id: z.string().uuid(),
        expectedVersion: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(100),
});

export const aiRouteRetryPolicySchema = z.object({
  maxRounds: z.number().int().min(1).max(5).default(2),
  initialDelayMs: z.number().int().min(0).max(10_000).default(500),
});

export const aiRouteDegradePolicySchema = z.object({
  failureThreshold: z.number().int().min(1).max(100).default(3),
  cooldownMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
});

export const aiRouteConfigurationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  providerIds: z.array(z.string().uuid()).max(100).default([]),
  fallbackEnabled: z.boolean().default(true),
  retryPolicy: aiRouteRetryPolicySchema.default({
    maxRounds: 2,
    initialDelayMs: 500,
  }),
  degradePolicy: aiRouteDegradePolicySchema.default({
    failureThreshold: 3,
    cooldownMs: 60_000,
  }),
  enabled: z.boolean().default(true),
});

export const aiRouteUpdateSchema = aiRouteConfigurationSchema.extend({
  expectedVersion: z.number().int().positive(),
});

export const aiRouteEnabledSchema = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().positive(),
});

export type AiApiKind = "chat-completions" | "responses";
export type AiCapabilityProbeState = "verified" | "failed" | "unknown";
export type WebSearchPolicy = "disabled" | "auto" | "required";
export interface AiProviderCapabilities {
  functionCalling: boolean;
  hostedWebSearch: boolean;
}
export interface AiProviderCapabilityProbe {
  functionCalling: AiCapabilityProbeState;
  hostedWebSearch: AiCapabilityProbeState;
  checkedAt: string | null;
}
export type AiProviderParameters = Readonly<
  Record<string, string | number | boolean>
>;
export type AiProviderHealthState = "healthy" | "degraded" | "half-open";

export interface AiProviderConfiguration {
  name: string;
  apiKind: AiApiKind;
  baseUrl: string;
  model: string;
  secretRef?: string | undefined;
  secret?: string | null | undefined;
  parameters: AiProviderParameters;
  requestTimeoutMs: number;
  enabled: boolean;
  capabilities?: AiProviderCapabilities | undefined;
}

export interface AiProviderRecord extends AiProviderConfiguration {
  secret?: string | null | undefined;
  id: string;
  sortOrder: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  capabilityProbe?: AiProviderCapabilityProbe | undefined;
}

export interface AiProviderHealth {
  providerId: string;
  state: AiProviderHealthState;
  consecutiveFailures: number;
  degradedUntil: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
  version: number;
  updatedAt: string;
}

export interface AiProviderView extends Omit<
  AiProviderRecord,
  "secret" | "secretRef"
> {
  secretConfigured: boolean;
  health: AiProviderHealth;
  capabilityProbe: AiProviderCapabilityProbe;
}

export interface AiRouteRetryPolicy {
  maxRounds: number;
  initialDelayMs: number;
}

export interface AiRouteDegradePolicy {
  failureThreshold: number;
  cooldownMs: number;
}

export interface AiRouteConfiguration {
  name: string;
  providerIds: readonly string[];
  fallbackEnabled: boolean;
  retryPolicy: AiRouteRetryPolicy;
  degradePolicy: AiRouteDegradePolicy;
  enabled: boolean;
}

export interface AiProviderRouteRecord extends AiRouteConfiguration {
  id: string;
  versionId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiProviderRouteView extends AiProviderRouteRecord {
  configuredProviderIds: readonly string[];
  effectiveProviderIds: readonly string[];
  unavailableProviderIds: readonly string[];
}

export interface AiProviderTestResult {
  success: boolean;
  providerId: string;
  model: string;
  durationMs: number;
  errorCode: string | null;
  message: string;
}

export interface AiRouteSnapshot {
  route: AiProviderRouteRecord;
  providers: readonly AiProviderRecord[];
}

export interface AiCandidate {
  provider: AiProviderRecord;
  healthState: AiProviderHealthState;
}

export interface AiCandidateSelection {
  candidates: readonly AiCandidate[];
  nextAvailableAt: string | null;
}

export interface AiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: readonly AiToolCall[];
}

export interface AiToolDefinition {
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}

export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AiChatRequest {
  messages: readonly AiChatMessage[];
  maxOutputTokens: number;
  temperature: number | null;
  timeoutMs: number;
  clientRequestId?: string;
  webSearch?: WebSearchPolicy | undefined;
  maxToolCalls?: number;
  tools?: readonly AiToolDefinition[];
  toolChoice?: "auto" | "required";
}

export interface AiCallDiagnostics {
  clientRequestId: string | null;
  providerRequestId: string | null;
  httpStatus: number | null;
  requestHash: string;
  requestMessageCount: number;
  requestCharacters: number;
  responseBytes: number | null;
  responseBodyHash: string | null;
  responseFinishReason: string | null;
  responseContentCharacters: number | null;
  responseReasoningCharacters: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  cachedPromptTokens: number | null;
  cacheWritePromptTokens: number | null;
  cacheMissPromptTokens: number | null;
}

export type AiFailureCategory =
  | "timeout"
  | "connection"
  | "rate-limit"
  | "server-error"
  | "authentication"
  | "model"
  | "invalid-response"
  | "empty-output"
  | "content-safety"
  | "configuration";

export interface AiCallFailure {
  status: "failed";
  category: AiFailureCategory;
  code: string;
  summary: string;
  retryable: boolean;
  fallbackAllowed: boolean;
  countsForDegrade: boolean;
  durationMs: number;
  diagnostics?: AiCallDiagnostics;
}

export type AiCallResult =
  | {
      status: "succeeded";
      text: string;
      toolCalls?: readonly AiToolCall[];
      durationMs: number;
      diagnostics?: AiCallDiagnostics;
    }
  | AiCallFailure;

export interface AiAttemptRecordInput {
  executionId: string;
  nodeId: string;
  routeId: string;
  routeVersion: number;
  providerId: string;
  providerName: string;
  providerVersion: number;
  model: string;
  round: number;
  sequence: number;
  status: "succeeded" | "failed";
  selectionHealthState: AiProviderHealthState;
  healthState: AiProviderHealthState;
  durationMs: number;
  errorCategory: AiFailureCategory | null;
  errorCode: string | null;
  retryable: boolean | null;
  fallbackAllowed: boolean | null;
  diagnostics: AiCallDiagnostics | null;
}

export interface AiProviderAttemptView extends AiAttemptRecordInput {
  id: string;
  createdAt: string;
}

export interface AiRouteSuccess {
  status: "succeeded";
  text: string;
  toolCalls: readonly AiToolCall[];
  providerId: string;
  providerName: string;
  providerVersion: number;
  model: string;
  routeVersion: number;
  round: number;
  attemptCount: number;
  durationMs: number;
  diagnostics: AiCallDiagnostics | null;
}

export interface AiRouteFailure {
  status: "failed";
  code: string;
  summary: string;
  retryable: boolean;
  attemptCount: number;
}

export type AiRouteResult = AiRouteSuccess | AiRouteFailure;

export interface AiRouteRequest {
  executionId: string;
  nodeId: string;
  routeId: string;
  messages: readonly AiChatMessage[];
  maxOutputTokens: number;
  temperature: number | null;
  timeoutMs: number;
  maxOutputCharacters: number;
  outputFormat: "text" | "json";
  protectedPrompt: string | null;
  webSearch?: WebSearchPolicy | undefined;
  tools?: readonly AiToolDefinition[];
  toolChoice?: "auto" | "required";
  preferredProviderId?: string;
}

export interface AiToolExecutionRecordInput {
  executionId: string;
  nodeId: string;
  providerId: string;
  toolCallId: string;
  toolName: string;
  status: "succeeded" | "failed";
  durationMs: number;
  resultCount: number | null;
  queryHash: string;
  errorCode: string | null;
}

export interface AiToolExecutionView extends AiToolExecutionRecordInput {
  id: string;
  createdAt: string;
}

export function normalizeAiBaseUrl(value: string): string {
  return value.replace(/\/+$/u, "");
}
