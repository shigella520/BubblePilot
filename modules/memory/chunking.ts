import { authorLabel, type MessageAuthor } from "../identity/bot-identity.js";
import { createHash } from "node:crypto";
export interface MemoryMessage {
  id: string;
  index: number;
  sentAt: string;
  senderId: string;
  role: "user" | "assistant";
  author?: MessageAuthor;
  text: string;
  hash: string;
  excerptStart?: number;
  excerptEnd?: number;
}
export interface MemoryChunk {
  text: string;
  sources: { messageId: string; hash: string; start: number; end: number }[];
  from: number;
  through: number;
}
export function keywordTokens(text: string): string[] {
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  return [
    ...new Set([
      ...[...segmenter.segment(text.toLowerCase())]
        .filter((s) => s.isWordLike)
        .map((s) => s.segment),
      ...(text.toLowerCase().match(/[a-z0-9]+(?:[-_.][a-z0-9]+)*/gu) ?? []),
    ]),
  ].slice(0, 1000);
}
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function chunkMessages(
  messages: readonly MemoryMessage[],
): MemoryChunk[] {
  const result: MemoryChunk[] = [];
  let current: MemoryChunk | null = null;
  let lastTime = 0;
  for (const message of messages) {
    const time = Date.parse(message.sentAt);
    const header = `${message.sentAt} sender_id=${message.senderId} role=${message.role} author=${message.author ? authorLabel(message.author) : "unknown"}\n`;
    const size = Math.max(1, 1600 - header.length);
    for (let offset = 0; offset < message.text.length; offset += size) {
      const part = header + message.text.slice(offset, offset + size);
      if (
        current &&
        (current.text.length >= 800 ||
          current.text.length + part.length + 1 > 1600 ||
          time - lastTime > 30 * 60_000)
      ) {
        result.push(current);
        current = null;
      }
      if (!current)
        current = {
          text: "",
          sources: [],
          from: message.index,
          through: message.index,
        };
      current.text += (current.text ? "\n" : "") + part;
      current.through = message.index;
      current.sources.push({
        messageId: message.id,
        hash: message.hash,
        start: offset,
        end: Math.min(offset + size, message.text.length),
      });
      lastTime = time;
    }
  }
  if (current) result.push(current);
  return result;
}
export function fuseRanks<T extends { id: string }>(
  lists: readonly (readonly T[])[],
): T[] {
  const rows = new Map<string, { value: T; score: number }>();
  for (const list of lists)
    list.forEach((value, index) => {
      const previous = rows.get(value.id);
      rows.set(value.id, {
        value,
        score: (previous?.score ?? 0) + 1 / (60 + index + 1),
      });
    });
  return [...rows.values()]
    .sort((a, b) => b.score - a.score || a.value.id.localeCompare(b.value.id))
    .map((row) => row.value);
}
