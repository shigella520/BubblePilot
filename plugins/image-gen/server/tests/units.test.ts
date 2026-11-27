import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { effectiveQuality, readConfig } from "../src/config.js";
import { ToolError } from "../src/errors.js";
import {
  normalizeOutput,
  preview,
  sniffMime,
  validateExportPng,
} from "../src/images.js";
import { inCidr, selectListenAddress } from "../src/listen.js";
import { DailyQuota, localDay } from "../src/quota.js";
import { validWorkspacePath } from "../src/workspace.js";
import { quotaFile, solid } from "./support.js";

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof ToolError ? error.message : "other"),
  );

it("selects a non-LAN listen address and fails closed", () => {
  const interfaces = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    eth0: [{ address: "192.168.31.78", family: "IPv4", internal: false }],
    eth1: [{ address: "172.24.0.5", family: "IPv4", internal: false }],
    eth2: [{ address: "fe80::1", family: "IPv6", internal: false }],
  } as unknown as Parameters<typeof selectListenAddress>[0];
  expect(selectListenAddress(interfaces, ["192.168.31.0/24"])).toBe(
    "172.24.0.5",
  );
  expect(() =>
    selectListenAddress({ eth0: interfaces.eth0 }, ["192.168.31.0/24"]),
  ).toThrow(/No IPv4/);
  expect(selectListenAddress(interfaces, [], "10.0.0.2")).toBe("10.0.0.2");
  expect(() =>
    selectListenAddress(interfaces, ["192.168.31.0/24"], "0.0.0.0"),
  ).toThrow();
  expect(inCidr("192.168.31.78", "192.168.31.64/27")).toBe(true);
  expect(inCidr("192.168.31.96", "192.168.31.64/27")).toBe(false);
});

it("reads config with defaults, exclusive secrets and quality ceilings", () => {
  const base = {
    IMAGE_API_BASE_URL: "https://images.example.test",
    MCP_BEARER_TOKEN: "fictional-bearer-token-0123456789",
    IMAGE_API_KEY: "fictional-upstream-key-000000000000",
    UNRELATED_ENV: "ignored",
  };
  const { config, token, apiKey } = readConfig(base);
  expect(config).toMatchObject({
    IMAGE_MODEL: "gpt-image-2",
    IMAGE_DEFAULT_QUALITY: "medium",
    IMAGE_MAX_QUALITY: "high",
    IMAGE_DAILY_LIMIT: 20,
    IMAGE_SESSION_LIMIT: 4,
    IMAGE_TIMEOUT_SECONDS: 150,
    IMAGE_QUOTA_TIMEZONE: "Asia/Shanghai",
    LISTEN_EXCLUDE_CIDR: [],
  });
  expect(token).toBe(base.MCP_BEARER_TOKEN);
  expect(apiKey).toBe(base.IMAGE_API_KEY);
  expect(() => readConfig({ ...base, MCP_BEARER_TOKEN_FILE: "/x" })).toThrow(
    /MCP_BEARER_TOKEN/,
  );
  expect(() => readConfig({ ...base, IMAGE_API_KEY: "short" })).toThrow(
    /Invalid secret/,
  );
  expect(() =>
    readConfig({ ...base, IMAGE_API_BASE_URL: "https://u:p@x.test" }),
  ).toThrow();
  expect(() =>
    readConfig({
      ...base,
      IMAGE_DEFAULT_QUALITY: "high",
      IMAGE_MAX_QUALITY: "low",
    }),
  ).toThrow();
  expect(
    readConfig({ ...base, LISTEN_EXCLUDE_CIDR: "192.168.31.0/24, 10.0.0.0/8" })
      .config.LISTEN_EXCLUDE_CIDR,
  ).toEqual(["192.168.31.0/24", "10.0.0.0/8"]);
  const ceiling = {
    IMAGE_DEFAULT_QUALITY: "medium",
    IMAGE_MAX_QUALITY: "medium",
  } as const;
  expect(effectiveQuality("high", ceiling)).toBe("medium");
  expect(effectiveQuality(undefined, ceiling)).toBe("medium");
  expect(effectiveQuality("auto", ceiling)).toBe("medium");
  expect(effectiveQuality("low", ceiling)).toBe("low");
  expect(
    effectiveQuality("auto", {
      IMAGE_DEFAULT_QUALITY: "low",
      IMAGE_MAX_QUALITY: "high",
    }),
  ).toBe("auto");
});

it("counts daily quota persistently, resets by local day and releases reservations", async () => {
  const file = await quotaFile();
  let now = new Date("2026-11-27T15:59:00Z"); // 23:59 in Asia/Shanghai
  const quota = new DailyQuota(file, 2, "Asia/Shanghai", () => now);
  const releaseFirst = await quota.reserve();
  await quota.reserve();
  expect(await code(quota.reserve())).toBe("quota_exceeded");
  await releaseFirst();
  await releaseFirst(); // idempotent
  expect((await quota.snapshot()).used).toBe(1);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    day: "2026-11-27",
    used: 1,
  });
  const reloaded = new DailyQuota(file, 2, "Asia/Shanghai", () => now);
  expect((await reloaded.snapshot()).used).toBe(1);
  now = new Date("2026-11-27T16:00:01Z"); // next local day
  expect(await reloaded.snapshot()).toMatchObject({
    day: "2026-11-28",
    used: 0,
  });
  expect(localDay(new Date("2026-11-27T16:00:00Z"), "UTC")).toBe("2026-11-27");
});

it("sniffs content, normalises outputs and validates exports", async () => {
  const png = await solid("png");
  const jpeg = await solid("jpeg");
  const webp = await solid("webp");
  expect(sniffMime(png)).toBe("image/png");
  expect(sniffMime(jpeg)).toBe("image/jpeg");
  expect(sniffMime(webp)).toBe("image/webp");
  expect(sniffMime(Buffer.from("GIF89a....."))).toBeNull();
  const converted = await normalizeOutput(jpeg);
  expect(sniffMime(converted.png)).toBe("image/png");
  expect([converted.width, converted.height]).toEqual([64, 48]);
  await expect(validateExportPng(converted.png)).resolves.toBeUndefined();
  expect(await code(validateExportPng(jpeg))).toBe("image_invalid");
  expect(await code(validateExportPng(png.subarray(0, 40)))).toBe(
    "image_invalid",
  );
  expect(await code(normalizeOutput(Buffer.from("junk")))).toBe(
    "input_type_unsupported",
  );
  const shown = await preview(await solid("png", 3000, 1000));
  expect(shown).toMatchObject({
    width: 2048,
    sourceWidth: 3000,
    transformed: true,
    firstFrameOnly: false,
  });
  expect(Buffer.from(shown.data, "base64").length).toBe(shown.bytes);
});

it("accepts only plugin workspace paths", () => {
  expect(validWorkspacePath("/workspace/image-gen/out/a.png")).toBe(true);
  for (const path of [
    "/workspace/a.png",
    "/workspace/image-gen/",
    "/workspace/image-gen/../x.png",
    "/workspace/image-gen/./x.png",
    "/workspace/image-gen/a\\b.png",
    "/workspace/image-gen/a\0.png",
    "/workspace/image-gen//x.png",
  ])
    expect(validWorkspacePath(path)).toBe(false);
});
