import type * as ChildProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { importGit } from "../modules/plugins/plugin-storage.js";
const state = vi.hoisted(() => ({ repo: "" }));
vi.mock("../modules/plugins/plugin-network.js", () => ({
  resolveTarget: (raw: string) =>
    Promise.resolve({
      url: new URL(raw),
      host: "git.example.test",
      addresses: [{ address: "127.0.0.1", family: 4 }],
    }),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (cmd: string, args: string[], options: ChildProcess.SpawnOptions) =>
      actual.spawn(
        cmd,
        args.map((a) => (a.startsWith("https://") ? state.repo : a)),
        { ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: "file" } },
      ),
  };
});
let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it("reads only the chosen tree, preserves binary files and ignores unrelated repository limits", async () => {
  root = await mkdtemp(join(tmpdir(), "plugin-subtree-"));
  state.repo = join(root, "repo");
  const staging = join(root, "staging");
  await mkdir(join(state.repo, "plugins/demo"), { recursive: true });
  await mkdir(staging);
  await mkdir(join(state.repo, "outside"));
  await Promise.all(
    Array.from({ length: 510 }, (_, i) =>
      writeFile(join(state.repo, "outside", `${i}.txt`), "fictional"),
    ),
  );
  await writeFile(join(state.repo, "outside/large.md"), "x".repeat(300000));
  await symlink("/not-accessed", join(state.repo, "outside/link"));
  await writeFile(join(state.repo, "plugins/demo/plugin.json"), "{}\n");
  const binary = Buffer.from([0, 255, 32, 10]);
  await writeFile(join(state.repo, "plugins/demo/icon.png"), binary);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: state.repo, stdio: "pipe" });
  git("init", "--quiet", "-b", "feature/demo");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const imported = await importGit(
    staging,
    "https://github.com/example/repo/tree/feature/demo/plugins/demo",
    undefined,
  );
  expect(Object.keys(imported.files).sort()).toEqual([
    "icon.png",
    "plugin.json",
  ]);
  expect(imported.files["plugin.json"]).toBe("{}\n");
  expect(Buffer.from(imported.files["icon.png"]!, "base64")).toEqual(binary);
  expect(imported.resolvedSource.directory).toBe("plugins/demo");
  expect(imported.sha).toMatch(/^[a-f0-9]{40}$/);
  await expect(
    importGit(
      staging,
      "https://git.example.test/repo.git",
      "HEAD",
      [],
      "plugins/demo/plugin.json",
    ),
  ).rejects.toThrow("GIT_DIRECTORY_REQUIRED");
  await expect(
    importGit(
      staging,
      "https://git.example.test/repo.git",
      "HEAD",
      [],
      "outside",
    ),
  ).rejects.toThrow();
  await mkdir(join(state.repo, "plugins/links"));
  await symlink("../demo/plugin.json", join(state.repo, "plugins/links/link"));
  git("add", ".");
  const sha = git("rev-parse", "HEAD").toString().trim();
  git(
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${sha},plugins/submodules/child`,
  );
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--quiet",
    "-m",
    "unsafe fixtures",
  );
  await expect(
    importGit(
      staging,
      "https://git.example.test/repo.git",
      "HEAD",
      [],
      "plugins/links",
    ),
  ).rejects.toThrow("SYMLINK_DENIED");
  await expect(
    importGit(
      staging,
      "https://git.example.test/repo.git",
      "HEAD",
      [],
      "plugins/submodules",
    ),
  ).rejects.toThrow("UNSAFE_ARCHIVE_ENTRY");
});
