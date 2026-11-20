import { expect, it } from "vitest";
import sharp from "sharp";
import {
  validateReplyFile,
  replyFileName,
} from "../modules/generated-images/file-validation.js";
import {
  imageReplySchema,
  allowedReplyFileTypes,
  replyFileTypes,
  generatedFileLimits,
} from "../modules/generated-images/image-policy.js";
import {
  imageExportTargets,
  assertImageExportBinding,
} from "../modules/plugins/plugin-image-exports.js";
import type { InstalledPlugin } from "../modules/plugins/plugin-types.js";
import { pluginZip } from "./support/plugin-zip.js";
const signal = () => new AbortController().signal;
it("keeps old workflow permission PNG-only and validates explicit file type choices", () => {
  const old = imageReplySchema.parse({
    enabled: false,
    pluginId: "",
    server: "",
  });
  expect(allowedReplyFileTypes(old)).toEqual(["png"]);
  expect(
    imageReplySchema.parse({ ...old, allowedTypes: ["gif"] }).allowedTypes,
  ).toEqual(["gif"]);
  for (const allowedTypes of [[], ["exe"], ["png", "png"]])
    expect(imageReplySchema.safeParse({ ...old, allowedTypes }).success).toBe(
      false,
    );
});
it("accepts bounded text, PDF, spreadsheet and ZIP files with server-derived metadata", async () => {
  for (const [filename, bytes, mime] of [
    ["结果.csv", Buffer.from("name,count\nfictional,2\n"), "text/csv"],
    ["report.txt", Buffer.from("虚构报告\n"), "text/plain"],
    ["report.md", Buffer.from("# Fictional report"), "text/markdown"],
    [
      "report.pdf",
      Buffer.from("%PDF-1.7\nfictional fixture\n%%EOF\n"),
      "application/pdf",
    ],
    [
      "report.xlsx",
      pluginZip({
        "[Content_Types].xml":
          '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        "xl/workbook.xml":
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
      }),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    ["report.zip", pluginZip({ "report.txt": "fictional" }), "application/zip"],
  ] as const) {
    expect(
      await validateReplyFile(bytes, filename, replyFileTypes, signal()),
    ).toMatchObject({
      filename,
      mimeType: mime,
      size: bytes.length,
      width: null,
      height: null,
    });
    await expect(
      validateReplyFile(bytes, filename, ["png"], signal()),
    ).rejects.toThrow("FILE_TYPE_NOT_AUTHORIZED");
  }
});
it("checks actual image formats and preserves image dimensions", async () => {
  const png = await sharp({
    create: { width: 20, height: 10, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer();
  expect(
    await validateReplyFile(jpeg, "drawing.jpg", ["jpeg"], signal()),
  ).toMatchObject({
    fileType: "jpeg",
    mimeType: "image/jpeg",
    width: 20,
    height: 10,
  });
  await expect(
    validateReplyFile(png, "drawing.jpg", ["jpeg"], signal()),
  ).rejects.toThrow("FILE_TYPE_MISMATCH");
  await expect(
    validateReplyFile(jpeg, "drawing.png", ["png"], signal()),
  ).rejects.toThrow("IMAGE_INVALID");
});
it("rejects disguised, malformed, over-limit and cancelled artifacts without repairing them", async () => {
  for (const [name, bytes] of [
    ["report.pdf", Buffer.from("not a PDF")],
    ["report.pdf", Buffer.from("%PDF-1.7\nunfinished")],
    ["report.txt", Buffer.from([0xff, 0xfe, 0])],
    ["report.csv", Buffer.from("a\0b")],
    ["report.zip", Buffer.from("not a zip")],
    ["report.xlsx", pluginZip({ "other.txt": "fictional" })],
    ["report.zip", pluginZip({ "../escape.txt": "fictional" })],
    ["report.zip", pluginZip({ link: "../escape" }, 0o120777)],
    [
      "report.xlsx",
      pluginZip({
        "[Content_Types].xml":
          '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        "xl/workbook.xml":
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
        "xl/vbaProject.bin": "macro",
      }),
    ],
    [
      "report.zip",
      pluginZip(
        Object.fromEntries(
          Array.from({ length: 201 }, (_, i) => [`${i}.txt`, "x"]),
        ),
      ),
    ],
  ] as const)
    await expect(
      validateReplyFile(bytes, name, replyFileTypes, signal()),
    ).rejects.toThrow();
  await expect(
    validateReplyFile(
      Buffer.alloc(generatedFileLimits.bytes + 1),
      "report.txt",
      ["txt"],
      signal(),
    ),
  ).rejects.toThrow("FILE_TOO_LARGE");
  await expect(
    validateReplyFile(Buffer.from("x"), "a.exe", replyFileTypes, signal()),
  ).rejects.toThrow("FILE_TYPE_UNSUPPORTED");
  for (const name of [
    "bad\r\n.txt",
    "bad\\name.txt",
    "bad\u202e.txt",
    "x".repeat(161) + ".txt",
  ])
    expect(() => replyFileName(name)).toThrow("FILE_NAME_INVALID");
  const encodedMacro = pluginZip({
    "[Content_Types].xml":
      '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override ContentType="application/vnd.ms-excel.macro&#69;nabled.main+xml"/></Types>',
    "xl/workbook.xml":
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
  });
  await expect(
    validateReplyFile(encodedMacro, "macro.xlsx", ["xlsx"], signal()),
  ).rejects.toThrow("FILE_TYPE_MISMATCH");
  const encrypted = pluginZip({ "file.txt": "fictional" });
  encrypted.writeUInt16LE(1, 6);
  encrypted.writeUInt16LE(
    1,
    encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8,
  );
  await expect(
    validateReplyFile(encrypted, "encrypted.zip", ["zip"], signal()),
  ).rejects.toThrow("FILE_ARCHIVE_INVALID");
  const expanded = pluginZip({ "file.txt": "fictional" });
  expanded.writeUInt32LE(
    generatedFileLimits.expandedBytes + 1,
    expanded.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24,
  );
  await expect(
    validateReplyFile(expanded, "expanded.zip", ["zip"], signal()),
  ).rejects.toThrow();
  const corrupt = pluginZip({ "file.txt": "fictional payload" });
  const corruptOffset = corrupt.indexOf("fictional payload");
  corrupt[corruptOffset] = corrupt[corruptOffset]! ^ 1;
  await expect(
    validateReplyFile(corrupt, "corrupt.zip", ["zip"], signal()),
  ).rejects.toThrow("FILE_ARCHIVE_INVALID");
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    validateReplyFile(Buffer.from("x"), "a.txt", ["txt"], aborted.signal),
  ).rejects.toThrow();
});

it("requires separate saved file-export approval before broadening PNG-only workflows", () => {
  const plugin = {
    id: "fictional",
    name: "fixture",
    enabled: true,
    config: {
      connections: { sandbox: {} },
      disabledTools: [],
      tools: [
        {
          server: "sandbox",
          imageExportVersion: 1,
          definition: { name: "prepare_sandbox" },
        },
        { server: "sandbox", definition: { name: "run_command" } },
      ],
    },
  } as unknown as InstalledPlugin;
  const config = { enabled: true, pluginId: plugin.id, server: "sandbox" };
  expect(imageExportTargets([plugin])[0]?.fileTypes).toEqual(["png"]);
  expect(() => assertImageExportBinding([plugin], config)).not.toThrow();
  expect(() =>
    assertImageExportBinding([plugin], { ...config, allowedTypes: ["pdf"] }),
  ).toThrow("IMAGE_EXPORT_TARGET_UNAVAILABLE");
  expect(() =>
    assertImageExportBinding([plugin], { ...config, allowedTypes: ["gif"] }),
  ).toThrow("IMAGE_EXPORT_TARGET_UNAVAILABLE");
  plugin.config.tools[0]!.fileExportVersion = 1;
  expect(imageExportTargets([plugin])[0]?.fileTypes).toContain("gif");
  expect(() =>
    assertImageExportBinding([plugin], { ...config, allowedTypes: ["gif"] }),
  ).not.toThrow();
  expect(() =>
    assertImageExportBinding([plugin], { ...config, allowedTypes: ["pdf"] }),
  ).not.toThrow();
  expect(allowedReplyFileTypes(config)).toEqual(["png"]);
  delete plugin.config.tools[0]!.fileExportVersion;
  expect(() =>
    assertImageExportBinding([plugin], { ...config, allowedTypes: ["pdf"] }),
  ).toThrow("IMAGE_EXPORT_TARGET_UNAVAILABLE");
});
