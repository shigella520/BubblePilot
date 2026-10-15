import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { collectionSchema } from "../modules/memes/meme-collection-types.js";
import { organizeMemeLibrary } from "../modules/memes/organize-meme-library.js";
const { values } = parseArgs({
  options: {
    url: { type: "string" },
    manifest: { type: "string" },
    collection: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
if (
  !values.url ||
  !values.manifest ||
  !values.collection ||
  !process.env.API_ACCESS_TOKEN
)
  throw new Error(
    "Usage: API_ACCESS_TOKEN=<existing admin token> pnpm memes:organize --url <instance URL> --manifest <import results.json> --collection <name> [--apply]",
  );
const origin = new URL(values.url);
if (
  origin.username ||
  origin.password ||
  origin.search ||
  origin.hash ||
  !["http:", "https:"].includes(origin.protocol)
)
  throw new Error(
    "Use an instance URL without credentials or query parameters.",
  );
const name = collectionSchema.parse({ name: values.collection }).name;
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, origin), {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.API_ACCESS_TOKEN!}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (!response.ok) {
    const error = Object.assign(
      new Error(`Request failed: HTTP ${response.status}`),
      { status: response.status },
    );
    throw error;
  }
  return ((await response.json()) as { data: T }).data;
}
const results = await organizeMemeLibrary(
  {
    manifest: JSON.parse(await readFile(values.manifest, "utf8")) as unknown,
    name,
    apply: values.apply,
  },
  api,
);
console.log(
  JSON.stringify(
    {
      mode: values.apply ? "apply" : "preview",
      counts: results.reduce<Record<string, number>>((counts, r) => {
        counts[r.status] = (counts[r.status] ?? 0) + 1;
        return counts;
      }, {}),
      items: results,
    },
    null,
    2,
  ),
);
if (
  results.some((r) => ["conflict", "missing", "unknown"].includes(r.status)) ||
  (values.apply && results.some((r) => r.status === "ready"))
)
  process.exitCode = 1;
