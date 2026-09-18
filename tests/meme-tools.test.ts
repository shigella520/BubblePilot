/* eslint-disable @typescript-eslint/unbound-method -- These methods are Vitest spies, never invoked unbound. */
import { describe, it, expect, vi } from "vitest";
import { MemeToolSession } from "../modules/memes/meme-tools.js";
import { AgentToolRegistry } from "../modules/ai/agent-tool-registry.js";
import type { MemeAsset, MemeRepository } from "../modules/memes/meme-types.js";
const asset = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "测试开心",
  description: "虚构笑脸",
  tags: ["开心"],
  summary: null,
  hash: "a".repeat(64),
  enabled: true,
} as MemeAsset;
function fixture() {
  const repo = {
    search: vi.fn().mockResolvedValue([asset]),
    get: vi.fn().mockResolvedValue(asset),
  } as unknown as MemeRepository;
  const session = new MemeToolSession(repo);
  const registry = new AgentToolRegistry();
  session.register(registry);
  const controller = new AbortController();
  const context = {
    signal: controller.signal,
    deadline: Date.now() + 10000,
    maxOutputCharacters: 1000,
  };
  return { repo, session, registry, controller, context };
}
describe("meme tool scope", () => {
  it("rejects guessed IDs and commits only searched candidate, supports clearing", async () => {
    const f = fixture();
    const select = f.registry.get("select_meme")!;
    expect(
      await select.execute(JSON.stringify({ id: asset.id }), f.context),
    ).toContain("invalid-selection");
    expect(f.session.selection()).toBeNull();
    await f.registry
      .get("search_memes")!
      .execute('{"query":"开心"}', f.context);
    expect(
      await select.execute(JSON.stringify({ id: asset.id }), f.context),
    ).toContain('"sent":false');
    expect(f.session.selection()?.id).toBe(asset.id);
    await select.execute('{"id":null}', f.context);
    expect(f.session.selection()).toBeNull();
  });
  it("browses with an empty query and allows selecting the returned candidate", async () => {
    const f = fixture();
    const output = await f.registry
      .get("search_memes")!
      .execute('{"query":"  ","limit":2}', f.context);
    expect(f.repo.search).toHaveBeenCalledWith("", 2);
    expect(JSON.parse(output)).toMatchObject({
      status: "ok",
      results: [{ id: asset.id }],
    });
    await f.registry
      .get("select_meme")!
      .execute(JSON.stringify({ id: asset.id }), f.context);
    expect(f.session.selection()?.id).toBe(asset.id);
  });
  it("does not register candidates excluded by content budget", async () => {
    const f = fixture();
    const output = await f.registry
      .get("search_memes")!
      .execute('{"query":"开心"}', { ...f.context, maxOutputCharacters: 70 });
    expect(JSON.parse(output)).toMatchObject({ status: "unavailable" });
    expect(
      await f.registry
        .get("select_meme")!
        .execute(JSON.stringify({ id: asset.id }), f.context),
    ).toContain("invalid-selection");
  });
  it("isolates late candidate results and late selection", async () => {
    const f = fixture();
    await f.registry
      .get("search_memes")!
      .execute('{"query":"开心"}', f.context);
    vi.mocked(f.repo.get).mockImplementation(() => {
      f.controller.abort();
      return Promise.resolve(asset);
    });
    await f.registry
      .get("select_meme")!
      .execute(JSON.stringify({ id: asset.id }), f.context);
    expect(f.session.selection()).toBeNull();
  });
  it("disabled assets are not selectable", async () => {
    const f = fixture();
    await f.registry
      .get("search_memes")!
      .execute('{"query":"开心"}', f.context);
    vi.mocked(f.repo.get).mockResolvedValue({ ...asset, enabled: false });
    expect(
      await f.registry
        .get("select_meme")!
        .execute(JSON.stringify({ id: asset.id }), f.context),
    ).toContain("asset-unavailable");
  });
  it("empty search preserves no-results and validates arguments", async () => {
    const f = fixture();
    vi.mocked(f.repo.search).mockResolvedValue([]);
    expect(
      await f.registry
        .get("search_memes")!
        .execute('{"query":"开心"}', f.context),
    ).toContain("no-results");
    await expect(
      f.registry
        .get("search_memes")!
        .execute('{"query":"开心","limit":11}', f.context),
    ).resolves.toContain("invalid-arguments");
  });
});
