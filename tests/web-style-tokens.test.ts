import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = "apps/web/src";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(vue|css|ts)$/u.test(name) ? [path] : [];
  });
}

const files = sources(root).map((path) => ({
  path,
  text: readFileSync(path, "utf8"),
}));

describe("web style tokens", () => {
  it("uses only CSS custom properties that are defined somewhere", () => {
    const defined = new Set<string>();
    for (const { text } of files) {
      for (const m of text.matchAll(/(?:^|[;{\s"'])(--[\w-]+)\s*:/gu))
        defined.add(m[1]!);
      // Properties set from script, e.g. style.setProperty("--x", …).
      for (const m of text.matchAll(/["'](--[\w-]+)["']/gu)) defined.add(m[1]!);
    }
    const undefinedUses = files.flatMap(({ path, text }) =>
      [...text.matchAll(/var\((--[\w-]+)/gu)]
        .map((m) => m[1]!)
        .filter((name) => !defined.has(name))
        .map((name) => `${path}: ${name}`),
    );
    expect(undefinedUses).toEqual([]);
  });

  it("keeps text at or above the 11px minimum", () => {
    const tiny = files.flatMap(({ path, text }) =>
      [...text.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/gu)]
        .filter((m) => Number(m[1]) < 11)
        .map((m) => `${path}: ${m[0]}`),
    );
    expect(tiny).toEqual([]);
  });

  it("references only defined button variants", () => {
    const variants = new Set([
      "primary",
      "secondary",
      "danger",
      "danger-ghost",
      "tiny",
      "large",
    ]);
    const css = files
      .filter(({ path }) => path.endsWith(".vue") || path.endsWith(".css"))
      .map(({ text }) => text)
      .join("\n");
    const unknown = files.flatMap(({ path, text }) =>
      [...text.matchAll(/class="([^"]*)"/gu)]
        .map((m) => m[1]!.split(/\s+/u))
        .filter((classes) => classes.includes("button"))
        .flatMap((classes) =>
          classes.filter(
            (c) =>
              c !== "button" &&
              !variants.has(c) &&
              // Component-specific hooks must have a rule of their own.
              !new RegExp(`\\.${c}\\b`, "u").test(css),
          ),
        )
        .map((c) => `${path}: ${c}`),
    );
    expect(unknown).toEqual([]);
  });
});
