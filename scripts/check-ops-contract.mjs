import { readdir, readFile } from "node:fs/promises";

import { parse } from "yaml";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string} source
 * @returns {unknown}
 */
function parseYaml(source) {
  // The YAML package's legacy overload returns any; keep that boundary typed.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const parsed = parse(source);
  return /** @type {unknown} */ (parsed);
}

const migrationNames = (await readdir("migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const [
  backupVerifier,
  dockerfile,
  dockerignore,
  dockerEntrypoint,
  composeSource,
  ...migrationSources
] = await Promise.all([
  readFile("scripts/verify-postgres-backup.sh", "utf8"),
  readFile("Dockerfile", "utf8"),
  readFile(".dockerignore", "utf8"),
  readFile("scripts/docker-entrypoint.sh", "utf8"),
  readFile("compose.yaml", "utf8"),
  ...migrationNames.map((name) => readFile(`migrations/${name}`, "utf8")),
]);

const dockerIgnoreEntries = new Set(
  dockerignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#")),
);
const localCopySources = [...dockerfile.matchAll(/^COPY\s+(?!--from=)(.+)$/gmu)]
  .flatMap((match) => (match[1] ?? "").trim().split(/\s+/u).slice(0, -1))
  .filter((source) => source !== "--chown=node:node");
const ignoredCopySources = localCopySources.filter((source) => {
  const topLevel = source.replace(/^\.\//u, "").split("/")[0];
  return topLevel !== undefined && dockerIgnoreEntries.has(topLevel);
});
if (ignoredCopySources.length > 0) {
  throw new Error(
    `Dockerfile COPY sources are excluded by .dockerignore: ${ignoredCopySources.join(", ")}`,
  );
}

if (
  !dockerfile.includes('ENTRYPOINT ["./scripts/docker-entrypoint.sh"]') ||
  !dockerEntrypoint.includes("node dist/app/migrate.js") ||
  !dockerEntrypoint.includes("exec node dist/app/main.js")
) {
  throw new Error(
    "The Docker runtime must migrate before exec'ing the application as PID 1.",
  );
}

const compose = parseYaml(composeSource);
const services = isRecord(compose) ? compose.services : undefined;
const app = isRecord(services) ? services.app : undefined;
const stopGracePeriod = isRecord(app) ? app.stop_grace_period : undefined;
const stopGraceSeconds =
  typeof stopGracePeriod === "string" && /^\d+s$/u.test(stopGracePeriod)
    ? Number(stopGracePeriod.slice(0, -1))
    : Number.NaN;
if (!Number.isFinite(stopGraceSeconds) || stopGraceSeconds < 330) {
  throw new Error(
    "The application stop_grace_period must cover the five-minute workflow budget.",
  );
}

const migrationTableNames = new Set();
for (const source of migrationSources) {
  for (const match of source.matchAll(
    /\b(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE)\s+([a-z_][a-z0-9_]*)/giu,
  )) {
    const tableName = match[1]?.toLowerCase();
    if (tableName !== undefined) migrationTableNames.add(tableName);
  }
}

const requiredTableNames = [
  ...backupVerifier.matchAll(/table_name IN \(([^)]+)\)/gu),
].flatMap((match) =>
  [...(match[1] ?? "").matchAll(/'([a-z_][a-z0-9_]*)'/gu)].map((tableMatch) =>
    tableMatch[1]?.toLowerCase(),
  ),
);

const missing = requiredTableNames.filter(
  (tableName) => tableName === undefined || !migrationTableNames.has(tableName),
);

if (missing.length > 0) {
  throw new Error(
    `Backup verification references tables absent from migrations: ${missing.join(", ")}`,
  );
}

process.stdout.write(
  `Backup verification references ${requiredTableNames.length} migrated tables.\n`,
);
