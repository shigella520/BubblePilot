import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ToolError } from "./errors.js";

export function localDay(now: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Daily upstream call counter persisted on a volume. A call is charged once
 * the request may have reached the upstream (unknown outcomes included);
 * failures proven to happen before sending are released.
 */
export class DailyQuota {
  private day = "";
  private used = 0;
  private loaded = false;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly limit: number,
    private readonly timeZone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }
  private async sync() {
    const today = localDay(this.now(), this.timeZone);
    if (!this.loaded) {
      this.loaded = true;
      try {
        const saved = JSON.parse(await readFile(this.file, "utf8")) as {
          day?: unknown;
          used?: unknown;
        };
        if (
          typeof saved.day === "string" &&
          Number.isSafeInteger(saved.used) &&
          (saved.used as number) >= 0
        ) {
          this.day = saved.day;
          this.used = saved.used as number;
        }
      } catch {
        // Missing or unreadable state starts a fresh counter.
      }
    }
    if (this.day !== today) {
      this.day = today;
      this.used = 0;
    }
  }
  private async persist() {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({ day: this.day, used: this.used }),
      { mode: 0o600 },
    );
    await rename(temporary, this.file);
  }
  /** Reserve one call; throws quota_exceeded when the daily limit is reached. */
  reserve(): Promise<() => Promise<void>> {
    return this.serial(async () => {
      await this.sync();
      if (this.used >= this.limit) throw new ToolError("quota_exceeded");
      this.used += 1;
      const day = this.day;
      await this.persist();
      let released = false;
      return () =>
        this.serial(async () => {
          if (released) return;
          released = true;
          await this.sync();
          if (this.day === day && this.used > 0) {
            this.used -= 1;
            await this.persist();
          }
        });
    });
  }
  snapshot() {
    return this.serial(async () => {
      await this.sync();
      return { day: this.day, used: this.used, limit: this.limit };
    });
  }
}
