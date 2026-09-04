import type { SummarySettingsRepository } from "./summary-settings-repository.js";
import type {
  SummaryRuntimeSettings,
  SummarySettingsUpdate,
  SummarySettingsView,
} from "./summary-settings-types.js";

export class SummarySettingsService {
  constructor(
    readonly repository: SummarySettingsRepository,
    private readonly fallback: SummaryRuntimeSettings,
  ) {}
  async view(): Promise<SummarySettingsView> {
    const value = await this.repository.find();
    return value === null
      ? {
          ...this.fallback,
          source: "defaults",
          version: 0,
          policyVersion: 1,
          updatedAt: null,
        }
      : { ...value, source: "database" };
  }
  async resolve(): Promise<SummaryRuntimeSettings> {
    const value = await this.repository.find();
    return value === null ? this.fallback : value;
  }
  async update(input: SummarySettingsUpdate) {
    const result = await this.repository.save(input);
    return result.status === "conflict"
      ? result
      : {
          status: "ok" as const,
          value: { ...result.value, source: "database" as const },
        };
  }
}
