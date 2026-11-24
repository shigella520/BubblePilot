import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

// Inspect string/template AST nodes, not TS generics or comments. New XML
// payloads belong in the typed projection module; there is no inline allowlist.
const root = "modules";
const serializer = "modules/ai/prompt-xml.ts";
/** @type {string[]} */
const failures = [];
/** @param {string} directory */
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      await inspect(file);
      continue;
    }
    if (!file.endsWith(".ts")) continue;
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    /** @param {ts.Node} node @param {string} reason */
    const fail = (node, reason) =>
      failures.push(
        `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${reason}`,
      );
    /** @param {ts.Node} node */
    function visit(node) {
      if (file !== serializer) {
        if (ts.isTemplateExpression(node)) {
          let previous = node.head.text;
          for (const span of node.templateSpans) {
            if (
              /<\/?$/u.test(previous) &&
              /^(?:\/?>|\s+[a-z_]+\s*=)/u.test(span.literal.text)
            )
              fail(node, "Dynamic XML tag names are forbidden.");
            previous = span.literal.text;
          }
        }
        if (
          ts.isStringLiteralLike(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node)
        ) {
          if (/<\/?[a-z][a-z0-9_]*(?:\s[^<>]*|\s*\/?)>/u.test(node.text))
            fail(node, "Build XML through the typed prompt-xml module.");
          if (/^xmlbuilder2(?:\/|$)/u.test(node.text))
            fail(node, "Only prompt-xml may import the XML library.");
        }
      } else if (
        ts.isPropertyAccessExpression(node) &&
        ["raw", "dat", "dtd", "ins", "import"].includes(node.name.text)
      ) {
        fail(
          node,
          "Raw XML, CDATA, DTD, processing instructions and XML imports are forbidden.",
        );
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
await inspect(root);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log("Prompt XML boundaries checked.");
