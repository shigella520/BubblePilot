import { timingSafeEqual } from "node:crypto";

export function secretsEqual(
  candidate: string | undefined,
  expected: string,
): boolean {
  if (candidate === undefined) {
    return false;
  }

  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  if (candidateBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(candidateBuffer, expectedBuffer);
}

export function readBearerToken(
  authorization: string | undefined,
): string | undefined {
  if (authorization === undefined) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1];
}
