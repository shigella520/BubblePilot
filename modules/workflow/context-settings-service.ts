import type { ContextSettingsRepository } from "./context-settings-repository.js";
import type {
  ContextRuntimeSettings,
  ContextSettingsUpdate,
  ContextSettingsView,
} from "./context-settings-types.js";

export class ContextSettingsService {
  constructor(
    readonly repository: ContextSettingsRepository,
    private readonly fallback: ContextRuntimeSettings,
  ) {}
  async view(): Promise<ContextSettingsView> {
    const value = await this.repository.find();
    return value === null
      ? {
          ...this.fallback,
          source: "defaults",
          version: 0,
          updatedAt: null,
        }
      : { ...value, source: "database" };
  }
  async resolve(): Promise<ContextRuntimeSettings> {
    const value = await this.repository.find();
    return value === null ? this.fallback : value;
  }
  async update(input: ContextSettingsUpdate) {
    const result = await this.repository.save(input);
    return result.status === "conflict"
      ? result
      : {
          status: "ok" as const,
          value: { ...result.value, source: "database" as const },
        };
  }
}
