import { describe, expect, it } from "vitest";

import { aiProviderConfigurationSchema } from "../modules/ai/ai-types.js";

const provider = {
  name: "Fictional provider",
  apiKind: "responses" as const,
  baseUrl: "https://ai.example.test/v1",
  model: "fictional-model",
};

describe("AI provider configuration", () => {
  it("accepts the 360 second request timeout limit", () => {
    expect(
      aiProviderConfigurationSchema.safeParse({
        ...provider,
        requestTimeoutMs: 360_000,
      }).success,
    ).toBe(true);
  });

  it("rejects request timeouts above 360 seconds", () => {
    expect(
      aiProviderConfigurationSchema.safeParse({
        ...provider,
        requestTimeoutMs: 360_001,
      }).success,
    ).toBe(false);
  });

  it("accepts only supported session affinity modes", () => {
    expect(
      aiProviderConfigurationSchema.parse({
        ...provider,
        sessionAffinity: "session-id-header",
      }).sessionAffinity,
    ).toBe("session-id-header");
    expect(
      aiProviderConfigurationSchema.safeParse({
        ...provider,
        sessionAffinity: "x-client-request-id",
      }).success,
    ).toBe(false);
  });

  it("accepts supported reasoning efforts and defaults to provider behavior", () => {
    expect(aiProviderConfigurationSchema.parse(provider).reasoningEffort).toBe(
      "default",
    );
    expect(
      aiProviderConfigurationSchema.parse({
        ...provider,
        reasoningEffort: "xhigh",
      }).reasoningEffort,
    ).toBe("xhigh");
    expect(
      aiProviderConfigurationSchema.safeParse({
        ...provider,
        reasoningEffort: "ultra",
      }).success,
    ).toBe(false);
  });
});
