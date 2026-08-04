import type { AiProviderRecord } from "./ai-types.js";

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const [first, second] = parts;
  return (
    first === 10 ||
    first === 127 ||
    (first === 192 && second === 168) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31)
  );
}

export interface SecretResolver {
  resolve(secretRef: string): string | null;
  isConfigured(secretRef: string): boolean;
}

export function resolveProviderSecret(
  provider: Pick<AiProviderRecord, "secret" | "secretRef">,
  resolver: SecretResolver,
): string | null {
  return provider.secret ?? resolver.resolve(provider.secretRef ?? "");
}

export function isProviderSecretConfigured(
  provider: Pick<AiProviderRecord, "secret" | "secretRef" | "baseUrl">,
  resolver: SecretResolver,
): boolean {
  if (resolveProviderSecret(provider, resolver) !== null) return true;
  try {
    const host = new URL(provider.baseUrl).hostname.toLowerCase();
    return (
      host === "ollama" ||
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      isPrivateIpv4(host) ||
      host.endsWith(".lan") ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

export class EnvironmentSecretResolver implements SecretResolver {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  resolve(secretRef: string): string | null {
    const value = this.environment[secretRef];
    return value === undefined ||
      value.trim().length === 0 ||
      value.startsWith("CHANGE_ME")
      ? null
      : value;
  }

  isConfigured(secretRef: string): boolean {
    return this.resolve(secretRef) !== null;
  }
}
