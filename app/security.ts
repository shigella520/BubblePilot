import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const passwordHashPattern =
  /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/u;
const defaultScryptParameters = { N: 16_384, r: 8, p: 1 } as const;
const passwordKeyLength = 64;

function derivePassword(
  password: string,
  salt: Buffer,
  keyLength: number,
  parameters: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      { ...parameters, maxmem: 64 * 1024 * 1024 },
      (error, derivedKey) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

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

export async function hashPassword(
  password: string,
  salt: Buffer = randomBytes(16),
): Promise<string> {
  const derived = await derivePassword(
    password,
    salt,
    passwordKeyLength,
    defaultScryptParameters,
  );
  return [
    "scrypt",
    defaultScryptParameters.N,
    defaultScryptParameters.r,
    defaultScryptParameters.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const match = passwordHashPattern.exec(encodedHash);
  if (match === null) {
    return false;
  }
  const [, encodedN, encodedR, encodedP, encodedSalt, encodedKey] = match;
  const N = Number(encodedN);
  const r = Number(encodedR);
  const p = Number(encodedP);
  if (
    N !== defaultScryptParameters.N ||
    r !== defaultScryptParameters.r ||
    p !== defaultScryptParameters.p ||
    encodedSalt === undefined ||
    encodedKey === undefined
  ) {
    return false;
  }
  try {
    const salt = Buffer.from(encodedSalt, "base64url");
    const expected = Buffer.from(encodedKey, "base64url");
    if (salt.length < 16 || expected.length !== passwordKeyLength) {
      return false;
    }
    const candidate = await derivePassword(password, salt, expected.length, {
      N,
      r,
      p,
    });
    return timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}
