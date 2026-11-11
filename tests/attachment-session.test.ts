import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { AttachmentSession } from "../modules/attachments/attachment-session.js";
import { AttachmentStore } from "../modules/attachments/attachment-store.js";
import { attachmentLimitsSchema } from "../modules/attachments/attachment-policy.js";
import {
  AgentToolRegistry,
  type MultimodalToolResult,
} from "../modules/ai/agent-tool-registry.js";
import type { PluginSession } from "../modules/plugins/plugin-session.js";
import {
  strictToolParameters,
  restoreToolArguments,
} from "../modules/ai/tool-schema.js";
import { assertStrictSchema } from "./support/tool-schema-fixtures.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(snapshot = false) {
  const root = await mkdtemp(join(tmpdir(), "bp-attachment-unit-"));
  roots.push(root);
  const storage = new AttachmentStore(root);
  await storage.init();
  const attachment = {
    providerAttachmentId: "fictional-file",
    fileName: "销售.csv",
    mimeType: "text/csv",
    sizeBytes: null,
  };
  let authorized = true;
  let contentAvailable = true;
  const resolve = vi.fn(() =>
    Promise.resolve(
      authorized && contentAvailable
        ? {
            messageId: "archive-message",
            providerMessageId: "current",
            attachment,
            attachmentIndex: 0,
          }
        : null,
    ),
  );
  const data = Buffer.from("地区,金额\n东,10\n");
  const download = vi.fn(() => Promise.resolve(new Response(data)));
  const transfer = vi.fn(
    async (
      input: Record<string, unknown>,
      file: string,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      expect(await readFile(file)).toEqual(data);
      expect(input.sha256).toBe(
        createHash("sha256").update(data).digest("hex"),
      );
      return {
        status: "imported",
        sandbox_path: `/workspace/attachments/${String(input.id)}/${String(input.filename)}`,
        size: data.length,
        sha256: input.sha256,
      };
    },
  );
  const invalidate = vi.fn(async () => {});
  const channel = {
    metadata: { pluginId: randomUUID(), server: "sandbox" },
    check: async () => {},
    invalidate,
    transfer,
  };
  const plugins = {
    attachmentChannel: () => channel,
  } as unknown as PluginSession;
  const input = {
    config: {
      enabled: true,
      pluginId: channel.metadata.pluginId,
      server: "sandbox",
      limits: attachmentLimitsSchema.parse({}),
    },
    scope: {
      provider: "bluebubbles",
      providerChatId: "fictional-chat",
      triggerMessageId: "current",
    },
    current: { providerMessageId: "current", attachments: [attachment] },
  };
  const session = new AttachmentSession(
    input,
    plugins,
    {
      resolve,
      ...(snapshot ? { authorized: () => Promise.resolve(authorized) } : {}),
    },
    { download },
    storage,
  );
  const registry = new AgentToolRegistry();
  session.register(registry);
  const tool = registry.get("import_chat_attachment")!;
  const call = async (args: Record<string, unknown>, maximum = 64000) => {
    const raw = restoreToolArguments(
      tool.definition.parameters,
      JSON.stringify(args),
    );
    const output = (await tool.execute(raw, {
      signal: AbortSignal.timeout(5000),
      deadline: Date.now() + 5000,
      maxOutputCharacters: maximum,
    })) as MultimodalToolResult;
    return {
      output,
      value: JSON.parse(output.text) as Record<string, unknown>,
    };
  };
  return {
    root,
    session,
    input,
    tool,
    call,
    download,
    transfer,
    invalidate,
    resolve,
    storage,
    plugins,
    revoke: () => {
      authorized = false;
    },
    removeContent: () => {
      contentAvailable = false;
    },
    ref: session.currentCatalogue().entries[0]!.attachment_ref!,
  };
}
it("imports only issued references, reuses success and validates again after revocation", async () => {
  const f = await fixture();
  assertStrictSchema(strictToolParameters(f.tool.definition));
  expect((await f.call({ attachment_ref: "guessed" })).value.errorCode).toBe(
    "ATTACHMENT_REFERENCE_UNAVAILABLE",
  );
  expect(f.download).not.toHaveBeenCalled();
  const first = await f.call({ attachment_ref: f.ref });
  expect(first.value.status).toBe("imported");
  expect(first.output.diagnostics).toMatchObject({
    sourceMessageId: "archive-message",
    attachmentIndex: 0,
    outcome: "success",
  });
  expect(await readdir(f.root)).toEqual([]);
  const repeated = await f.call({ attachment_ref: f.ref });
  expect(repeated.value.reused).toBe(true);
  expect(repeated.value.sandbox_path).toBe(first.value.sandbox_path);
  expect(f.transfer).toHaveBeenCalledTimes(1);
  f.revoke();
  await expect(f.session.validate()).rejects.toThrow(
    "ATTACHMENT_PERMISSION_REVOKED",
  );
  expect(f.invalidate).toHaveBeenCalled();
  expect((await f.call({ attachment_ref: f.ref })).value.errorCode).toBe(
    "ATTACHMENT_SESSION_INVALIDATED",
  );
});
it("only grants staged references actually returned, without spending capacity on discarded operations", async () => {
  const f = await fixture();
  const message = {
    id: "history",
    providerMessageId: "past",
    attachments: f.input.current.attachments,
  };
  for (let i = 0; i < 110; i++) {
    const pending = f.session.stageCatalogue();
    const listing = pending.catalogue({
      ...message,
      providerMessageId: `discarded-${i}`,
    });
    const denied = await f.call({
      attachment_ref: listing.entries[0]!.attachment_ref,
    });
    expect(denied.value.errorCode).toBe("ATTACHMENT_REFERENCE_UNAVAILABLE");
    expect(denied.value.guidance).toContain(
      "No download or import was started",
    );
    pending.commit([]);
  }
  const pending = f.session.stageCatalogue();
  const returned = pending.catalogue(message);
  const dropped = pending.catalogue({
    ...message,
    providerMessageId: "cropped",
  });
  const ref = returned.entries[0]!.attachment_ref!;
  expect(ref).toMatch(/^A/);
  pending.commit([returned]);
  expect(
    (await f.call({ attachment_ref: dropped.entries[0]!.attachment_ref })).value
      .errorCode,
  ).toBe("ATTACHMENT_REFERENCE_UNAVAILABLE");
  expect(f.download).not.toHaveBeenCalled();
  expect((await f.call({ attachment_ref: ref })).value.status).toBe("imported");
  expect(f.resolve).toHaveBeenLastCalledWith(f.input.scope, "past", 0, true);
  expect(
    f.session.stageCatalogue().catalogue(message).entries[0]!.attachment_ref,
  ).toBe(ref);
});
it("cannot publish staged references after the run ends or partially commit conflicting catalogues", async () => {
  const f = await fixture();
  const message = {
    id: "history",
    providerMessageId: "past",
    attachments: f.input.current.attachments,
  };
  const first = f.session.stageCatalogue(),
    second = f.session.stageCatalogue();
  const a = first.catalogue(message),
    b = second.catalogue(message);
  const extra = second.catalogue({ ...message, providerMessageId: "extra" });
  first.commit([a]);
  expect(() => second.commit([extra, b])).toThrow(
    "ATTACHMENT_REFERENCE_UNAVAILABLE",
  );
  expect(
    (await f.call({ attachment_ref: extra.entries[0]!.attachment_ref })).value
      .errorCode,
  ).toBe("ATTACHMENT_REFERENCE_UNAVAILABLE");
  const late = f.session.stageCatalogue();
  const listing = late.catalogue({ ...message, providerMessageId: "late" });
  await f.session.close();
  expect(() => late.commit([listing])).toThrow(
    "ATTACHMENT_SESSION_INVALIDATED",
  );
});
it("does not share references, grants historical candidates explicitly and caps catalogues", async () => {
  const a = await fixture(),
    b = await fixture();
  expect((await b.call({ attachment_ref: a.ref })).value.errorCode).toBe(
    "ATTACHMENT_REFERENCE_UNAVAILABLE",
  );
  const message = {
    id: "history",
    providerMessageId: "past",
    attachments: Array.from({ length: 110 }, (_, i) => ({
      ...a.input.current.attachments[0]!,
      fileName: `虚构${i}.csv`,
    })),
  };
  const page = a.session.catalogue(message);
  expect(page.entries).toHaveLength(20);
  expect(page.nextOffset).toBe(20);
  await a.call({ attachment_ref: page.entries[0]!.attachment_ref });
  expect(a.resolve).toHaveBeenLastCalledWith(a.input.scope, "past", 0, true);
  for (let i = 20; i < 100; i += 20) a.session.catalogue(message, i);
  const last = a.session.catalogue(message, 100);
  expect(last.referenceLimitReached).toBe(true);
  expect(last.entries.every((e) => !e.attachment_ref)).toBe(true);
});
it("rejects concurrent imports, count overrun and invalid body types without retaining temp files", async () => {
  const f = await fixture();
  f.input.config.limits.files = 1;
  let resume!: () => void;
  f.download.mockImplementationOnce(async () => {
    await new Promise<void>((r) => {
      resume = r;
    });
    return new Response("地区,金额\n东,10\n");
  });
  const pending = f.call({ attachment_ref: f.ref });
  await vi.waitFor(() => expect(f.download).toHaveBeenCalled());
  expect((await f.call({ attachment_ref: f.ref })).value.errorCode).toBe(
    "ATTACHMENT_CAPACITY_BUSY",
  );
  resume();
  await pending;
  const other = f.session.catalogue({
    id: "another",
    providerMessageId: "another",
    attachments: f.input.current.attachments,
  }).entries[0]!.attachment_ref!;
  expect((await f.call({ attachment_ref: other })).value.errorCode).toBe(
    "ATTACHMENT_COUNT_LIMIT",
  );
  const bad = await fixture();
  bad.download.mockResolvedValueOnce(new Response(new Uint8Array([0, 1, 2])));
  expect((await bad.call({ attachment_ref: bad.ref })).value.errorCode).toBe(
    "ATTACHMENT_TEXT_ENCODING_UNSUPPORTED",
  );
  expect(bad.transfer).not.toHaveBeenCalled();
  expect(await readdir(bad.root)).toEqual([]);
});
it("enforces actual streaming bytes and releases temporary reservations on failure", async () => {
  const f = await fixture();
  const store = new AttachmentStore(f.root, 5);
  await expect(
    store.stage(new Response("123456"), 5, AbortSignal.timeout(1000)),
  ).rejects.toThrow("ATTACHMENT_TOO_LARGE");
  expect(await readdir(f.root)).toEqual([]);
  const staged = await store.stage(
    new Response("123"),
    5,
    AbortSignal.timeout(1000),
  );
  await expect(
    store.stage(new Response("1"), 1, AbortSignal.timeout(1000)),
  ).rejects.toThrow("ATTACHMENT_CAPACITY_BUSY");
  await staged.dispose();
  await staged.dispose();
  const again = await store.stage(
    new Response("1"),
    5,
    AbortSignal.timeout(1000),
  );
  await again.dispose();
  const abort = new AbortController();
  abort.abort();
  await expect(
    store.stage(new Response("1"), 5, abort.signal),
  ).rejects.toThrow();
  expect(await readdir(f.root)).toEqual([]);
});

it("extended import time cannot outlive the remaining Agent budget or caller cancellation", async () => {
  for (const cancel of [false, true]) {
    const f = await fixture();
    f.input.config.limits.timeoutSeconds = 150;
    const controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.transfer.mockImplementationOnce(async (input, _file, signal) => {
      entered();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      // A transport may return a result after cancellation; it must not be committed.
      return {
        status: "imported",
        sandbox_path: "/workspace/late.csv",
        size: 1,
        sha256: input.sha256,
      };
    });
    const pending = f.tool.execute(JSON.stringify({ attachment_ref: f.ref }), {
      signal: controller.signal,
      deadline: Date.now() + 1000,
      maxOutputCharacters: 64000,
    });
    await ready;
    if (cancel) controller.abort();
    const output = (await pending) as MultimodalToolResult;
    expect(JSON.parse(output.text)).toMatchObject({
      status: "unavailable",
      errorCode: cancel
        ? "ATTACHMENT_CANCELLED"
        : "ATTACHMENT_TIMEOUT_OR_CANCELLED",
    });
    expect(f.invalidate).toHaveBeenCalledOnce();
    expect(await readdir(f.root)).toEqual([]);
    await f.session.close();
  }
});

it("keeps read bytes when the archive changes before transfer, but still revokes permissions", async () => {
  const f = await fixture(true);
  f.download.mockImplementationOnce(() => {
    f.removeContent();
    return Promise.resolve(new Response(Buffer.from("地区,金额\n东,10\n")));
  });
  expect((await f.call({ attachment_ref: f.ref })).value.status).toBe(
    "imported",
  );
  await expect(f.session.validate()).resolves.toBeUndefined();
  expect((await f.call({ attachment_ref: f.ref })).value.reused).toBe(true);
  expect(f.invalidate).not.toHaveBeenCalled();
  f.revoke();
  await expect(f.session.validate()).rejects.toThrow(
    "ATTACHMENT_PERMISSION_REVOKED",
  );
  expect(f.invalidate).toHaveBeenCalled();
});
it("metadata is not a file snapshot; missing fresh content does not cancel the session", async () => {
  const f = await fixture(true);
  f.removeContent();
  expect((await f.call({ attachment_ref: f.ref })).value.errorCode).toBe(
    "ATTACHMENT_REFERENCE_UNAVAILABLE",
  );
  expect(f.download).not.toHaveBeenCalled();
  expect(f.invalidate).not.toHaveBeenCalled();
});
