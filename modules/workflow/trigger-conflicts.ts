import type { TriggerConditions } from "./trigger-matcher.js";

export interface ConflictCandidate {
  id: string;
  enabled: boolean;
  conditions: TriggerConditions;
}

function listsCouldOverlap<T>(
  left: readonly T[],
  right: readonly T[],
): boolean {
  return (
    left.length === 0 ||
    right.length === 0 ||
    left.some((value) => right.includes(value))
  );
}

function textCouldOverlap(
  left: TriggerConditions["text"],
  right: TriggerConditions["text"],
): boolean {
  if (left === null || right === null) return true;
  if (left.kind !== "prefix" || right.kind !== "prefix") return true;
  const caseSensitive = left.caseSensitive && right.caseSensitive;
  const leftValue = caseSensitive
    ? left.value
    : left.value.toLocaleLowerCase("en-US");
  const rightValue = caseSensitive
    ? right.value
    : right.value.toLocaleLowerCase("en-US");
  return leftValue.startsWith(rightValue) || rightValue.startsWith(leftValue);
}

function minuteOfDay(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function weeklyIntervals(
  window: NonNullable<TriggerConditions["timeWindow"]>,
): Array<readonly [number, number]> {
  const weekdays = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ] as const;
  const start = minuteOfDay(window.start);
  const end = minuteOfDay(window.end);
  const intervals: Array<readonly [number, number]> = [];
  for (const day of window.daysOfWeek) {
    const dayIndex = weekdays.indexOf(day);
    const dayStart = dayIndex * 1_440;
    if (start < end) {
      intervals.push([dayStart + start, dayStart + end]);
      continue;
    }
    intervals.push([dayStart + start, dayStart + 1_440]);
    const nextDayStart = ((dayIndex + 1) % weekdays.length) * 1_440;
    intervals.push([nextDayStart, nextDayStart + end]);
  }
  return intervals;
}

function timeWindowsCouldOverlap(
  left: TriggerConditions["timeWindow"],
  right: TriggerConditions["timeWindow"],
): boolean {
  if (left === null || right === null) return true;
  if (left.timeZone !== right.timeZone) return true;
  const leftIntervals = weeklyIntervals(left);
  const rightIntervals = weeklyIntervals(right);
  return leftIntervals.some(([leftStart, leftEnd]) =>
    rightIntervals.some(
      ([rightStart, rightEnd]) => leftStart < rightEnd && rightStart < leftEnd,
    ),
  );
}

export function triggersCouldOverlap(
  left: ConflictCandidate,
  right: ConflictCandidate,
): boolean {
  return (
    left.enabled &&
    right.enabled &&
    listsCouldOverlap(left.conditions.chatIds, right.conditions.chatIds) &&
    listsCouldOverlap(left.conditions.senderIds, right.conditions.senderIds) &&
    listsCouldOverlap(
      left.conditions.contentTypes,
      right.conditions.contentTypes,
    ) &&
    textCouldOverlap(left.conditions.text, right.conditions.text) &&
    timeWindowsCouldOverlap(
      left.conditions.timeWindow,
      right.conditions.timeWindow,
    )
  );
}

export function findPotentialTriggerConflicts(
  triggers: readonly ConflictCandidate[],
): ReadonlyMap<string, readonly string[]> {
  const conflicts = new Map<string, string[]>();
  for (const trigger of triggers) conflicts.set(trigger.id, []);
  for (let leftIndex = 0; leftIndex < triggers.length; leftIndex += 1) {
    const left = triggers[leftIndex];
    if (left === undefined) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < triggers.length;
      rightIndex += 1
    ) {
      const right = triggers[rightIndex];
      if (right === undefined || !triggersCouldOverlap(left, right)) continue;
      conflicts.get(left.id)?.push(right.id);
      conflicts.get(right.id)?.push(left.id);
    }
  }
  return conflicts;
}
