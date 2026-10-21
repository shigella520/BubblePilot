import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  readdir,
  lstat,
  access,
} from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { Entry } from "yauzl";
import { fromBuffer } from "yauzl";
import {
  pluginError,
  pluginLimits,
  type PluginPackage,
} from "./plugin-types.js";
import { safePath, digest } from "./plugin-package.js";
import { resolveTarget } from "./plugin-network.js";
export class PluginStorage {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  async init() {
    if (/(?:^|\/)(public|dist|static)(?:\/|$)/.test(this.root))
      pluginError("UNSAFE_STORAGE");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink())
      pluginError("UNSAFE_STORAGE");
    await access(this.root, constants.R_OK | constants.W_OK);
  }
  async save(pkg: PluginPackage) {
    await this.init();
    const dest = join(this.root, pkg.hash);
    try {
      await this.read(pkg.hash);
      return;
    } catch {
      /* new revision */
    }
    const temp = join(this.root, `.tmp-${randomUUID()}`);
    await writeFile(temp, JSON.stringify(pkg), { mode: 0o600, flag: "wx" });
    await rename(temp, dest);
  }
  async read(hash: string): Promise<PluginPackage> {
    if (!/^[0-9a-f]{64}$/.test(hash)) pluginError("INVALID_HASH");
    const path = join(this.root, hash);
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > pluginLimits.expandedBytes * 2
    )
      pluginError("INVALID_PACKAGE_FILE");
    const pkg = JSON.parse(await readFile(path, "utf8")) as PluginPackage;
    if (
      pkg.hash !== hash ||
      digest(
        Object.entries(pkg.files).sort(([a], [b]) => a.localeCompare(b)),
      ) !== hash
    )
      pluginError("HASH_MISMATCH", 409);
    return pkg;
  }
  async collect(keep: ReadonlySet<string>) {
    for (const name of await readdir(this.root)) {
      if (!/^[a-f0-9]{64}$/.test(name) || keep.has(name)) continue;
      const file = join(this.root, name),
        stat = await lstat(file);
      if (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.mtimeMs < Date.now() - 86400000
      )
        await rm(file);
    }
  }
  async cleanup() {
    await this.init();
    for (const name of await readdir(this.root))
      if (
        name.startsWith(".tmp-") &&
        (await lstat(join(this.root, name))).mtimeMs < Date.now() - 86400000
      )
        await rm(join(this.root, name), { recursive: true, force: true });
  }
}
function decode(path: string, bytes: Buffer) {
  if (
    /\.(md|txt|json|ya?ml|csv)$/i.test(path) &&
    bytes.length > pluginLimits.textBytes
  )
    pluginError("TEXT_TOO_LARGE");
  return /\.(md|txt|json|ya?ml|csv)$/i.test(path)
    ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    : bytes.toString("base64");
}
export async function unpackZip(
  bytes: Buffer,
): Promise<Record<string, string>> {
  if (bytes.length > pluginLimits.archiveBytes)
    pluginError("ARCHIVE_TOO_LARGE");
  return new Promise((resolveResult, reject) =>
    fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) return reject(new Error("PLUGIN_INVALID_ZIP"));
        const files: Record<string, string> = {};
        let total = 0,
          count = 0;
        const fail = () => {
          zip.close();
          reject(new Error("PLUGIN_INVALID_ZIP"));
        };
        zip.on("error", fail);
        zip.on("end", () => resolveResult(files));
        zip.on("entry", (entry: Entry) => {
          void (async () => {
            const path = safePath(entry.fileName);
            const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (kind && kind !== 0o100000 && kind !== 0o040000)
              pluginError("UNSAFE_ARCHIVE_ENTRY");
            if (
              ++count > pluginLimits.files ||
              (total += entry.uncompressedSize) > pluginLimits.expandedBytes ||
              entry.generalPurposeBitFlag & 1
            )
              pluginError("ARCHIVE_TOO_LARGE");
            if (path.endsWith("/")) {
              zip.readEntry();
              return;
            }
            if (Object.hasOwn(files, path))
              pluginError("DUPLICATE_ARCHIVE_ENTRY");
            const chunks: Buffer[] = [];
            let size = 0;
            const stream = await new Promise<Readable>((res, rej) =>
              zip.openReadStream(entry, (err, s) =>
                err || !s
                  ? rej(err ?? new Error("PLUGIN_INVALID_ZIP"))
                  : res(s),
              ),
            );
            for await (const part of stream) {
              const chunk = part as Buffer;
              size += chunk.length;
              if (
                size > entry.uncompressedSize ||
                size > pluginLimits.expandedBytes
              ) {
                stream.destroy();
                pluginError("ARCHIVE_TOO_LARGE");
              }
              chunks.push(chunk);
            }
            files[path] = decode(path, Buffer.concat(chunks));
            zip.readEntry();
          })().catch(fail);
        });
        zip.readEntry();
      },
    ),
  );
}
export async function importGit(
  root: string,
  url: string,
  ref: string,
  trustedHosts: readonly string[] = [],
): Promise<{ files: Record<string, string>; sha: string }> {
  const target = await resolveTarget(url, false, trustedHosts);
  if (new URL(url).search) pluginError("INVALID_GIT_URL");
  const dir = join(root, `.tmp-${randomUUID()}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + pluginLimits.timeoutMs;
  const diskSize = async (path: string): Promise<number> => {
    const stat = await lstat(path);
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    for (const name of await readdir(path)) {
      total += await diskSize(join(path, name));
      if (total > pluginLimits.expandedBytes * 2) break;
    }
    return total;
  };
  const run = (args: string[]) =>
    new Promise<string>((res, rej) => {
      const child = spawn(
        "git",
        [
          "-c",
          `http.curloptResolve=${target.host}:${target.url.port || "443"}:${target.addresses[0]!.address}`,
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "http.followRedirects=false",
          "-c",
          "credential.helper=",
          "-c",
          "protocol.file.allow=never",
          ...args,
        ],
        {
          cwd: dir,
          env: {
            PATH: process.env.PATH,
            HOME: dir,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_ALLOW_PROTOCOL: "https",
          },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      let out = "";
      let failure = "PLUGIN_GIT_FAILED";
      const timer = setTimeout(
        () => {
          failure = "PLUGIN_GIT_TIMEOUT";
          child.kill("SIGKILL");
        },
        Math.max(1, deadline - Date.now()),
      );
      const monitor = setInterval(() => {
        void diskSize(dir)
          .then((size) => {
            if (size > pluginLimits.expandedBytes * 2) {
              failure = "PLUGIN_ARCHIVE_TOO_LARGE";
              child.kill("SIGKILL");
            }
          })
          .catch(() => child.kill("SIGKILL"));
      }, 100);
      child.stdout.on("data", (b: Buffer) => {
        out += b.toString();
        if (out.length > pluginLimits.expandedBytes) {
          failure = "PLUGIN_ARCHIVE_TOO_LARGE";
          child.kill("SIGKILL");
        }
      });
      child.on("error", () => {
        clearTimeout(timer);
        clearInterval(monitor);
        rej(new Error("PLUGIN_GIT_FAILED"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        clearInterval(monitor);
        if (code === 0) res(out.trim());
        else rej(new Error(failure));
      });
    });
  try {
    await run(["init", "--quiet"]);
    await run(["fetch", "--depth=1", "--no-tags", url, ref]);
    const sha = await run(["rev-parse", "FETCH_HEAD"]);
    await run([
      "-c",
      "core.symlinks=true",
      "checkout",
      "--detach",
      "FETCH_HEAD",
    ]);
    const files: Record<string, string> = {};
    let total = 0;
    const walk = async (base: string) => {
      for (const name of await readdir(join(dir, base))) {
        if (name === ".git") continue;
        const path = base ? `${base}/${name}` : name;
        safePath(path);
        const s = await lstat(join(dir, path));
        if (s.isSymbolicLink()) pluginError("SYMLINK_DENIED");
        if (s.isDirectory()) await walk(path);
        else {
          total += s.size;
          if (
            Object.keys(files).length >= pluginLimits.files ||
            total > pluginLimits.expandedBytes
          )
            pluginError("ARCHIVE_TOO_LARGE");
          files[path] = decode(path, await readFile(join(dir, path)));
        }
      }
    };
    await walk("");
    return { files, sha };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
