export interface SecretResolver {
  resolve(secretRef: string): string | null;
  isConfigured(secretRef: string): boolean;
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
