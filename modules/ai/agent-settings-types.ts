import { z } from "zod";
export const agentRuntimeSettingsSchema = z.object({
  maxToolCalls: z.number().int().min(1).max(30),
  maxToolOutputCharacters: z.number().int().min(4_000).max(100_000),
  maxToolDurationMs: z.number().int().min(5_000).max(180_000),
});
export type AgentRuntimeSettings = z.infer<typeof agentRuntimeSettingsSchema>;
export const defaultAgentSettings: Readonly<AgentRuntimeSettings> =
  Object.freeze({
    maxToolCalls: 10,
    maxToolOutputCharacters: 24_000,
    maxToolDurationMs: 60_000,
  });
export interface AgentSettingsView extends AgentRuntimeSettings {
  source: "defaults" | "database";
  version: number;
  updatedAt: string | null;
}
export const agentSettingsUpdateSchema = agentRuntimeSettingsSchema.extend({
  expectedVersion: z.number().int().min(0),
});
export type AgentSettingsUpdate = z.infer<typeof agentSettingsUpdateSchema>;
export type AgentBudgetReason = "tool-calls" | "tool-output" | "tool-duration";
export interface AgentBudgetSnapshot {
  settings: AgentSettingsView;
  modelTurns: number;
  toolCalls: number;
  toolOutputCharacters: number;
  toolDurationMs: number;
  finalizingDueToBudget: boolean;
  reasons: AgentBudgetReason[];
  citationHandling?: {
    invalidResponses: number;
    correctionAttempts: number;
    finalAction: "corrected" | "markers-removed" | "failed";
  };
  outcome: "completed" | "budget-completed" | "failed";
}
