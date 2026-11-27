/**
 * Shared display formatting. Fixed zh-CN, 24-hour clock, independent of the
 * browser locale, so timestamps read the same on every page and device.
 */
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const timeOnly = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const dateOnly = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function toDate(value: string | number | Date | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parts(format: Intl.DateTimeFormat, date: Date) {
  const map: Record<string, string> = {};
  for (const part of format.formatToParts(date)) map[part.type] = part.value;
  return map;
}

/** 2026-11-27 11:22:38 (local time). Empty/invalid input renders as —. */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  fallback = "—",
): string {
  const date = toDate(value);
  if (!date) return fallback;
  const p = parts(dateTime, date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** 11:22:38 (local time). */
export function formatTime(
  value: string | number | Date | null | undefined,
  fallback = "—",
): string {
  const date = toDate(value);
  if (!date) return fallback;
  const p = parts(timeOnly, date);
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** 2026-11-27 (local date). */
export function formatDate(
  value: string | number | Date | null | undefined,
  fallback = "—",
): string {
  const date = toDate(value);
  if (!date) return fallback;
  const p = parts(dateOnly, date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 1.4 MB, 820 KB, 12 B (binary units). */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  const units = ["B", "KB", "MB", "GB"];
  let size = Math.max(0, value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || size >= 100 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

/** 850 毫秒, 12.3 秒, 4 分 05 秒. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const value = Math.max(0, ms);
  if (value < 1000) return `${Math.round(value)} 毫秒`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes} 分 ${String(seconds).padStart(2, "0")} 秒`;
}
