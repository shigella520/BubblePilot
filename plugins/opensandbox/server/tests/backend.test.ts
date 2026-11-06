import { it, expect, vi } from "vitest";
import { Sandbox, SandboxManager } from "@alibaba-group/opensandbox";
import { sdkBackend } from "../src/backend.js";
import { configSchema } from "../src/config.js";
it("pins image and ownership, omits CPU/mounts and verifies deletion instead of trusting acceptance", async () => {
  const list = vi.fn().mockResolvedValue({
    items: [
      { id: "own", metadata: { "bubblepilot.adapter": "fixture" } },
      { id: "foreign", metadata: { "bubblepilot.adapter": "other" } },
    ],
  });
  const kill = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(SandboxManager, "create").mockReturnValue({
    listSandboxInfos: list,
    killSandbox: kill,
    close,
  } as unknown as SandboxManager);
  const create = vi
    .spyOn(Sandbox, "create")
    .mockResolvedValue({ id: "own", close } as unknown as Sandbox);
  try {
    const config = configSchema.parse({
      SANDBOX_IMAGE: `python:3.12-slim@sha256:${"a".repeat(64)}`,
      ADAPTER_INSTANCE_ID: "fixture",
      OPENSANDBOX_URL: "http://sandbox.example.test",
      SANDBOX_CREATE_TIMEOUT_SECONDS: "120",
      ATTACHMENT_IMPORT_TIMEOUT_SECONDS: "150",
      SANDBOX_COMMAND_MAX_TIMEOUT_SECONDS: "180",
      MCP_TOKEN_FILE: "/fake/token",
      OPENSANDBOX_API_KEY_FILE: "/fake/key",
    });
    const backend = sdkBackend(config, "fictional-test-key");
    await backend.create("run-one", new AbortController().signal);
    const options = create.mock.calls[0]![0];
    expect(options.resource).toEqual({ memory: "512Mi" });
    expect(options).toMatchObject({
      image: config.SANDBOX_IMAGE,
      timeoutSeconds: 600,
      readyTimeoutSeconds: 120,
      metadata: {
        "bubblepilot.adapter": "fixture",
        "bubblepilot.session": "run-one",
      },
    });
    expect(options.connectionConfig?.requestTimeoutSeconds).toBe(180);
    expect(options).not.toHaveProperty("volumes");
    expect(await backend.owned()).toEqual(["own"]);
    expect(await backend.remove("own")).toBe(false);
    list.mockResolvedValue({ items: [] });
    expect(await backend.remove("own")).toBe(true);
    await backend.close();
  } finally {
    vi.restoreAllMocks();
  }
});
it("rejects unsafe concurrency and mutable sandbox image tags", () => {
  expect(configSchema.safeParse({ MAX_CONCURRENT_SANDBOXES: 9 }).success).toBe(
    false,
  );
  expect(
    configSchema.safeParse({ SANDBOX_IMAGE: "python:latest" }).success,
  ).toBe(false);
});

it("defaults and bounds administrator-owned timeout configuration", () => {
  for (const [key, defaultValue] of [
    ["SANDBOX_CREATE_TIMEOUT_SECONDS", 40],
    ["ATTACHMENT_IMPORT_TIMEOUT_SECONDS", 45],
  ] as const) {
    const schema = configSchema.shape[key];
    expect(schema.parse(undefined)).toBe(defaultValue);
    expect(schema.parse("180")).toBe(180);
    for (const value of ["4", "181", "5.5", "invalid", ""])
      expect(schema.safeParse(value).success).toBe(false);
  }
});

it("bounds command defaults and rejects a default above the configured maximum", () => {
  const base = {
    SANDBOX_IMAGE: `python:3.12-slim@sha256:${"a".repeat(64)}`,
    ADAPTER_INSTANCE_ID: "fixture",
    OPENSANDBOX_URL: "http://sandbox.example.test",
    MCP_TOKEN_FILE: "/fake/token",
    OPENSANDBOX_API_KEY_FILE: "/fake/key",
  };
  expect(configSchema.parse(base)).toMatchObject({
    SANDBOX_COMMAND_TIMEOUT_SECONDS: 60,
    SANDBOX_COMMAND_MAX_TIMEOUT_SECONDS: 120,
  });
  expect(
    configSchema.safeParse({ ...base, SANDBOX_COMMAND_TIMEOUT_SECONDS: 121 })
      .success,
  ).toBe(false);
  expect(
    configSchema.parse({
      ...base,
      SANDBOX_COMMAND_TIMEOUT_SECONDS: "30",
      SANDBOX_COMMAND_MAX_TIMEOUT_SECONDS: "90",
    }),
  ).toMatchObject({
    SANDBOX_COMMAND_TIMEOUT_SECONDS: 30,
    SANDBOX_COMMAND_MAX_TIMEOUT_SECONDS: 90,
  });
  for (const key of [
    "SANDBOX_COMMAND_TIMEOUT_SECONDS",
    "SANDBOX_COMMAND_MAX_TIMEOUT_SECONDS",
  ])
    for (const value of [0, 181, 1.5, "invalid", ""])
      expect(configSchema.safeParse({ ...base, [key]: value }).success).toBe(
        false,
      );
});
