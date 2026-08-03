export interface ExpiringSession {
  expiresAt: string;
  sensitiveUntil: string | null;
}

export interface SessionTimeState {
  authenticated: boolean;
  sensitiveActive: boolean;
}

export function sessionTimeState(
  session: ExpiringSession | null,
  observedAt: number,
): SessionTimeState {
  const authenticated =
    session !== null && Date.parse(session.expiresAt) > observedAt;
  return {
    authenticated,
    sensitiveActive:
      authenticated &&
      session?.sensitiveUntil !== null &&
      Date.parse(session?.sensitiveUntil ?? "") > observedAt,
  };
}

export function nextSessionDeadline(
  session: ExpiringSession | null,
  observedAt: number,
): number | null {
  if (session === null) return null;
  const deadlines = [
    Date.parse(session.expiresAt),
    Date.parse(session.sensitiveUntil ?? ""),
  ].filter((deadline) => Number.isFinite(deadline) && deadline > observedAt);
  const nextDeadline = Math.min(...deadlines);
  return Number.isFinite(nextDeadline) ? nextDeadline : null;
}
