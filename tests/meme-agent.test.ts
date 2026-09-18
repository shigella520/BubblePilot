import { it, expect, vi } from "vitest";
import { AgentRunner } from "../modules/ai/agent-runner.js";
import type { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import type {
  AiRouteSuccess,
  AiRouteRequest,
  AiRouteResult,
} from "../modules/ai/ai-types.js";
import type { MemeRepository, MemeAsset } from "../modules/memes/meme-types.js";
const asset = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "虚构开心",
  description: "",
  tags: [],
  summary: null,
  enabled: true,
  hash: "a".repeat(64),
  summaryManual: false,
  candidateSummary: null,
  summaryStatus: "pending",
  summaryError: null,
  mimeType: "image/png",
  size: 1,
  width: 1,
  height: 1,
  storageKey: "fixture",
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  deletedAt: null,
} satisfies MemeAsset;
const request: AiRouteRequest = {
  executionId: "fictional",
  nodeId: "ai",
  routeId: "fictional",
  messages: [{ role: "user", content: "虚构庆祝场景" }],
  maxOutputTokens: 1000,
  maxOutputCharacters: 4000,
  temperature: null,
  outputFormat: "text",
  protectedPrompt: null,
  webSearch: "disabled",
  allowMemes: true,
};
function answer(): AiRouteSuccess {
  return {
    status: "succeeded",
    text: "庆祝一下！",
    toolCalls: [],
    providerId: "fake",
    providerName: "fake",
    providerVersion: 1,
    model: "fake",
    routeVersion: 1,
    round: 1,
    attemptCount: 1,
    durationMs: 1,
    diagnostics: null,
  };
}
it("registers meme tools without web/history, shares calls, commits selection only on final success", async () => {
  for (const fail of [false, true]) {
    let turn = 0;
    const execute = vi.fn((req: AiRouteRequest): Promise<AiRouteResult> => {
      turn++;
      if (turn === 1) {
        expect(req.tools?.map((t) => t.name)).toEqual([
          "search_memes",
          "select_meme",
        ]);
        return Promise.resolve({
          ...answer(),
          toolCalls: [
            { id: "1", name: "search_memes", arguments: '{"query":"开心"}' },
          ],
        });
      }
      if (turn === 2)
        return Promise.resolve({
          ...answer(),
          toolCalls: [
            {
              id: "2",
              name: "select_meme",
              arguments: JSON.stringify({ id: asset.id }),
            },
          ],
        });
      return Promise.resolve(
        fail
          ? {
              status: "failed",
              code: "FIXTURE",
              summary: "failed",
              retryable: false,
              attemptCount: 1,
            }
          : answer(),
      );
    });
    const repo = {
      search: vi.fn().mockResolvedValue([asset]),
      get: vi.fn().mockResolvedValue(asset),
    } as unknown as MemeRepository;
    const result = await new AgentRunner(
      { execute } as unknown as AiRoutingService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      repo,
    ).run(request);
    expect(result.agentBudget?.toolCalls).toBe(2);
    if (fail) {
      expect(result.status).toBe("failed");
      expect(result).not.toHaveProperty("selectedMeme");
    } else {
      expect(result).toMatchObject({
        status: "succeeded",
        selectedMeme: { id: asset.id },
      });
    }
  }
});
