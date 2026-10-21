import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTarget, safeFetch } from "../modules/plugins/plugin-network.js";
import { isPublicResourceAddressAllowed } from "../modules/shared/public-network-policy.js";
import { networkSettingsUpdateSchema } from "../modules/shared/network-settings.js";
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));
beforeEach(() => {
  lookupMock.mockReset();
});
describe("shared Fake-IP policy", () => {
  it("uses exact normalized DNS names, not arbitrary URLs or private IP approval", () => {
    expect(
      networkSettingsUpdateSchema.parse({
        trustedFakeIpHosts: [" EXAMPLE.TEST ", "example.test"],
        expectedVersion: 1,
      }).trustedFakeIpHosts,
    ).toEqual(["example.test"]);
    for (const host of [
      "*.example.test",
      "https://example.test",
      "example.test:443",
      "127.0.0.1",
      "198.18.1.1",
      "::1",
    ]) {
      expect(
        networkSettingsUpdateSchema.safeParse({
          trustedFakeIpHosts: [host],
          expectedVersion: 1,
        }).success,
      ).toBe(false);
    }
  });
  it("allows only trusted Fake-IP for both images and plugins", async () => {
    for (const address of ["198.18.0.1", "198.19.255.254"]) {
      lookupMock.mockResolvedValue([{ address, family: 4 }]);
      await expect(
        resolveTarget("https://example.test/repo", false),
      ).rejects.toThrow("NETWORK_TARGET_DENIED");
      await expect(
        resolveTarget("https://EXAMPLE.test/repo", false, ["example.test"]),
      ).resolves.toMatchObject({ addresses: [{ address }] });
      expect(
        isPublicResourceAddressAllowed("example.test", address, 4, {
          trustedProxyHosts: ["example.test"],
        }),
      ).toBe(true);
      await expect(
        resolveTarget("https://sub.example.test/repo", false, ["example.test"]),
      ).rejects.toThrow();
    }
  });
  it("keeps private addresses and mixed DNS denied even for trusted names", async () => {
    for (const [address, family] of [
      ["127.0.0.1", 4],
      ["10.1.1.1", 4],
      ["169.254.169.254", 4],
      ["192.168.31.11", 4],
      ["::1", 6],
      ["::ffff:127.0.0.1", 6],
      ["fc00::1", 6],
    ] as const) {
      lookupMock.mockResolvedValue([
        { address: "198.18.1.1", family: 4 },
        { address, family },
      ]);
      await expect(
        resolveTarget("https://example.test", false, ["example.test"]),
      ).rejects.toThrow();
      expect(
        isPublicResourceAddressAllowed("example.test", address, family, {
          trustedProxyHosts: ["example.test"],
        }),
      ).toBe(false);
    }
    await expect(
      resolveTarget("http://example.test", false, ["example.test"]),
    ).rejects.toThrow();
    await expect(
      resolveTarget("https://user:password@example.test", false, [
        "example.test",
      ]),
    ).rejects.toThrow();
  });
  it("refreshes MCP trust on every request and blocks cross-origin before transmission", async () => {
    const hosts = vi.fn().mockResolvedValue([]);
    const fetcher = safeFetch("https://example.test/mcp", false, hosts);
    lookupMock.mockResolvedValue([{ address: "198.18.1.1", family: 4 }]);
    await expect(fetcher("https://example.test/mcp")).rejects.toThrow(
      "NETWORK_TARGET_DENIED",
    );
    await expect(fetcher("https://example.test/mcp")).rejects.toThrow(
      "NETWORK_TARGET_DENIED",
    );
    expect(hosts).toHaveBeenCalledTimes(2);
    await expect(fetcher("https://other.example.test/mcp")).rejects.toThrow(
      "CROSS_ORIGIN_DENIED",
    );
  });
});
