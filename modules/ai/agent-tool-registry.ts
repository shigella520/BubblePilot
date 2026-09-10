import type { AiToolDefinition } from "./ai-types.js";
export interface RegisteredAgentTool {
  definition: AiToolDefinition;
  execute(argumentsJson: string): Promise<string>;
  diagnostics: "metadata-only" | "web-search";
}
/** Per-execution registry: capabilities are selected by trusted runtime scope. */
export class AgentToolRegistry {
  private readonly tools = new Map<string, RegisteredAgentTool>();
  register(tool: RegisteredAgentTool): void {
    if (this.tools.has(tool.definition.name))
      throw new Error("Duplicate agent tool");
    this.tools.set(tool.definition.name, tool);
  }
  get(name: string): RegisteredAgentTool | undefined {
    return this.tools.get(name);
  }
  definitions(): AiToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }
}
