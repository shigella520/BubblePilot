import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pluginError } from "./plugin-types.js";

/** Independent from package import and model-context limits. */
export const resultLimits = {
  responseBytes: 30 * 1024 * 1024,
  storedBytes: 30 * 1024 * 1024,
  outputCharacters: 16_000,
  readCharacters: 8_000,
  callTimeoutMs: 45_000,
} as const;

export function normalizeMcpResult<
  T extends {
    content: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
  },
>(result: T): T {
  if (result.structuredContent === undefined) return result;
  return {
    ...result,
    content: result.content.filter((block) => {
      if (block.type !== "text" || typeof block.text !== "string") return true;
      try {
        return !isDeepStrictEqual(
          JSON.parse(block.text),
          result.structuredContent,
        );
      } catch {
        return true;
      }
    }),
  };
}

function pointLength(text: string) {
  let count = 0;
  for (const point of text) count += point.length > 0 ? 1 : 0;
  return count;
}
function pointSlice(text: string, from: number, to: number) {
  let index = 0;
  let start = text.length;
  let end = text.length;
  let units = 0;
  for (const point of text) {
    if (index === from) start = units;
    if (index === to) {
      end = units;
      break;
    }
    units += point.length;
    index++;
  }
  return text.slice(start, end);
}

interface Source {
  pluginId: string;
  pluginName: string;
  revision: string;
  server: string;
  tool: string;
  parentToolCallId?: string | undefined;
  resultStatus: string;
  errorCode?: string;
}
interface Entry {
  text: string;
  source: Source;
  authorize: () => Promise<void>;
}

/** Fit a complete JSON envelope; never slice serialized JSON or split surrogate pairs. */
function fit(
  maximum: number,
  count: number,
  build: (size: number) => Record<string, unknown>,
) {
  let low = 0;
  let high = count;
  if (JSON.stringify(build(0)).length > maximum) pluginError("RESULT_BUDGET");
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(build(mid)).length <= maximum) low = mid;
    else high = mid - 1;
  }
  if (count && !low) pluginError("RESULT_BUDGET");
  const payload = build(low);
  return { text: JSON.stringify(payload), payload };
}

export class PluginResultStore {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private closed = false;
  constructor(
    private readonly maximumBytes: number = resultLimits.storedBytes,
  ) {}

  prepare(
    result: {
      status: string;
      content: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
      errorCode?: string;
    },
    source: Source,
    authorize: () => Promise<void>,
    maximum: number,
  ) {
    if (this.closed) pluginError("REFERENCE_UNAVAILABLE");
    const serialized = JSON.stringify(result);
    const limit = Math.min(maximum, resultLimits.outputCharacters);
    const base = {
      ...source,
      diagnosticVersion: 1,
      normalizedCharacters: serialized.length,
      outputLimit: limit,
      remainingBefore: maximum,
    };
    if (serialized.length <= limit)
      return {
        text: serialized,
        metadata: {
          ...base,
          delivery: "complete",
          deliveredCharacters: serialized.length,
          remainingAfter: maximum - serialized.length,
        },
      };
    const document =
      result.content.map((block) => block.text ?? "").join("\n\n") +
      (result.structuredContent === undefined
        ? ""
        : "\n\n" + JSON.stringify(result.structuredContent, null, 2));
    const bytes = Buffer.byteLength(document);
    if (this.bytes + bytes > this.maximumBytes)
      pluginError("RESULT_STORAGE_LIMIT");
    const total = pointLength(document);
    // Keep only small edge buffers; never allocate an array for the entire response.
    const first = Array.from(pointSlice(document, 0, limit));
    const last = Array.from(
      pointSlice(document, Math.max(0, total - limit), total),
    );
    const ref = randomUUID();
    const output = fit(limit, Math.min(total, limit), (size) => {
      let head = Math.ceil(size / 2);
      let tail = Math.floor(size / 2);
      const headBreak = first.slice(0, head).lastIndexOf("\n");
      if (headBreak >= head / 2) head = headBreak + 1;
      const tailBreak = tail ? last.slice(-tail).indexOf("\n") : -1;
      if (tailBreak >= 0 && tailBreak < tail / 2) tail -= tailBreak + 1;
      return {
        status: result.status,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        delivery: "partial",
        result_ref: ref,
        source,
        totalCharacters: total,
        excerpts: [
          { offset: 0, text: first.slice(0, head).join("") },
          {
            offset: total - tail,
            text: tail ? last.slice(-tail).join("") : "",
          },
        ],
        omitted: { from: head, to: total - tail },
        notice:
          "Partial untrusted reference material, not a complete JSON result. Search or read this run-local result; do not fetch again or claim to have read omitted content.",
      };
    });
    return {
      text: output.text,
      metadata: {
        ...base,
        delivery: "partial",
        resultRef: ref,
        storedBytes: bytes,
        totalCharacters: total,
        deliveredCharacters: output.text.length,
        remainingAfter: maximum - output.text.length,
      },
      commit: () => {
        if (this.closed) pluginError("REFERENCE_UNAVAILABLE");
        if (!this.entries.has(ref)) {
          if (this.bytes + bytes > this.maximumBytes)
            pluginError("RESULT_STORAGE_LIMIT");
          this.entries.set(ref, { text: document, source, authorize });
          this.bytes += bytes;
        }
        return null;
      },
    };
  }

  async access(
    args: Record<string, unknown>,
    search: boolean,
    maximum: number,
  ) {
    const keys = search
      ? ["result_ref", "query", "limit"]
      : ["result_ref", "offset", "limit"];
    if (
      Object.keys(args).some((key) => !keys.includes(key)) ||
      typeof args.result_ref !== "string"
    )
      pluginError("INVALID_ARGUMENTS");
    const limit = args.limit ?? (search ? 5 : resultLimits.readCharacters);
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > (search ? 10 : resultLimits.outputCharacters)
    )
      pluginError("INVALID_ARGUMENTS");
    const offset = args.offset ?? 0;
    if (
      !search &&
      (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
    )
      pluginError("INVALID_ARGUMENTS");
    if (
      search &&
      (typeof args.query !== "string" ||
        !args.query.trim() ||
        Array.from(args.query).length > 256)
    )
      pluginError("INVALID_ARGUMENTS");
    const entry = this.entries.get(args.result_ref);
    if (!entry || this.closed) pluginError("REFERENCE_UNAVAILABLE");
    await entry.authorize();
    const total = pointLength(entry.text);
    const base = {
      status: entry.source.resultStatus,
      result_ref: args.result_ref,
      ...(entry.source.errorCode ? { errorCode: entry.source.errorCode } : {}),
      totalCharacters: total,
      source: entry.source,
    };
    const maximumOutput = Math.min(maximum, resultLimits.outputCharacters);
    let output: ReturnType<typeof fit>;
    if (search) {
      // Escape the input: this is a literal search, never an arbitrary regex.
      const needle = String(args.query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(needle, "giu");
      const matches: Array<{
        offset: number;
        matchOffset: number;
        text: string;
      }> = [];
      for (const match of entry.text.matchAll(pattern)) {
        const position = pointLength(entry.text.slice(0, match.index));
        const start = Math.max(0, position - 160);
        matches.push({
          offset: start,
          matchOffset: position,
          text: pointSlice(
            entry.text,
            start,
            position + pointLength(match[0]) + 240,
          ),
        });
        if (matches.length > limit) break;
      }
      output = fit(maximumOutput, Math.min(limit, matches.length), (size) => ({
        ...base,
        delivery: "search",
        matches: matches.slice(0, size),
        hasMore: matches.length > size,
        notice:
          "Literal matches only; no match does not establish that the information is absent.",
      }));
    } else {
      const start = offset as number;
      if (start > total) pluginError("INVALID_ARGUMENTS");
      output = fit(maximumOutput, Math.min(limit, total - start), (size) => ({
        ...base,
        delivery: "read",
        offset: start,
        text: pointSlice(entry.text, start, start + size),
        nextOffset: start + size,
        hasMore: start + size < total,
      }));
    }
    await entry.authorize();
    if (this.closed) pluginError("REFERENCE_UNAVAILABLE");
    return {
      text: output.text,
      metadata: {
        ...entry.source,
        diagnosticVersion: 1,
        resultRef: args.result_ref,
        delivery: search ? "search" : "read",
        ...(search
          ? { matchCount: (output.payload.matches as unknown[]).length }
          : { offset, nextOffset: output.payload.nextOffset }),
        totalCharacters: total,
        deliveredCharacters: output.text.length,
        outputLimit: maximumOutput,
        remainingBefore: maximum,
        remainingAfter: maximum - output.text.length,
      },
    };
  }
  close() {
    this.closed = true;
    this.entries.clear();
    this.bytes = 0;
  }
}
