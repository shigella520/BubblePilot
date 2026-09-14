export interface ProgressSample {
  at: number;
  milliseconds: number;
  characters: number;
  messages: number;
}
export function estimateProgress(
  samples: ProgressSample[],
  remainingCharacters: number,
  state: string,
  lastAt: number | null,
  current: boolean,
  now = Date.now(),
) {
  const unavailable = (status: string) => ({
    status,
    messagesPerMinute: null as number | null,
    remainingSeconds: null as number | null,
    estimatedCompletionAt: null as string | null,
  });
  if (!["running", "queued"].includes(state)) return unavailable(state);
  if (!current) return unavailable("waiting");
  if (lastAt !== null && now - lastAt >= 60_000) return unavailable("stalled");
  const recent = samples.slice(-10);
  const duration = recent.reduce((n, s) => n + s.milliseconds, 0);
  const chars = recent.reduce((n, s) => n + s.characters, 0);
  if (recent.length < 3 || duration < 15_000 || chars <= 0)
    return unavailable("warming");
  const seconds =
    Math.ceil(((remainingCharacters / chars) * duration) / 1000 / 60) * 60;
  return {
    status: "available",
    messagesPerMinute:
      (recent.reduce((n, s) => n + s.messages, 0) / duration) * 60_000,
    remainingSeconds: seconds,
    estimatedCompletionAt: new Date(now + seconds * 1000).toISOString(),
  };
}
