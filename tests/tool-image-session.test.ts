import { preparedImages, imageBlock } from "./support/tool-image-fixture.js";
import { describe, expect, it } from "vitest";
import { prepareToolImages } from "../modules/ai/tool-image-session.js";
import { RunImageSession } from "../modules/ai/run-image-session.js";
import { PluginResultStore } from "../modules/plugins/plugin-result-store.js";

const source = {
  toolCallId: "call-fixture",
  tool: "view_image",
  server: "sandbox",
  pluginId: "fictional",
};
const context = () => ({
  signal: new AbortController().signal,
  deadline: Date.now() + 30000,
  maxOutputCharacters: 16000,
});
describe("tool image input", () => {
  it("preserves order, does not fetch URLs/resources and stages a complete image with no binary text", async () => {
    const visual = new RunImageSession(preparedImages());
    const block = await imageBlock();
    const output = await prepareToolImages(
      [
        { type: "text", text: "![reference](https://example.test/x.png)" },
        block,
        { type: "text", text: "fictional notes" },
        { type: "resource_link" },
      ],
      false,
      visual,
      () => Promise.resolve(true),
      source,
      context(),
    );
    expect(output.content.map((c) => c.text)).toHaveLength(4);
    expect(JSON.stringify(output.content)).not.toContain(block.data);
    expect(output.images[0]).toMatchObject({
      block_index: 1,
      status: "prepared",
      width: 32,
      height: 24,
    });
    expect(output.partial).toBe(true);
    expect(visual.snapshot().tool).toBe(0);
    output.media.commit();
    output.media.commit();
    expect(visual.snapshot().tool).toBe(1);
    expect(visual.drain()).toHaveLength(1);
    const repeated = await prepareToolImages(
      [block],
      false,
      visual,
      () => Promise.resolve(true),
      { ...source, toolCallId: "second" },
      context(),
    );
    expect(repeated.images[0]).toMatchObject({
      status: "already-in-context",
      image_ref: output.images[0]!.image_ref,
      toolCallId: "second",
    });
    repeated.media.commit();
    expect(visual.drain()).toHaveLength(0);
  });
  it("shares automatic/chat/tool quotas and only retains fitting images", async () => {
    const prepared = preparedImages();
    prepared.selectedCount = 1;
    const visual = new RunImageSession(prepared);
    const result = await prepareToolImages(
      [await imageBlock(), await imageBlock("blue")],
      false,
      visual,
      () => Promise.resolve(true),
      source,
      context(),
    );
    expect(result.images.map((v) => v.status)).toEqual(["prepared", "omitted"]);
    expect(result.images[1]!.reason).toBe("image-budget-exceeded");
    result.media.commit();
    expect(visual.snapshot().count.used).toBe(2);
  });
  it("reports disabled, missing capability, remote errors, malformed data and mismatched MIME", async () => {
    const block = await imageBlock();
    for (const [enabled, capable, failed, value, reason] of [
      [false, true, false, block, "image-input-disabled"],
      [true, false, false, block, "image-capability-unavailable"],
      [true, true, true, block, "remote-tool-error"],
      [true, true, false, { ...block, data: "not-base64!" }, "invalid-base64"],
      [
        true,
        true,
        false,
        { ...block, mimeType: "image/jpeg" },
        "unsupported-or-conflicting-image-type",
      ],
    ] as const) {
      const prepared = preparedImages();
      prepared.settings!.enabled = enabled;
      const result = await prepareToolImages(
        [value],
        failed,
        new RunImageSession(prepared),
        () => Promise.resolve(capable),
        source,
        context(),
      );
      expect(result.images[0]).toMatchObject({ status: "omitted", reason });
      expect(result.media.parts).toHaveLength(0);
    }
  });
  it("does not commit cancelled candidates or leave hidden image refs after text-budget rejection", async () => {
    const visual = new RunImageSession(preparedImages());
    const controller = new AbortController();
    const result = await prepareToolImages(
      [await imageBlock()],
      false,
      visual,
      () => Promise.resolve(true),
      source,
      { ...context(), signal: controller.signal },
    );
    const store = new PluginResultStore();
    expect(() =>
      store.prepare(
        { status: "success", content: result.content, images: result.images },
        {
          ...source,
          pluginName: "Fictional",
          revision: "1",
          resultStatus: "success",
        },
        () => Promise.resolve(),
        10,
      ),
    ).toThrow();
    expect(visual.snapshot().tool).toBe(0);
    controller.abort();
    expect(() => result.media.commit()).toThrow();
    expect(visual.drain()).toHaveLength(0);
  });
  it("keeps image manifest in truncated text results and never stores base64 in continuations", async () => {
    const block = await imageBlock();
    const result = await prepareToolImages(
      [{ type: "text", text: "fictional text\n".repeat(4000) }, block],
      false,
      new RunImageSession(preparedImages()),
      () => Promise.resolve(true),
      source,
      context(),
    );
    const store = new PluginResultStore();
    const prepared = store.prepare(
      { status: "success", content: result.content, images: result.images },
      {
        ...source,
        pluginName: "Fictional",
        revision: "1",
        resultStatus: "success",
      },
      () => Promise.resolve(),
      5000,
    );
    const payload = JSON.parse(prepared.text) as {
      images: unknown;
      result_ref: string;
    };
    expect(payload.images).toEqual(result.images);
    prepared.commit?.();
    const read = await store.access(
      { result_ref: payload.result_ref, offset: 50000 },
      false,
      16000,
    );
    expect(read.text).not.toContain(block.data);
  });
});

it("links a reused automatic image to its already-visible label without spending another slot", async () => {
  const block = await imageBlock();
  const prepared = preparedImages();
  prepared.selectedCount = 1;
  prepared.totalBytes = Buffer.from(block.data, "base64").length;
  prepared.parts = [
    {
      type: "image",
      dataUrl: `data:image/png;base64,${block.data}`,
      detail: "auto",
      label: "Fictional current message image 1",
      imageInput: {
        imageInputId: "fixture-image",
        contentHash: "fixture-hash",
      },
    },
  ];
  const visual = new RunImageSession(prepared);
  const result = await prepareToolImages(
    [block],
    false,
    visual,
    () => Promise.resolve(true),
    source,
    context(),
  );
  expect(result.images[0]).toMatchObject({
    status: "already-in-context",
    existingImageLabel: "Fictional current message image 1",
    imageInputId: "fixture-image",
    contentHash: "fixture-hash",
  });
  result.media.commit();
  expect(visual.drain()).toHaveLength(0);
  expect(visual.snapshot().count.used).toBe(1);
});
