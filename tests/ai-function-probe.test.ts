import { describe, expect, it, vi } from "vitest";
import { AiManagementService } from "../modules/ai/ai-management-service.js";
import { OpenAiCompatibleClient } from "../modules/ai/openai-compatible-client.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";

const validCall = {
  id: "probe-call",
  name: "capability_probe",
  arguments: '{"acknowledgement":"bubblepilot-probe"}',
};

describe.each(["responses", "chat-completions"] as const)(
  "%s automatic function probe",
  (apiKind) => {
    it.each([
      {
        label: "native tool call",
        calls: [validCall],
        expected: "verified",
        code: null,
      },
      {
        label: "plain text only",
        calls: [],
        expected: "unknown",
        code: "AI_FUNCTION_PROBE_NOT_OBSERVED",
      },
      {
        label: "wrong function",
        calls: [{ ...validCall, name: "another_function" }],
        expected: "failed",
        code: "AI_FUNCTION_PROBE_MISMATCH",
      },
      {
        label: "malformed arguments",
        calls: [{ ...validCall, arguments: "{" }],
        expected: "failed",
        code: "AI_FUNCTION_PROBE_MISMATCH",
      },
      {
        label: "missing argument",
        calls: [{ ...validCall, arguments: "{}" }],
        expected: "failed",
        code: "AI_FUNCTION_PROBE_MISMATCH",
      },
      {
        label: "wrong argument",
        calls: [{ ...validCall, arguments: '{"acknowledgement":"wrong"}' }],
        expected: "failed",
        code: "AI_FUNCTION_PROBE_MISMATCH",
      },
      {
        label: "extra argument",
        calls: [
          {
            ...validCall,
            arguments: '{"acknowledgement":"bubblepilot-probe","extra":true}',
          },
        ],
        expected: "failed",
        code: "AI_FUNCTION_PROBE_MISMATCH",
      },
      {
        label: "array argument",
        calls: [{ ...validCall, arguments: "[]" }],
        expected: "failed",
        code: "AI_FUNCTION_PROBE_MISMATCH",
      },
      {
        label: "duplicate calls",
        calls: [validCall, { ...validCall, id: "second-call" }],
        expected: "failed",
        code: "AI_FUNCTION_PROBE_MISMATCH",
      },
      {
        label: "HTTP error",
        calls: [],
        expected: "failed",
        code: "AI_PROVIDER_HTTP_400",
        httpError: true,
      },
    ])(
      "validates $label without forcing thinking mode off",
      async ({ calls, expected, code, httpError }) => {
        const repository = new InMemoryAiRepository();
        const created = await repository.createProvider({
          name: "Fictional thinking provider",
          apiKind,
          baseUrl: "https://ai.example.test/v1",
          model: "fictional-thinking",
          secretRef: "FIXTURE_KEY",
          parameters: {},
          reasoningEffort: "high",
          requestTimeoutMs: 30000,
          enabled: true,
          capabilities: {
            functionCalling: true,
            hostedWebSearch: false,
            imageInput: false,
          },
        });
        if (created.status !== "ok") throw new Error("fixture failed");
        const response = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });
        // Deliberately include JSON in plain text: only the native channel counts.
        const text = JSON.stringify(validCall);
        const wireBody =
          apiKind === "responses"
            ? {
                output_text: text,
                output: calls.map((call) => ({
                  type: "function_call",
                  call_id: call.id,
                  name: call.name,
                  arguments: call.arguments,
                })),
              }
            : {
                choices: [
                  {
                    finish_reason: calls.length ? "tool_calls" : "stop",
                    message: {
                      role: "assistant",
                      content: text,
                      tool_calls: calls.map((call) => ({
                        id: call.id,
                        type: "function",
                        function: {
                          name: call.name,
                          arguments: call.arguments,
                        },
                      })),
                    },
                  },
                ],
              };
        const fetcher = vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            response(
              apiKind === "responses"
                ? { output_text: "OK" }
                : { choices: [{ message: { content: "OK" } }] },
            ),
          )
          .mockResolvedValueOnce(
            httpError
              ? response(
                  { error: { message: "Fictional protocol error" } },
                  400,
                )
              : response(wireBody),
          );
        const secrets = new EnvironmentSecretResolver({
          FIXTURE_KEY: "fictional-secret",
        });
        const service = new AiManagementService(
          repository,
          new OpenAiCompatibleClient(secrets, fetcher),
          secrets,
        );
        const result = await service.testProvider(created.value.id);
        expect(result?.checks[1]).toMatchObject({
          name: "functionCalling",
          status: expected,
          errorCode: code,
        });
        expect(
          (await repository.getProvider(created.value.id))?.capabilityProbe
            ?.functionCalling,
        ).toBe(expected);
        expect(fetcher).toHaveBeenCalledTimes(2);
        const body = fetcher.mock.calls[1]?.[1]?.body;
        expect(typeof body).toBe("string");
        const payload = JSON.parse(
          typeof body === "string" ? body : "null",
        ) as Record<string, unknown>;
        expect(payload.tool_choice).toBe("auto");
        expect(
          apiKind === "responses"
            ? payload.reasoning
            : payload.reasoning_effort,
        ).toEqual(apiKind === "responses" ? { effort: "high" } : "high");
        expect(JSON.stringify(payload)).toContain("bubblepilot-probe");
        expect(
          (await repository.getProvider(created.value.id))?.reasoningEffort,
        ).toBe("high");
        if (expected === "unknown")
          expect(result?.message).toContain("本次未观察到工具调用");
        const route = await repository.createRoute({
          name: "Fixture",
          providerIds: [created.value.id],
          enabled: true,
          fallbackEnabled: true,
          retryPolicy: { maxRounds: 1, initialDelayMs: 0 },
          degradePolicy: { failureThreshold: 3, cooldownMs: 60000 },
        });
        if (route.status !== "ok") throw new Error("fixture route failed");
        expect(
          await service.isRoutePublishable(route.value.id, "disabled", true),
        ).toBe(expected === "verified");
      },
    );
  },
);

it("publishes legacy required search with the same mixed-provider rules as auto", async () => {
  const repository = new InMemoryAiRepository();
  const providerIds: string[] = [];
  for (const searchable of [true, false]) {
    const provider = await repository.createProvider({
      name: searchable ? "Fictional search" : "Fictional text",
      apiKind: "responses",
      baseUrl: "https://ai.example.test/v1",
      model: "fictional",
      secretRef: "FIXTURE_KEY",
      parameters: {},
      requestTimeoutMs: 30000,
      enabled: true,
      capabilities: { functionCalling: false, hostedWebSearch: searchable },
    });
    if (provider.status !== "ok") throw new Error("fixture");
    providerIds.push(provider.value.id);
    await repository.updateProviderCapabilityProbe(provider.value.id, {
      functionCalling: "unknown",
      hostedWebSearch: searchable ? "verified" : "unknown",
      checkedAt: new Date(0).toISOString(),
    });
  }
  const route = await repository.createRoute({
    name: "Fixture mixed route",
    providerIds,
    enabled: true,
    fallbackEnabled: true,
    retryPolicy: { maxRounds: 1, initialDelayMs: 0 },
    degradePolicy: { failureThreshold: 3, cooldownMs: 60000 },
  });
  if (route.status !== "ok") throw new Error("fixture");
  const secrets = new EnvironmentSecretResolver({
    FIXTURE_KEY: "fictional-secret",
  });
  const fetcher = vi.fn<typeof fetch>();
  const service = new AiManagementService(
    repository,
    new OpenAiCompatibleClient(secrets, fetcher),
    secrets,
  );
  for (const policy of ["auto", "required"] as const)
    expect(await service.isRoutePublishable(route.value.id, policy)).toBe(true);
  await repository.updateProviderCapabilityProbe(providerIds[0]!, {
    functionCalling: "unknown",
    hostedWebSearch: "unknown",
    checkedAt: new Date(0).toISOString(),
  });
  for (const policy of ["auto", "required"] as const)
    expect(await service.isRoutePublishable(route.value.id, policy)).toBe(
      false,
    );
  expect(fetcher).not.toHaveBeenCalled();
});
