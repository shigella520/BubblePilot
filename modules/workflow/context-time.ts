export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export function runtimeTimeZone(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(timeZone) ? timeZone : "UTC";
}

export function formatContextTimestamp(
  timestamp: string,
  timeZone: string,
): string {
  if (
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT(?:[+-]\d{2}:\d{2})? \[[^\]]+\]$/u.test(
      timestamp,
    ) &&
    timestamp.endsWith(`[${timeZone}]`)
  ) {
    return timestamp;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} ${part("timeZoneName")} [${timeZone}]`;
}
