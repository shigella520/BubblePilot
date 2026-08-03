import { access, readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const projectDirectory = process.cwd();
const rootEntries = await readdir(projectDirectory);
const documentEntries = await readdir(resolve(projectDirectory, "doc"));
const markdownFiles = [
  ...rootEntries
    .filter(
      (name) =>
        name.endsWith(".md") &&
        (name.startsWith("README") || name === "AGENTS.md"),
    )
    .map((name) => resolve(projectDirectory, name)),
  ...documentEntries
    .filter((name) => name.endsWith(".md"))
    .map((name) => resolve(projectDirectory, "doc", name)),
];

const errors = [];
for (const markdownFile of markdownFiles) {
  const source = await readFile(markdownFile, "utf8");
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    let target = (match[1] ?? "").trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    } else {
      target = target.split(/\s+/u)[0] ?? "";
    }
    if (
      target.length === 0 ||
      target.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/iu.test(target)
    ) {
      continue;
    }
    const path = target.split("#", 1)[0] ?? "";
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(path);
    } catch {
      errors.push(
        `${relative(projectDirectory, markdownFile)}: invalid link ${target}`,
      );
      continue;
    }
    const resolved = resolve(dirname(markdownFile), decodedPath);
    if (relative(projectDirectory, resolved).startsWith("..")) {
      errors.push(
        `${relative(projectDirectory, markdownFile)}: link escapes repository ${target}`,
      );
      continue;
    }
    try {
      await access(resolved);
    } catch {
      errors.push(
        `${relative(projectDirectory, markdownFile)}: missing ${target}`,
      );
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Checked local links in ${markdownFiles.length} Markdown files.\n`,
  );
}
