import {
  memeSearchDescription,
  memeSelectDescription,
} from "./meme-protocol.js";
import { z } from "zod";
import type { AgentToolRegistry } from "../ai/agent-tool-registry.js";
import type { AgentToolContext } from "../ai/agent-budget.js";
import {
  memeLimits,
  type MemeRepository,
  type SelectedMeme,
} from "./meme-types.js";
export class MemeToolSession {
  private candidates = new Map<string, SelectedMeme>();
  private selected: SelectedMeme | null = null;
  constructor(private readonly repository: MemeRepository) {}
  selection() {
    return this.selected ? { ...this.selected } : null;
  }
  register(registry: AgentToolRegistry) {
    registry.register({
      definition: {
        name: "search_memes",
        description: memeSearchDescription,
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "空格分隔的简短关键词；空字符串表示浏览已启用候选。",
            },
            limit: { type: "integer", minimum: 1, maximum: 10 },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      diagnostics: "metadata-only",
      execute: (args, context) =>
        this.execute(() => this.search(args, context)),
    });
    registry.register({
      definition: {
        name: "select_meme",
        description: memeSelectDescription,
        parameters: {
          type: "object",
          properties: { id: { type: ["string", "null"] } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      diagnostics: "metadata-only",
      execute: (args, context) =>
        this.execute(() => this.select(args, context)),
    });
  }
  private async execute(operation: () => Promise<string>): Promise<string> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return JSON.stringify({
          status: "invalid-arguments",
          reason: "参数不符合工具定义，请检查后重试。",
        });
      return JSON.stringify({ status: "unavailable", reason: "query-failed" });
    }
  }
  private async search(args: string, context: AgentToolContext) {
    const input = z
      .object({
        query: z.string().trim().max(200),
        limit: z
          .number()
          .int()
          .min(1)
          .max(memeLimits.searchMax)
          .default(memeLimits.searchDefault),
      })
      .strict()
      .parse(JSON.parse(args));
    const assets = await this.repository.search(input.query, input.limit);
    if (context.signal.aborted || Date.now() >= context.deadline)
      return JSON.stringify({ status: "unavailable", reason: "timeout" });
    const results = assets.map((a) => ({
      id: a.id,
      name: a.name,
      collectionName: a.collectionName ?? null,
      description: a.description,
      tags: a.tags,
      summary: a.summary,
    }));
    const output = {
      status: assets.length ? "ok" : "no-results",
      results,
      truncated: false,
    };
    while (
      JSON.stringify(output).length > context.maxOutputCharacters &&
      output.results.length
    ) {
      output.results.pop();
      output.truncated = true;
    }
    if (!output.results.length && assets.length)
      return JSON.stringify({
        status: "unavailable",
        reason: "content-budget",
      });
    for (const item of output.results) {
      const asset = assets.find((a) => a.id === item.id)!;
      this.candidates.set(item.id, {
        id: item.id,
        name: item.name,
        hash: asset.hash,
      });
    }
    return JSON.stringify(output);
  }
  private async select(args: string, context: AgentToolContext) {
    const { id } = z
      .object({ id: z.string().uuid().nullable() })
      .strict()
      .parse(JSON.parse(args));
    let selection: SelectedMeme | null = null;
    if (id !== null) {
      const candidate = this.candidates.get(id);
      if (!candidate)
        return JSON.stringify({
          status: "invalid-selection",
          reason: "not-a-returned-candidate",
        });
      const asset = await this.repository.get(id);
      if (!asset?.enabled || asset.hash !== candidate.hash)
        return JSON.stringify({
          status: "unavailable",
          reason: "asset-unavailable",
        });
      selection = candidate;
    }
    if (context.signal.aborted || Date.now() >= context.deadline)
      return JSON.stringify({ status: "unavailable", reason: "timeout" });
    const output = JSON.stringify({ status: "selected", id, sent: false });
    if (output.length > context.maxOutputCharacters)
      return JSON.stringify({
        status: "unavailable",
        reason: "content-budget",
      });
    this.selected = selection;
    return output;
  }
}
