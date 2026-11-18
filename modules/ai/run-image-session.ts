import { sha256 } from "../../app/canonical-json.js";
import type { AiImageContentPart } from "./ai-types.js";
import type { PreparedImageInput } from "./native-image-input.js";
import type { ImageBudgetView } from "./chat-image-session.js";

/** Shared run-local quota and deduplication; source authorization stays with callers. */
export class RunImageSession {
  readonly settings;
  private count: number;
  private bytes: number;
  private readonly automatic: number;
  private readonly loaded = new Map<string, AiImageContentPart>();
  private pending: AiImageContentPart[] = [];
  hasToolImages = false;
  constructor(prepared?: PreparedImageInput) {
    this.settings = prepared?.settings && structuredClone(prepared.settings);
    this.count = prepared?.selectedCount ?? 0;
    this.automatic = this.count;
    this.bytes = prepared?.totalBytes ?? 0;
    for (const part of prepared?.parts ?? [])
      this.loaded.set(this.hash(part), part);
  }
  private hash(part: AiImageContentPart) {
    return sha256(part.dataUrl.split(",")[1] ?? "");
  }
  find(part: AiImageContentPart) {
    return this.loaded.get(this.hash(part));
  }
  canAdd(bytes: number, extraCount = 0, extraBytes = 0) {
    return (
      !!this.settings?.enabled &&
      this.count + extraCount < this.settings.maxTotalImages &&
      bytes <= this.settings.maxImageBytes &&
      this.bytes + extraBytes + bytes <= this.settings.maxTotalBytes
    );
  }
  add(part: AiImageContentPart, bytes: number) {
    const existing = this.find(part);
    if (existing) {
      this.hasToolImages = true;
      return existing;
    }
    if (!this.canAdd(bytes)) return null;
    this.loaded.set(this.hash(part), part);
    this.pending.push(part);
    this.count++;
    this.bytes += bytes;
    this.hasToolImages = true;
    return part;
  }
  snapshot(): ImageBudgetView {
    return {
      count: {
        used: this.count,
        limit: this.settings?.maxTotalImages ?? 0,
        remaining: Math.max(
          0,
          (this.settings?.maxTotalImages ?? 0) - this.count,
        ),
      },
      bytes: {
        used: this.bytes,
        limit: this.settings?.maxTotalBytes ?? 0,
        remaining: Math.max(
          0,
          (this.settings?.maxTotalBytes ?? 0) - this.bytes,
        ),
      },
      automatic: this.automatic,
      tool: this.count - this.automatic,
    };
  }
  peek() {
    return this.pending;
  }
  drain() {
    const pending = this.pending;
    this.pending = [];
    return pending;
  }
  close() {
    this.pending = [];
    this.loaded.clear();
  }
}
