import type { AiProviderRecord } from "./ai-types.js";

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
  provider: Pick<AiProviderRecord, "secret" | "secretRef">,
  resolver: SecretResolver,
): boolean {
  return resolveProviderSecret(provider, resolver) !== null;
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
