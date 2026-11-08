import { Temporal } from "@js-temporal/polyfill";
import { dayBounds, type ChatCountQuery } from "./chat-query-types.js";

export const countPageCharacters = 12_000;
export const countGroupLimit = 10_000;
export interface CountBucket {
  key: string;
  value: string | number;
  start?: string;
  end?: string;
  partialBucket?: boolean;
}

/** Calendar boundaries are server-owned. Repeated hours have distinct instants/offsets. */
export function countBuckets(
  query: ChatCountQuery,
  zone: string,
): CountBucket[] {
  if (query.groupBy === "none" || query.groupBy === "sender") return [];
  const [first, last] = dayBounds(query, zone);
  if (query.groupBy === "hourOfDay" || query.groupBy === "weekday") {
    return Array.from(
      { length: query.groupBy === "weekday" ? 7 : 24 },
      (_, i) => {
        const value = i + (query.groupBy === "weekday" ? 1 : 0);
        return { key: String(value).padStart(2, "0"), value };
      },
    );
  }
  const from = Temporal.Instant.from(query.from!);
  const to = Temporal.Instant.from(query.to!);
  const starts = new Map<string, Temporal.ZonedDateTime>();
  const remember = (z: Temporal.ZonedDateTime) =>
    starts.set(z.toInstant().toString(), z);
  const localFirst = Temporal.PlainDate.from(first);
  const localLast = Temporal.PlainDate.from(last);
  if (query.groupBy === "hour") {
    for (
      let date = localFirst;
      Temporal.PlainDate.compare(date, localLast) <= 0;
      date = date.add({ days: 1 })
    ) {
      remember(date.toZonedDateTime(zone).startOfDay());
      for (let hour = 0; hour < 24; hour++) {
        const plain = date.toPlainDateTime({ hour });
        for (const disambiguation of ["earlier", "later"] as const) {
          const z = plain.toZonedDateTime(zone, { disambiguation });
          if (z.toPlainDateTime().equals(plain)) remember(z);
        }
        // A half-hour forward transition may begin a shortened clock-hour bucket.
        const compatible = plain.toZonedDateTime(zone);
        if (compatible.hour === hour && compatible.toPlainDate().equals(date))
          remember(compatible);
      }
    }
    const stop = localLast.add({ days: 1 }).toZonedDateTime(zone).startOfDay();
    remember(stop);
    // Non-hour transitions (e.g. Lord Howe's repeated 01:30) also split bins.
    let transition = localFirst
      .toZonedDateTime(zone)
      .startOfDay()
      .getTimeZoneTransition("next");
    while (transition && Temporal.ZonedDateTime.compare(transition, stop) < 0) {
      remember(transition);
      transition = transition.getTimeZoneTransition("next");
    }
  } else {
    let date =
      query.groupBy === "week"
        ? localFirst.subtract({ days: localFirst.dayOfWeek - 1 })
        : query.groupBy === "month"
          ? localFirst.with({ day: 1 })
          : localFirst;
    const step =
      query.groupBy === "week"
        ? { weeks: 1 }
        : query.groupBy === "month"
          ? { months: 1 }
          : { days: 1 };
    while (Temporal.PlainDate.compare(date, localLast) <= 0) {
      remember(date.toZonedDateTime(zone).startOfDay());
      date = date.add(step);
    }
    remember(date.toZonedDateTime(zone).startOfDay());
  }
  const boundaries = [...starts.values()].sort((a, b) =>
    Temporal.ZonedDateTime.compare(a, b),
  );
  return boundaries.slice(0, -1).flatMap((z, i) => {
    const end = boundaries[i + 1]!;
    if (
      Temporal.Instant.compare(end.toInstant(), from) <= 0 ||
      Temporal.Instant.compare(z.toInstant(), to) > 0
    )
      return [];
    const key =
      query.groupBy === "hour"
        ? z.toInstant().toString({ fractionalSecondDigits: 6 })
        : query.groupBy === "month"
          ? z.toPlainDate().toString().slice(0, 7)
          : z.toPlainDate().toString();
    return [
      {
        key,
        value:
          query.groupBy === "hour"
            ? z.toString({ timeZoneName: "never", smallestUnit: "second" })
            : key,
        start: z.toString({ timeZoneName: "never", smallestUnit: "second" }),
        end: end.toString({ timeZoneName: "never", smallestUnit: "second" }),
        partialBucket:
          Temporal.Instant.compare(from, z.toInstant()) > 0 ||
          to.epochNanoseconds < end.epochNanoseconds - 1_000n,
      },
    ];
  });
}
