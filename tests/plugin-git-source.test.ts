import { describe, it, expect } from "vitest";
import {
  parseGitSource,
  resolveGitDirectory,
  pluginDirectory,
} from "../modules/plugins/plugin-git-source.js";
const sha = "a".repeat(40),
  other = "b".repeat(40);
describe("GitHub plugin directory links", () => {
  it.each(["tree", "blob"])("recognizes %s directory URLs", (kind) => {
    expect(
      parseGitSource(
        `https://github.com/example/repo/${kind}/main/plugins/demo`,
      ),
    ).toEqual({
      url: "https://github.com/example/repo.git",
      tail: "main/plugins/demo",
    });
    expect(
      resolveGitDirectory("main/plugins/demo", `${sha}\trefs/heads/main`),
    ).toEqual({ ref: "refs/heads/main", sha, directory: "plugins/demo" });
  });
  it("resolves slash-containing refs against actual remote refs and rejects ambiguity", () => {
    const refs = `${sha}\trefs/heads/release/v1`;
    expect(resolveGitDirectory("release/v1/plugins/demo", refs).directory).toBe(
      "plugins/demo",
    );
    expect(() =>
      resolveGitDirectory(
        "release/v1/plugins/demo",
        `${refs}\n${other}\trefs/heads/release`,
      ),
    ).toThrow("GIT_SOURCE_AMBIGUOUS");
    expect(
      resolveGitDirectory(
        "release/v1/plugins/demo",
        `${refs}\n${other}\trefs/heads/release`,
        "release/v1",
      ).directory,
    ).toBe("plugins/demo");
    expect(() =>
      resolveGitDirectory(
        "main/plugins/demo",
        `${sha}\trefs/heads/main\n${other}\trefs/tags/main`,
      ),
    ).toThrow("GIT_SOURCE_AMBIGUOUS");
    expect(() => resolveGitDirectory("unknown/plugin", refs)).toThrow(
      "GIT_REF_NOT_FOUND",
    );
    expect(resolveGitDirectory(`${sha}/plugins/demo`, "").sha).toBe(sha);
  });
  it("retains ordinary HTTPS repositories and rejects unsafe locations", () => {
    expect(parseGitSource("https://git.example.test/repo.git").tail).toBeNull();
    for (const url of [
      "http://github.com/a/b",
      "https://user:pass@github.com/a/b",
      "https://github.com/a/b?token=x",
      "https://github.com/a/b/tree/main/plugins%2F..%2Fevil",
    ])
      expect(() => parseGitSource(url)).toThrow();
    for (const path of ["../x", "x/../y", "x//y", "/x", "x:y", "x/.git/y"])
      expect(() => pluginDirectory(path)).toThrow();
  });
});
