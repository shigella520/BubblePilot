/**
 * Model-facing timestamp in the chat timezone, e.g. 2026-11-17T00:00:00+08:00.
 *
 * Storage and APIs keep UTC instants; only prompt projections use this form so
 * a model reading the literal date sees the local calendar day. The value is
 * the same instant and is accepted by history tool `from`/`to` parameters.
 * Milliseconds are kept only when non-zero so boundary copies stay exact.
 */
export function localIsoTimestamp(
  value: string | Date,
  timeZone: string,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid timestamp");
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
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const zone = part("timeZoneName").replace(/^GMT/u, "");
  const offset = zone === "" ? "+00:00" : zone;
  const millis = date.getUTCMilliseconds();
  const fraction = millis === 0 ? "" : `.${String(millis).padStart(3, "0")}`;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}${fraction}${offset}`;
}

const legacyContextTimestamp =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) GMT([+-]\d{2}:\d{2})? \[[^\]]+\]$/u;

/**
 * The single model-facing timestamp form: ISO 8601 with the chat timezone
 * offset (see localIsoTimestamp). Accepts stored UTC instants and values
 * already rendered by formatContextTimestamp; unparseable input is returned
 * unchanged rather than failing prompt assembly.
 * formatContextTimestamp stays for human-facing text only.
 */
export function modelTimestamp(timestamp: string, timeZone: string): string {
  const legacy = legacyContextTimestamp.exec(timestamp);
  const instant = legacy
    ? `${legacy[1]}T${legacy[2]}${legacy[3] ?? "+00:00"}`
    : timestamp;
  try {
    return localIsoTimestamp(instant, timeZone);
  } catch {
    return timestamp;
  }
}
