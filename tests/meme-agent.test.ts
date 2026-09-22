import type { AiRepository } from "../modules/ai/ai-repository.js";
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
  usageCount: 0,
  lastUsedAt: null,
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

it("injects guidance only when enabled and records distinct accepted outcomes", async () => {
  const { memeProtocol } = await import("../modules/memes/meme-protocol.js");
  type RecordInput = Parameters<AiRepository["recordToolExecution"]>[0];
  for (const enabled of [false, true]) {
    const records: RecordInput[] = [];
    let turn = 0;
    const execute = vi.fn((req: AiRouteRequest): Promise<AiRouteResult> => {
      expect(
        req.messages.some(
          (m) =>
            typeof m.content === "string" && m.content.includes(memeProtocol),
        ),
      ).toBe(enabled);
      if (!enabled) {
        expect(req.tools?.some((t) => t.name === "search_memes") ?? false).toBe(
          false,
        );
        return Promise.resolve(answer());
      }
      turn++;
      if (turn === 1)
        return Promise.resolve({
          ...answer(),
          toolCalls: [
            {
              id: "1",
              name: "select_meme",
              arguments: JSON.stringify({ id: asset.id }),
            },
            { id: "2", name: "search_memes", arguments: '{"query":""}' },
            { id: "3", name: "search_memes", arguments: '{"query":""}' },
            {
              id: "4",
              name: "select_meme",
              arguments: JSON.stringify({ id: asset.id }),
            },
            { id: "5", name: "select_meme", arguments: '{"id":null}' },
          ],
        });
      return Promise.resolve(answer());
    });
    const library = {
      search: vi.fn().mockResolvedValue([asset]),
      get: vi.fn().mockResolvedValue(asset),
    } as unknown as MemeRepository;
    const recorder = {
      recordToolExecution: (r: RecordInput) => {
        records.push(r);
        return Promise.resolve();
      },
    } as unknown as AiRepository;
    const result = await new AgentRunner(
      { execute } as unknown as AiRoutingService,
      undefined,
      recorder,
      undefined,
      undefined,
      undefined,
      undefined,
      library,
    ).run({ ...request, allowMemes: enabled });
    if (enabled) {
      expect(result.agentBudget?.toolCalls).toBe(5);
      expect(result).toMatchObject({ selectedMeme: null });
      expect(records.map((r) => r.responseDetails?.outcome)).toEqual([
        "invalid-selection",
        "ok",
        "ok",
        "selected",
        "cleared",
      ]);
      expect(records.map((r) => r.resultCount)).toEqual([
        null,
        1,
        1,
        null,
        null,
      ]);
      expect(records[0]?.status).toBe("failed");
      expect(
        JSON.stringify(
          records.map((r) => [r.requestDetails, r.responseDetails]),
        ),
      ).not.toContain("retrievalId");
    } else expect(records).toHaveLength(0);
  }
});

it("records budget skips and isolates late selection from diagnostics and final result", async () => {
  type RecordInput = Parameters<AiRepository["recordToolExecution"]>[0];
  vi.useFakeTimers();
  try {
    const records: RecordInput[] = [];
    let turn = 0;
    let resolveGet: (value: MemeAsset) => void = () => {
      throw new Error("not started");
    };
    const pending = new Promise<MemeAsset>((resolve) => {
      resolveGet = resolve;
    });
    const execute = vi.fn((): Promise<AiRouteResult> =>
      Promise.resolve(
        ++turn === 1
          ? {
              ...answer(),
              toolCalls: [
                {
                  id: "1",
                  name: "search_memes",
                  arguments: '{"query":"开心"}',
                },
                {
                  id: "2",
                  name: "select_meme",
                  arguments: JSON.stringify({ id: asset.id }),
                },
                {
                  id: "3",
                  name: "search_memes",
                  arguments: '{"query":"开心"}',
                },
              ],
            }
          : answer(),
      ),
    );
    const recorder = {
      recordToolExecution: (r: RecordInput) => {
        records.push(r);
        return Promise.resolve();
      },
    } as unknown as AiRepository;
    const library = {
      search: vi.fn().mockResolvedValue([asset]),
      get: () => pending,
    } as unknown as MemeRepository;
    const run = new AgentRunner(
      { execute } as unknown as AiRoutingService,
      undefined,
      recorder,
      undefined,
      {
        maxToolCalls: 10,
        maxToolOutputCharacters: 24000,
        maxToolDurationMs: 5000,
      },
      undefined,
      undefined,
      library,
    ).run(request);
    await vi.advanceTimersByTimeAsync(5001);
    const result = await run;
    expect(records.map((r) => r.responseDetails?.outcome)).toEqual([
      "ok",
      "timeout",
      "budget-exhausted",
    ]);
    expect(records[1]?.resultCount).toBeNull();
    expect(result).toMatchObject({ selectedMeme: null });
    const snapshot = JSON.stringify(records);
    resolveGet(asset);
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.stringify(records)).toBe(snapshot);
  } finally {
    vi.useRealTimers();
  }
});
