import { describe, expect, it } from "vitest";
import {
  parseTransportCapability,
  routeWorkspacePath,
} from "../modules/plugins/plugin-transport.js";
import { imageExportTargets } from "../modules/plugins/plugin-image-exports.js";
import { attachmentTargets } from "../modules/plugins/plugin-attachments.js";
import { toolContractHash } from "../modules/plugins/plugin-tool-sync.js";
import type {
  ApprovedTool,
  InstalledPlugin,
} from "../modules/plugins/plugin-types.js";

const tool = (
  name: string,
  extra: Partial<ApprovedTool> = {},
): ApprovedTool => ({
  server: "main",
  definition: {
    name,
    description: `fictional ${name}`,
    parameters: { type: "object", properties: {} },
  },
  hash: `hash-${name}`,
  ...extra,
});

const plugin = (id: string, tools: ApprovedTool[]): InstalledPlugin => ({
  id,
  name: `fictional-${id}`,
  enabled: true,
  version: 1,
  revision: "r1",
  package: {
    name: `fictional-${id}`,
    version: "1.0.0",
    description: "",
    format: "portable-1",
    skills: [],
    servers: [],
    files: {},
    hash: "h",
  },
  config: {
    connections: { main: { url: "http://mcp.example.test/mcp" } as never },
    tools,
    disabledSkills: [],
    disabledTools: [],
  },
});

const sandbox = plugin("sandbox", [
  tool("prepare_sandbox", {
    imageExportVersion: 1,
    attachmentTransferVersion: 1,
  }),
  tool("run_command"),
  tool("read_file"),
  tool("write_file"),
]);
const generator = plugin("generator", [
  tool("generate_image", {
    imageExportVersion: 1,
    attachmentTransferVersion: 1,
    transportWorkspacePrefix: "/workspace/image-gen/",
    attachmentMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  }),
  tool("edit_image"),
]);

describe("transport capability declarations", () => {
  it("treats a declaration without anchorTool as a sandbox", () => {
    expect(parseTransportCapability({ version: 1, fileBytes: 1 })).toEqual({
      version: 1,
      anchorTool: "prepare_sandbox",
      workspacePrefix: "/workspace/",
    });
  });
  it("accepts a generator anchor with its own namespace and image types", () => {
    expect(
      parseTransportCapability(
        {
          version: 1,
          anchorTool: "generate_image",
          workspacePrefix: "/workspace/image-gen/",
          mimeTypes: ["image/png", "image/jpeg"],
        },
        { mimeTypes: true },
      ),
    ).toEqual({
      version: 1,
      anchorTool: "generate_image",
      workspacePrefix: "/workspace/image-gen/",
      mimeTypes: ["image/png", "image/jpeg"],
    });
  });
  it("fails closed on malformed or escalating declarations", () => {
    for (const value of [
      { version: 2 },
      { version: 1, workspacePrefix: "/workspace/x/" },
      {
        version: 1,
        anchorTool: "prepare_sandbox",
        workspacePrefix: "/workspace/x/",
      },
      { version: 1, anchorTool: "gen", workspacePrefix: "/workspace/" },
      { version: 1, anchorTool: "gen", workspacePrefix: "/workspace/../etc/" },
      { version: 1, anchorTool: "gen", workspacePrefix: "/tmp/gen/" },
      { version: 1, anchorTool: "gen", workspacePrefix: "/workspace/Gen/" },
    ])
      expect(parseTransportCapability(value)).toBeNull();
    for (const mimeTypes of [
      [],
      ["image/heic"],
      ["image/png", "image/png"],
      "image/png",
    ])
      expect(
        parseTransportCapability(
          {
            version: 1,
            anchorTool: "gen",
            workspacePrefix: "/workspace/gen/",
            mimeTypes,
          },
          { mimeTypes: true },
        ),
      ).toBeNull();
    // Export capabilities never carry MIME allowlists.
    expect(
      parseTransportCapability({
        version: 1,
        anchorTool: "gen",
        workspacePrefix: "/workspace/gen/",
        mimeTypes: ["image/png"],
      }),
    ).toBeNull();
  });
});

describe("transport targets", () => {
  it("keeps sandbox targets on the original tool requirements", () => {
    expect(imageExportTargets([sandbox])).toEqual([
      expect.objectContaining({
        kind: "sandbox",
        anchorTool: "prepare_sandbox",
        workspacePrefix: "/workspace/",
        fileTypes: ["png"],
      }),
    ]);
    expect(attachmentTargets([sandbox])).toEqual([
      expect.objectContaining({
        kind: "sandbox",
        anchorTool: "prepare_sandbox",
      }),
    ]);
    const partial = plugin("partial", sandbox.config.tools.slice(0, 2));
    expect(imageExportTargets([partial])).toHaveLength(1);
    expect(attachmentTargets([partial])).toEqual([]);
  });
  it("lists generators without sandbox tools and exposes their namespace", () => {
    expect(imageExportTargets([generator])).toEqual([
      expect.objectContaining({
        kind: "generator",
        anchorTool: "generate_image",
        workspacePrefix: "/workspace/image-gen/",
        fileTypes: ["png"],
      }),
    ]);
    expect(attachmentTargets([generator])).toEqual([
      expect.objectContaining({
        kind: "generator",
        mimeTypes: ["image/png", "image/jpeg", "image/webp"],
      }),
    ]);
  });
  it("drops targets whose anchor tool is disabled", () => {
    const disabled = {
      ...generator,
      config: { ...generator.config, disabledTools: ["main/generate_image"] },
    };
    expect(imageExportTargets([disabled])).toEqual([]);
    expect(attachmentTargets([disabled])).toEqual([]);
  });
  it("requires review when a generator changes namespace or accepted inputs", () => {
    const anchor = generator.config.tools[0]!;
    const base = toolContractHash(anchor);
    expect(
      toolContractHash({
        ...anchor,
        transportWorkspacePrefix: "/workspace/other/",
      }),
    ).not.toBe(base);
    expect(
      toolContractHash({ ...anchor, attachmentMimeTypes: ["image/png"] }),
    ).not.toBe(base);
  });
  it("routes paths to the most specific workspace", () => {
    const targets = [
      { name: "sandbox", workspacePrefix: "/workspace/" },
      { name: "image", workspacePrefix: "/workspace/image-gen/" },
    ];
    expect(
      routeWorkspacePath("/workspace/image-gen/out/a.png", targets)?.name,
    ).toBe("image");
    expect(routeWorkspacePath("/workspace/report.xlsx", targets)?.name).toBe(
      "sandbox",
    );
    expect(routeWorkspacePath("/tmp/a.png", targets)).toBeUndefined();
  });
});
