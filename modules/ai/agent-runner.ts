import type { AiRoutingService } from "./ai-routing-service.js";
import type { AiRouteRequest, AiRouteResult } from "./ai-types.js";

export interface AgentRunLimits {
  maxTurns: number;
  maxToolCalls: number;
}

export class AgentRunner {
  constructor(
    private readonly routing: AiRoutingService,
    private readonly limits: AgentRunLimits = {
      maxTurns: 4,
      maxToolCalls: 3,
    },
  ) {}

  run(request: AiRouteRequest): Promise<AiRouteResult> {
    if (this.limits.maxTurns < 1 || this.limits.maxToolCalls < 1) {
      return Promise.resolve({
        status: "failed",
        code: "AI_AGENT_TOOL_LIMIT_EXCEEDED",
        summary: "The configured AgentRunner limits do not allow a tool turn.",
        retryable: false,
        attemptCount: 0,
      });
    }
    // Hosted tools execute inside one native Provider turn in V1. Local tool
    // execution can extend this boundary without changing the node contract.
    return this.routing.execute(request);
  }
}
