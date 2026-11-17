import { Ajv } from "ajv";
import { describe, expect, it, vi } from "vitest";
import {
  aiProviderConfigurationSchema,
  type AiProviderRecord,
  type AiToolDefinition,
} from "../modules/ai/ai-types.js";
import {
  compatibleToolParameters,
  strictToolParameters,
} from "../modules/ai/tool-schema.js";
import { OpenAiCompatibleClient } from "../modules/ai/openai-compatible-client.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import { allToolDefinitions } from "./support/tool-schema-fixtures.js";
import { memoryTools } from "../modules/memory/memory-service.js";
import { AiManagementService } from "../modules/ai/ai-management-service.js";
import { InMemoryAiRepository } from "./support/in-memory-ai-repository.js";

const provider: AiProviderRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Fictional",
  apiKind: "responses",
  baseUrl: "https://ai.example.test/v1",
  model: "fictional",
  secret: "fixture-secret",
  parameters: {},
  requestTimeoutMs: 5000,
  enabled: true,
  sortOrder: 100,
  version: 1,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};
type WireTool = AiToolDefinition & { strict: boolean; function?: WireTool };
type WirePayload = {
  tools: WireTool[];
  tool_choice: string;
  input?: unknown[];
  messages?: unknown[];
};
function payloadFrom(init?: RequestInit): WirePayload {
  if (typeof init?.body !== "string") throw new Error("Expected JSON body");
  return JSON.parse(init.body) as WirePayload;
}

const ajv = new Ajv({ strict: false, validateFormats: false });

function expectBusinessShape(
  original: Record<string, unknown>,
  wire: Record<string, unknown>,
) {
  if (original.properties) {
    expect(wire.required).toEqual(original.required ?? []);
    for (const [key, child] of Object.entries(original.properties))
      expectBusinessShape(
        child as Record<string, unknown>,
        (wire.properties as Record<string, Record<string, unknown>>)[key]!,
      );
  }
  if (original.anyOf) {
    const children = original.anyOf as Record<string, unknown>[];
    expect(wire.anyOf).toHaveLength(children.length);
    children.forEach((child, i) =>
      expectBusinessShape(child, (wire.anyOf as Record<string, unknown>[])[i]!),
    );
  } else expect(wire.type).toEqual(original.type);
  if (original.items)
    expectBusinessShape(
      original.items as Record<string, unknown>,
      wire.items as Record<string, unknown>,
    );
}

describe("provider tool parameter mode", () => {
  it("defaults old input to strict and rejects unsupported modes", () => {
    expect(aiProviderConfigurationSchema.parse(provider).toolSchemaMode).toBe(
      "strict",
    );
    expect(
      aiProviderConfigurationSchema.parse({
        ...provider,
        toolSchemaMode: "compatible",
      }).toolSchemaMode,
    ).toBe("compatible");
    expect(
      aiProviderConfigurationSchema.safeParse({
        ...provider,
        toolSchemaMode: "auto",
      }).success,
    ).toBe(false);
  });

  it("preserves optionality and business null semantics in every application tool", () => {
    for (const tool of allToolDefinitions()) {
      const before = structuredClone(tool);
      const schema = compatibleToolParameters(tool);
      expectBusinessShape(tool.parameters, schema);
      expect(() => ajv.compile(schema)).not.toThrow();
      expect(tool).toEqual(before);
      expect(tool.description).not.toMatch(
        /must be null|use null for|use null when/i,
      );
    }
  });

  it("keeps nested defaults, constraints and meaningful null distinct from optional placeholders", () => {
    const tool: AiToolDefinition = {
      name: "fixture",
      description: "Fixture",
      parameters: {
        type: "object",
        properties: {
          choice: {
            anyOf: [
              {
                type: "object",
                properties: {
                  kind: { type: "string", const: "once" },
                  enabled: { type: "boolean", default: true },
                },
                required: ["kind"],
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", const: "many" },
                  count: { type: "integer", minimum: 1 },
                },
                required: ["kind", "count"],
              },
            ],
          },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { value: { type: "number" } },
            },
          },
          clearable: { type: ["string", "null"] },
        },
        required: ["choice"],
      },
    };
    const validate = ajv.compile(compatibleToolParameters(tool));
    expect(
      validate({ choice: { kind: "once" }, items: [{}], clearable: null }),
    ).toBe(true);
    expect(validate({ choice: { kind: "once", enabled: false } })).toBe(true);
    expect(validate({ choice: { kind: "once", enabled: null } })).toBe(false);
    expect(validate({ choice: { kind: "many", count: 0 } })).toBe(false);
    expect(validate({ choice: { kind: "once", extra: true } })).toBe(false);
    expect(validate({})).toBe(false);
    expect(JSON.stringify(compatibleToolParameters(tool))).not.toContain(
      '"default"',
    );
  });

  describe.each(["responses", "chat-completions"] as const)("%s", (apiKind) => {
    it.each([undefined, "strict", "compatible"] as const)(
      "uses %s and retains exact call/result pairing",
      async (toolSchemaMode) => {
        const tools = allToolDefinitions();
        const compatible = toolSchemaMode === "compatible";
        const search = memoryTools.find(
          (t) => t.name === "search_chat_history",
        )!;
        const args = JSON.stringify(
          compatible
            ? { query: "青芽演示" }
            : {
                query: "青芽演示",
                limit: null,
                from: null,
                to: null,
                senderId: null,
                botWorkflowId: null,
              },
        );
        let turn = 0;
        const fetcher = vi
          .fn<typeof fetch>()
          .mockImplementation((_url, init) => {
            const payload = payloadFrom(init);
            for (const entry of payload.tools) {
              const wire = entry.function ?? entry;
              const original = tools.find((t) => t.name === wire.name)!;
              expect(wire.strict).toBe(!compatible);
              expect(wire.parameters).toEqual(
                compatible
                  ? compatibleToolParameters(original)
                  : strictToolParameters(original),
              );
              expect(wire.description).toContain(
                compatible ? "must be omitted" : "Use null",
              );
            }
            const wireSearch = payload.tools
              .map((t) => t.function ?? t)
              .find((t) => t.name === search.name)!;
            expect(ajv.compile(wireSearch.parameters)(JSON.parse(args))).toBe(
              true,
            );
            expect(payload.tool_choice).toBe("auto");
            turn++;
            if (turn === 1)
              return Promise.resolve(
                Response.json(
                  apiKind === "responses"
                    ? {
                        output: [
                          {
                            type: "function_call",
                            call_id: "fictional-call",
                            name: search.name,
                            arguments: args,
                          },
                        ],
                      }
                    : {
                        choices: [
                          {
                            message: {
                              content: null,
                              tool_calls: [
                                {
                                  id: "fictional-call",
                                  type: "function",
                                  function: {
                                    name: search.name,
                                    arguments: args,
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      },
                ),
              );
            if (apiKind === "responses") {
              expect(payload.input).toContainEqual({
                type: "function_call",
                call_id: "fictional-call",
                name: search.name,
                arguments: args,
              });
              expect(payload.input).toContainEqual({
                type: "function_call_output",
                call_id: "fictional-call",
                output: "周五三点",
              });
            } else {
              expect(payload.messages).toContainEqual(
                expect.objectContaining({
                  role: "assistant",
                  tool_calls: [
                    {
                      id: "fictional-call",
                      type: "function",
                      function: { name: search.name, arguments: args },
                    },
                  ],
                }),
              );
              expect(payload.messages).toContainEqual({
                role: "tool",
                tool_call_id: "fictional-call",
                content: "周五三点",
              });
            }
            return Promise.resolve(
              Response.json(
                apiKind === "responses"
                  ? { output_text: "周五三点" }
                  : { choices: [{ message: { content: "周五三点" } }] },
              ),
            );
          });
        const client = new OpenAiCompatibleClient(
          new EnvironmentSecretResolver({}),
          fetcher,
        );
        const config = {
          ...provider,
          apiKind,
          ...(toolSchemaMode ? { toolSchemaMode } : {}),
        };
        const initial = {
          messages: [{ role: "user" as const, content: "青芽项目何时演示？" }],
          tools,
          maxOutputTokens: 200,
          temperature: null,
        };
        const first = await client.call(config, initial);
        expect(first.status).toBe("succeeded");
        if (first.status !== "succeeded") return;
        const final = await client.call(config, {
          ...initial,
          messages: [
            ...initial.messages,
            {
              role: "assistant",
              content: first.text,
              toolCalls: first.toolCalls!,
            },
            { role: "tool", content: "周五三点", toolCallId: "fictional-call" },
          ],
        });
        expect(final).toMatchObject({ status: "succeeded", text: "周五三点" });
        expect(fetcher).toHaveBeenCalledTimes(2);
      },
    );

    it.each(["strict", "compatible"] as const)(
      "probes optional parameters using saved %s mode",
      async (toolSchemaMode) => {
        const repo = new InMemoryAiRepository();
        const created = await repo.createProvider({
          ...provider,
          apiKind,
          toolSchemaMode,
          capabilities: { functionCalling: true, hostedWebSearch: false },
        });
        if (created.status !== "ok") throw new Error("fixture");
        const fetcher = vi
          .fn<typeof fetch>()
          .mockImplementation((_url, init) => {
            const body = payloadFrom(init);
            if (!body.tools)
              return Promise.resolve(
                Response.json(
                  apiKind === "responses"
                    ? { output_text: "OK" }
                    : { choices: [{ message: { content: "OK" } }] },
                ),
              );
            const tool = body.tools[0]!.function ?? body.tools[0]!;
            expect(tool.strict).toBe(toolSchemaMode === "strict");
            expect(tool.parameters.required).toEqual(
              toolSchemaMode === "strict"
                ? ["acknowledgement", "note"]
                : ["acknowledgement"],
            );
            const args = JSON.stringify({
              acknowledgement: "bubblepilot-probe",
              ...(toolSchemaMode === "strict" ? { note: null } : {}),
            });
            return Promise.resolve(
              Response.json(
                apiKind === "responses"
                  ? {
                      output: [
                        {
                          type: "function_call",
                          call_id: "probe",
                          name: "capability_probe",
                          arguments: args,
                        },
                      ],
                    }
                  : {
                      choices: [
                        {
                          message: {
                            tool_calls: [
                              {
                                id: "probe",
                                type: "function",
                                function: {
                                  name: "capability_probe",
                                  arguments: args,
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
              ),
            );
          });
        const resolver = new EnvironmentSecretResolver({});
        const service = new AiManagementService(
          repo,
          new OpenAiCompatibleClient(resolver, fetcher),
          resolver,
        );
        const result = await service.testProvider(created.value.id);
        expect(
          result?.checks.find((check) => check.name === "functionCalling")
            ?.status,
        ).toBe("verified");
      },
    );
  });
});
