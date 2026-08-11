import { readFile } from "node:fs/promises";

const [configSource, composeSource, environmentExample, contractDocument] =
  await Promise.all([
    readFile("app/config.ts", "utf8"),
    readFile("compose.yaml", "utf8"),
    readFile(".env.example", "utf8"),
    readFile("doc/接口与配置契约.md", "utf8"),
  ]);

/**
 * @param {string} source
 * @param {RegExp} expression
 * @returns {Set<string>}
 */
function matches(source, expression) {
  /** @type {Set<string>} */
  const values = new Set();
  for (const match of source.matchAll(expression)) {
    const value = match[1];
    if (value !== undefined) values.add(value);
  }
  return values;
}

const runtimeVariables = matches(configSource, /^ {4}([A-Z][A-Z0-9_]+):/gmu);
const composeApp = composeSource.split("  app:\n")[1]?.split("    ports:\n")[0];
if (composeApp === undefined) {
  throw new Error("Could not locate the Compose app environment section.");
}
const composeVariables = matches(composeApp, /^ {6}([A-Z][A-Z0-9_]+):/gmu);
const documentedVariables = matches(
  contractDocument,
  /^\| `([A-Z][A-Z0-9_]+)`\s+\|\s+(?:是|否)\s+\|/gmu,
);
const exampleVariables = matches(environmentExample, /^([A-Z][A-Z0-9_]*)=/gmu);

const allowedExampleOnlyVariables = new Set([
  "BUBBLEPILOT_IMAGE",
  "OPENAI_API_KEY",
  "POSTGRES_DB",
  "POSTGRES_PASSWORD",
  "POSTGRES_USER",
  "SEARXNG_SECRET",
  "TZ",
]);
const containerRuntimeVariables = new Set(["TZ"]);

const errors = [];
for (const variable of runtimeVariables) {
  if (!composeVariables.has(variable)) {
    errors.push(`Runtime variable missing from Compose: ${variable}`);
  }
  if (!documentedVariables.has(variable)) {
    errors.push(`Runtime variable missing from documentation: ${variable}`);
  }
  if (!exampleVariables.has(variable)) {
    errors.push(`Runtime variable missing from .env.example: ${variable}`);
  }
}
for (const variable of composeVariables) {
  if (
    !runtimeVariables.has(variable) &&
    !containerRuntimeVariables.has(variable)
  ) {
    errors.push(`Compose app variable missing from runtime: ${variable}`);
  }
}
for (const variable of documentedVariables) {
  if (
    !runtimeVariables.has(variable) &&
    !allowedExampleOnlyVariables.has(variable)
  ) {
    errors.push(`Documented variable has no known consumer: ${variable}`);
  }
}
for (const variable of exampleVariables) {
  if (
    !runtimeVariables.has(variable) &&
    !allowedExampleOnlyVariables.has(variable)
  ) {
    errors.push(`Example variable has no known consumer: ${variable}`);
  }
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Configuration contract matches ${runtimeVariables.size} runtime variables.\n`,
  );
}
