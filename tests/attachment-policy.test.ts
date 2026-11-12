import { expect, it } from "vitest";
import {
  attachmentHandlingSchema,
  attachmentLimitsSchema,
} from "../modules/attachments/attachment-policy.js";
import {
  attachmentTargets,
  assertAttachmentBinding,
} from "../modules/plugins/plugin-attachments.js";
import type { InstalledPlugin } from "../modules/plugins/plugin-types.js";
import { attachmentFilename } from "../modules/attachments/attachment-format.js";
import {
  chatMessageQuerySchema,
  chatCountQuerySchema,
} from "../modules/memory/chat-query-types.js";
it("keeps attachment filters optional and requires matching values on one attachment", () => {
  expect(chatMessageQuerySchema.parse({})).toEqual({
    order: "desc",
    limit: 20,
  });
  expect(
    chatMessageQuerySchema.parse({ attachmentType: ".CSV" }).attachmentType,
  ).toBe(".csv");
  expect(
    chatMessageQuerySchema.safeParse({
      hasAttachments: false,
      attachmentName: "a",
    }).success,
  ).toBe(false);
  expect(
    chatMessageQuerySchema.safeParse({ attachmentType: "text/*" }).success,
  ).toBe(false);
  expect(chatCountQuerySchema.safeParse({ hasAttachments: true }).success).toBe(
    true,
  );
});
it("defaults quotas and forbids enabled bindings without a target or invalid totals", () => {
  expect(
    attachmentHandlingSchema.safeParse({
      enabled: false,
      pluginId: "",
      server: "",
    }).success,
  ).toBe(true);
  expect(
    attachmentHandlingSchema.safeParse({
      enabled: true,
      pluginId: "",
      server: "",
    }).success,
  ).toBe(false);
  expect(
    attachmentHandlingSchema.safeParse({
      enabled: true,
      pluginId: "00000000-0000-4000-8000-000000000001",
      server: "sandbox",
      limits: { fileMiB: 20, totalMiB: 10 },
    }).success,
  ).toBe(false);
});
it("does not infer transfer capability from a tool name or plugin name", () => {
  const p = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "OpenSandbox",
    enabled: true,
    config: {
      connections: { sandbox: {} },
      disabledTools: [],
      tools: ["prepare_sandbox", "run_command", "read_file", "write_file"].map(
        (name) => ({ server: "sandbox", definition: { name }, hash: name }),
      ),
    },
  } as unknown as InstalledPlugin;
  expect(attachmentTargets([p])).toEqual([]);
  p.config.tools[0]!.attachmentTransferVersion = 1;
  expect(attachmentTargets([p])).toHaveLength(1);
  p.config.disabledTools.push("sandbox/run_command");
  expect(attachmentTargets([p])).toEqual([]);
  expect(() =>
    assertAttachmentBinding(
      [p],
      attachmentHandlingSchema.parse({
        enabled: true,
        pluginId: p.id,
        server: "sandbox",
      }),
    ),
  ).toThrow("ATTACHMENT_TARGET_UNAVAILABLE");
});
it("rejects executables and conflicting MIME, and sanitizes names as data", () => {
  const file = {
    providerAttachmentId: "fictional",
    fileName: "../销售.csv",
    mimeType: "text/csv",
    sizeBytes: null,
  };
  expect(attachmentFilename(file).filename).not.toContain("/");
  expect(() =>
    attachmentFilename({
      ...file,
      fileName: "run.exe",
      mimeType: "application/octet-stream",
    }),
  ).toThrow("UNSUPPORTED");
  expect(() => attachmentFilename({ ...file, mimeType: "image/png" })).toThrow(
    "CONFLICTING",
  );
});

it("keeps the old import timeout default and accepts bounded cold-start waits", () => {
  expect(attachmentLimitsSchema.parse({}).timeoutSeconds).toBe(30);
  expect(
    attachmentLimitsSchema.parse({ timeoutSeconds: 180 }).timeoutSeconds,
  ).toBe(180);
  for (const timeoutSeconds of [4, 181, 5.5])
    expect(attachmentLimitsSchema.safeParse({ timeoutSeconds }).success).toBe(
      false,
    );
});
