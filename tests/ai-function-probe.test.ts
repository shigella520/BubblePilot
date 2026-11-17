import type { AiChatRequest } from "../modules/ai/ai-types.js";
import type { AiClient } from "../modules/ai/openai-compatible-client.js";
import { describe, expect, it, vi } from "vitest";
import { AiManagementService } from "../modules/ai/ai-management-service.js";
import { OpenAiCompatibleClient } from "../modules/ai/openai-compatible-client.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";

const validCall = {
  id: "probe-call",
  name: "capability_probe",
  arguments: '{"acknowledgement":"bubblepilot-probe","note":null}',
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
          )
          .mockImplementationOnce((_url, init) => {
            const body = JSON.parse(
              typeof init?.body === "string" ? init.body : "{}",
            ) as {
              input?: Array<{
                type: string;
                call_id?: string;
                output?: string;
                arguments?: string;
              }>;
              messages?: Array<{
                role: string;
                content: string;
                tool_call_id?: string;
                tool_calls?: unknown[];
              }>;
              tools?: unknown;
            };
            expect(body.tools).toBeUndefined();
            const output =
              apiKind === "responses"
                ? body.input?.find(
                    (item) => item.type === "function_call_output",
                  )?.output
                : body.messages?.find((item) => item.role === "tool")?.content;
            if (!output) throw new Error("Missing tool result");
            if (apiKind === "responses") {
              expect(body.input).toContainEqual({
                type: "function_call",
                call_id: validCall.id,
                name: validCall.name,
                arguments: validCall.arguments,
              });
              expect(
                body.input?.find((item) => item.type === "function_call_output")
                  ?.call_id,
              ).toBe(validCall.id);
            } else {
              expect(
                body.messages?.find((item) => item.role === "assistant")
                  ?.tool_calls,
              ).toEqual([
                {
                  id: validCall.id,
                  type: "function",
                  function: {
                    name: validCall.name,
                    arguments: validCall.arguments,
                  },
                },
              ]);
              expect(
                body.messages?.find((item) => item.role === "tool")
                  ?.tool_call_id,
              ).toBe(validCall.id);
            }
            const receipt = (JSON.parse(output) as { receipt: string }).receipt;
            return Promise.resolve(
              response(
                apiKind === "responses"
                  ? { output_text: receipt }
                  : { choices: [{ message: { content: receipt } }] },
              ),
            );
          });
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
        expect(fetcher).toHaveBeenCalledTimes(expected === "verified" ? 3 : 2);
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

describe("function probe round-trip boundaries", () => {
  async function setup(
    sessionAffinity: "disabled" | "session-id-header" = "session-id-header",
  ) {
    const repository = new InMemoryAiRepository();
    const created = await repository.createProvider({
      name: "Fictional closure",
      apiKind: "responses",
      baseUrl: "https://ai.example.test/v1",
      model: "fictional",
      secretRef: "FIXTURE_KEY",
      parameters: {},
      requestTimeoutMs: 1000,
      enabled: true,
      sessionAffinity,
      capabilities: {
        functionCalling: true,
        hostedWebSearch: false,
        imageInput: false,
      },
    });
    if (created.status !== "ok") throw new Error("fixture");
    return {
      repository,
      provider: created.value,
      secrets: new EnvironmentSecretResolver({ FIXTURE_KEY: "fictional" }),
    };
  }

  it.each(["disabled", "session-id-header"] as const)(
    "isolates successive tests with affinity %s and pairs the two tool rounds",
    async (sessionAffinity) => {
      const { repository, provider, secrets } = await setup(sessionAffinity);
      const requests: AiChatRequest[] = [];
      const client: AiClient = {
        call(_provider, request) {
          requests.push(structuredClone(request));
          const output = request.messages.find((m) => m.role === "tool");
          if (output && typeof output.content === "string") {
            expect(request.tools).toBeUndefined();
            const receipt = (JSON.parse(output.content) as { receipt: string })
              .receipt;
            expect(JSON.stringify(requests.at(-2)?.messages)).not.toContain(
              receipt,
            );
            return Promise.resolve({
              status: "succeeded",
              text: receipt,
              durationMs: 7,
            });
          }
          return Promise.resolve(
            request.tools
              ? {
                  status: "succeeded",
                  text: "",
                  toolCalls: [validCall],
                  durationMs: 5,
                }
              : { status: "succeeded", text: "OK", durationMs: 3 },
          );
        },
      };
      const service = new AiManagementService(repository, client, secrets);
      for (let i = 0; i < 2; i++) {
        const result = await service.testProvider(provider.id);
        expect(result?.checks[1]).toMatchObject({
          status: "verified",
          attempts: 2,
          durationMs: 12,
        });
        expect(result?.durationMs).toBe(15);
      }
      expect(requests).toHaveLength(6);
      expect(requests[1]?.messages).not.toEqual(requests[4]?.messages);
      expect(requests[0]?.messages).not.toEqual(requests[3]?.messages);
      expect(new Set(requests.map((r) => r.clientRequestId)).size).toBe(6);
      if (sessionAffinity === "session-id-header") {
        expect(requests[1]?.sessionId).toMatch(/^[a-f0-9]{64}$/);
        expect(requests[1]?.sessionId).toBe(requests[2]?.sessionId);
        expect(requests[4]?.sessionId).toBe(requests[5]?.sessionId);
        expect(requests[1]?.sessionId).not.toBe(requests[4]?.sessionId);
        expect(requests[0]?.sessionId).not.toBe(requests[1]?.sessionId);
      } else
        expect(requests.every((r) => r.sessionId === undefined)).toBe(true);
    },
  );

  it.each(["wrong-receipt", "extra-call", "http409", "timeout"] as const)(
    "never verifies or retries a %s closing response",
    async (outcome) => {
      const { repository, provider, secrets } = await setup();
      let calls = 0;
      const client: AiClient = {
        call(_provider, request) {
          calls++;
          if (calls === 1)
            return Promise.resolve({
              status: "succeeded",
              text: "OK",
              durationMs: 2,
            });
          if (calls === 2)
            return Promise.resolve({
              status: "succeeded",
              text: "",
              toolCalls: [validCall],
              durationMs: 3,
            });
          expect(request.messages.at(-1)).toMatchObject({
            role: "tool",
            toolCallId: validCall.id,
          });
          if (outcome === "http409" || outcome === "timeout")
            return Promise.resolve({
              status: "failed",
              code:
                outcome === "http409"
                  ? "AI_PROVIDER_HTTP_409"
                  : "AI_PROVIDER_TIMEOUT",
              category: outcome === "http409" ? "model" : "timeout",
              summary: "Fictional failure",
              retryable: true,
              fallbackAllowed: true,
              countsForDegrade: false,
              durationMs: 11,
            });
          return Promise.resolve({
            status: "succeeded",
            text: "OK",
            durationMs: 11,
            ...(outcome === "extra-call" ? { toolCalls: [validCall] } : {}),
          });
        },
      };
      const result = await new AiManagementService(
        repository,
        client,
        secrets,
      ).testProvider(provider.id);
      expect(calls).toBe(3);
      expect(result?.checks[1]).toMatchObject({
        status: "failed",
        attempts: 2,
        durationMs: 14,
        errorCode:
          outcome === "http409"
            ? "AI_PROVIDER_HTTP_409"
            : outcome === "timeout"
              ? "AI_PROVIDER_TIMEOUT"
              : "AI_FUNCTION_PROBE_ROUNDTRIP_MISMATCH",
      });
      expect(
        (await repository.getProvider(provider.id))?.capabilityProbe
          ?.functionCalling,
      ).toBe("failed");
    },
  );

  it("does not retry an initial 409 or send a fabricated tool result", async () => {
    const { repository, provider, secrets } = await setup();
    let calls = 0;
    const client: AiClient = {
      call() {
        calls++;
        return Promise.resolve(
          calls === 1
            ? { status: "succeeded", text: "OK", durationMs: 1 }
            : {
                status: "failed",
                code: "AI_PROVIDER_HTTP_409",
                category: "model",
                summary: "Fictional conflict",
                retryable: false,
                fallbackAllowed: false,
                countsForDegrade: false,
                durationMs: 2,
              },
        );
      },
    };
    const result = await new AiManagementService(
      repository,
      client,
      secrets,
    ).testProvider(provider.id);
    expect(calls).toBe(2);
    expect(result?.checks[1]).toMatchObject({
      status: "failed",
      attempts: 1,
      errorCode: "AI_PROVIDER_HTTP_409",
    });
  });
});
