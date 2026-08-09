import type { LinkPreviewItem } from "../../ingestion/link-preview.js";

const maxObjects = 512;
const maxDepth = 12;
const maxItems = 4;
const controlCharacters = /[\p{Cc}\p{Cf}]/gu;

function clean(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const result = value
    .replace(controlCharacters, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
  return result.length === 0 || result === "$null" ? null : result;
}

function httpUrl(value: unknown): string | null {
  const candidate = clean(value, 2_048);
  if (candidate === null) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function uid(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const candidate = (value as Record<string, unknown>).UID;
  return Number.isInteger(candidate) ? (candidate as number) : null;
}

function resolve(
  value: unknown,
  objects: readonly unknown[],
  depth = 0,
  seen = new Set<number>(),
): unknown {
  if (depth > maxDepth) return null;
  const index = uid(value);
  if (index !== null) {
    if (index < 0 || index >= objects.length || seen.has(index)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(index);
    return resolve(objects[index], objects, depth + 1, nextSeen);
  }
  return value;
}

function resolvedString(
  value: unknown,
  objects: readonly unknown[],
  depth = 0,
): string | null {
  if (depth > maxDepth) return null;
  const resolved = resolve(value, objects, depth);
  if (typeof resolved === "string") return clean(resolved, 2_048);
  if (typeof resolved !== "object" || resolved === null) return null;
  const record = resolved as Record<string, unknown>;
  for (const key of [
    "NS.relative",
    "NS.base",
    "absoluteString",
    "URL",
    "url",
    "string",
  ]) {
    const candidate = resolvedString(record[key], objects, depth + 1);
    if (candidate !== null) return candidate;
  }
  return null;
}

function referenceAvailable(
  value: unknown,
  objects: readonly unknown[],
): boolean {
  const index = uid(value);
  if (index === 0 && objects[0] === "$null") return false;
  const resolved = resolve(value, objects);
  return resolved !== null && resolved !== undefined && resolved !== "$null";
}

function metadataRecord(
  archive: Record<string, unknown>,
): { metadata: Record<string, unknown>; objects: readonly unknown[] } | null {
  const objects = archive.$objects;
  if (
    !Array.isArray(objects) ||
    objects.length === 0 ||
    objects.length > maxObjects
  )
    return null;
  const top = archive.$top;
  if (typeof top !== "object" || top === null) return null;
  const root = resolve((top as Record<string, unknown>).root, objects);
  if (typeof root !== "object" || root === null) return null;
  const metadata = resolve(
    (root as Record<string, unknown>).richLinkMetadata,
    objects,
  );
  return typeof metadata === "object" && metadata !== null
    ? { metadata: metadata as Record<string, unknown>, objects }
    : null;
}

export function parseBlueBubblesLinkPreviews(
  payloadData: unknown,
): readonly LinkPreviewItem[] {
  if (!Array.isArray(payloadData)) return [];
  const items: LinkPreviewItem[] = [];
  for (const candidate of payloadData.slice(0, maxItems)) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const parsed = metadataRecord(candidate as Record<string, unknown>);
    if (parsed === null) continue;
    const { metadata, objects } = parsed;
    const originalUrl = httpUrl(resolvedString(metadata.originalURL, objects));
    const url = httpUrl(resolvedString(metadata.URL, objects)) ?? originalUrl;
    if (url === null) continue;
    const imageUrl =
      httpUrl(resolvedString(metadata.imageURL, objects)) ??
      httpUrl(resolvedString(metadata.imageMetadata, objects)) ??
      httpUrl(resolvedString(metadata.image, objects));
    const item: LinkPreviewItem = {
      source: "bluebubbles",
      url,
      originalUrl,
      title: clean(resolvedString(metadata.title, objects), 500),
      summary: clean(resolvedString(metadata.summary, objects), 2_000),
      siteName: clean(
        resolvedString(metadata.siteName ?? metadata.site, objects),
        200,
      ),
      imageAvailable:
        imageUrl !== null ||
        referenceAvailable(metadata.image, objects) ||
        referenceAvailable(metadata.images, objects) ||
        referenceAvailable(metadata.imageMetadata, objects),
      imageUrl,
      imageSource: imageUrl === null ? null : "bluebubbles",
      iconAvailable:
        referenceAvailable(metadata.icon, objects) ||
        referenceAvailable(metadata.icons, objects) ||
        referenceAvailable(metadata.iconMetadata, objects),
    };
    items.push(item);
  }
  return items;
}
