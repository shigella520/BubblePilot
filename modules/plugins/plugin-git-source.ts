import { pluginError } from "./plugin-types.js";
import { safePath } from "./plugin-package.js";

export function pluginDirectory(value: string): string {
  if (value === "." || value === "") return ".";
  const path = safePath(value.replace(/\/$/, ""));
  if (
    path.split("/").some((p) => !p || p === ".") ||
    /[\p{Cc}]/u.test(path) ||
    path.includes(":")
  )
    pluginError("UNSAFE_PATH");
  return path;
}
/** Only GitHub tree/blob URLs have a portable, known web URL layout. */
export function parseGitSource(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    pluginError("INVALID_GIT_URL");
  let parts: string[];
  try {
    parts = url.pathname
      .split("/")
      .filter(Boolean)
      .map((p) => decodeURIComponent(p));
  } catch {
    return pluginError("INVALID_GIT_URL");
  }
  if (url.hostname === "github.com" && parts.length >= 3) {
    if (!["tree", "blob"].includes(parts[2]!) || parts.length < 5 || url.port)
      pluginError("INVALID_GIT_URL");
    if (!/^[\w.-]+$/.test(parts[0]!) || !/^[\w.-]+$/.test(parts[1]!))
      pluginError("INVALID_GIT_URL");
    const tail = parts.slice(3).join("/");
    pluginDirectory(tail);
    return {
      url: `https://github.com/${parts[0]}/${parts[1]!.replace(/\.git$/, "")}.git`,
      tail,
    };
  }
  return { url: url.href, tail: null };
}
export function resolveGitDirectory(
  tail: string,
  refs: string,
  explicitRef?: string,
  explicitDirectory?: string,
) {
  if (explicitDirectory !== undefined) pluginError("GIT_SOURCE_AMBIGUOUS");
  const candidates = new Map<
    string,
    { ref: string; directory: string; sha: string }
  >();
  for (const line of refs.split("\n")) {
    const [sha, full] = line.split(/\s+/);
    if (!sha || !/^[a-f0-9]{40,64}$/.test(sha) || !full || full.endsWith("^{}"))
      continue;
    const name = full.replace(/^refs\/(heads|tags)\//, "");
    if (explicitRef && name !== explicitRef && full !== explicitRef) continue;
    if (tail.startsWith(name + "/")) {
      const directory = pluginDirectory(tail.slice(name.length + 1));
      candidates.set(`${name}:${sha}`, { ref: full, directory, sha });
    }
  }
  const [first, ...rest] = tail.split("/");
  if (
    /^[a-f0-9]{40}$/i.test(first!) &&
    rest.length &&
    (!explicitRef || explicitRef === first)
  )
    candidates.set(first!, {
      ref: first!,
      sha: first!,
      directory: pluginDirectory(rest.join("/")),
    });
  if (!candidates.size) pluginError("GIT_REF_NOT_FOUND");
  if (candidates.size !== 1) pluginError("GIT_SOURCE_AMBIGUOUS");
  return [...candidates.values()][0]!;
}
