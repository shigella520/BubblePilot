import type {
  AgentBudgetReason,
  AgentBudgetSnapshot,
  AgentSettingsView,
} from "./agent-settings-types.js";

export interface AgentToolContext {
  signal: AbortSignal;
  deadline: number;
  maxOutputCharacters: number;
}
export class AgentToolTimeout extends Error {}
export class AgentBudget {
  readonly snapshot: AgentBudgetSnapshot;
  constructor(settings: AgentSettingsView) {
    this.snapshot = {
      settings: structuredClone(settings),
      modelTurns: 0,
      toolCalls: 0,
      toolOutputCharacters: 0,
      toolDurationMs: 0,
      finalizingDueToBudget: false,
      reasons: [],
      outcome: "failed",
    };
  }
  exhaust(reason: AgentBudgetReason) {
    if (!this.snapshot.reasons.includes(reason))
      this.snapshot.reasons.push(reason);
    this.snapshot.finalizingDueToBudget = true;
  }
  get remainingCharacters() {
    return Math.max(
      0,
      this.snapshot.settings.maxToolOutputCharacters -
        this.snapshot.toolOutputCharacters,
    );
  }
  get exhausted() {
    const s = this.snapshot;
    if (s.toolCalls >= s.settings.maxToolCalls) this.exhaust("tool-calls");
    if (!this.remainingCharacters) this.exhaust("tool-output");
    if (s.toolDurationMs >= s.settings.maxToolDurationMs)
      this.exhaust("tool-duration");
    return s.finalizingDueToBudget;
  }
  control() {
    return JSON.stringify({
      status: "unavailable",
      errorCode: "AI_AGENT_TOOL_LIMIT_REACHED",
      reason: this.snapshot.reasons[0] ?? "tool-output",
      budgetScope: "current-agent-run",
      guidance:
        "This run's budget is exhausted. Answer from available evidence, disclose incompleteness. This is not a daily quota; do not promise automatic continuation. Unavailable does not mean no matching records.",
    });
  }
  async execute<T>(
    operation: (context: AgentToolContext) => Promise<T>,
  ): Promise<T> {
    this.snapshot.toolCalls++;
    const started = Date.now();
    const remaining = Math.max(
      1,
      this.snapshot.settings.maxToolDurationMs - this.snapshot.toolDurationMs,
    );
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        operation({
          signal: controller.signal,
          deadline: started + remaining,
          maxOutputCharacters: this.remainingCharacters,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new AgentToolTimeout());
          }, remaining);
        }),
      ]);
      if (Date.now() >= started + remaining) throw new AgentToolTimeout();
      return result;
    } catch (error) {
      if (error instanceof AgentToolTimeout) {
        this.exhaust("tool-duration");
        controller.abort();
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.snapshot.toolDurationMs += Math.min(
        remaining,
        Math.max(0, Date.now() - started),
      );
    }
  }
  append(content: string): string {
    const fitted = fitToolOutput(content, this.remainingCharacters);
    try {
      const payload = JSON.parse(content) as {
        reason?: string;
        evidence?: unknown[];
        results?: unknown[];
      };
      if (payload.reason === "tool-output") {
        this.exhaust("tool-output");
        if (!(payload.evidence?.length || payload.results?.length))
          return this.control();
      }
    } catch {
      /* Tool implementations return JSON. */
    }
    if (fitted.truncated) this.exhaust("tool-output");
    if (fitted.content === null) return this.control();
    this.snapshot.toolOutputCharacters += fitted.content.length;
    return fitted.content;
  }
}

/** Drop complete evidence items, never slice JSON or a source's text/identity. */
export function fitToolOutput(
  content: string,
  maximum: number,
): { content: string | null; truncated: boolean } {
  if (content.length <= maximum) return { content, truncated: false };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { content: null, truncated: true };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return { content: null, truncated: true };
  const items = Array.isArray(payload.evidence)
    ? payload.evidence
    : Array.isArray(payload.results)
      ? payload.results
      : null;
  if (!items) return { content: null, truncated: true };
  payload.truncated = true;
  payload.reason = "tool-output";
  while (items.length && JSON.stringify(payload).length > maximum) items.pop();
  if (!items.length) return { content: null, truncated: true };
  return { content: JSON.stringify(payload), truncated: true };
}
