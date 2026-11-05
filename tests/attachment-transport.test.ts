import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginMcp } from "../modules/plugins/plugin-mcp.js";
it.each([true, false])(
  "reconciles a lost upload response without replaying bytes (committed=%s)",
  async (committed) => {
    const root = await mkdtemp(join(tmpdir(), "bp-transfer-reconcile-"));
    const file = join(root, "fixture.csv");
    await writeFile(file, "a,1");
    const input = { id: "fixture", size: 3, sha256: "a".repeat(64) };
    const result = { status: "imported", size: 3, sha256: input.sha256 };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ token: "b".repeat(64) }))
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce(
        Response.json(committed ? { result } : { token: "c".repeat(64) }),
      );
    const client = new PluginMcp();
    vi.spyOn(client, "attachmentVersion").mockReturnValue(1);
    Object.assign(client, {
      binaryFetch: request,
      connectionUrl: "https://example.test/mcp",
      transport: { sessionId: "fixture-session" },
    });
    try {
      const operation = client.transferAttachment(
        input,
        file,
        AbortSignal.timeout(5000),
      );
      if (committed) await expect(operation).resolves.toEqual(result);
      else await expect(operation).rejects.toThrow("connection lost");
      expect(request.mock.calls.map(([url]) => url)).toEqual([
        "https://example.test/mcp/attachments/tickets",
        "https://example.test/mcp/attachments",
        "https://example.test/mcp/attachments/tickets",
      ]);
      expect(request.mock.calls[2]?.[1]?.body).toBe(JSON.stringify(input));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
