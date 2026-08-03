import { describe, expect, it, vi } from "vitest";

import { OpenAiCompatibleClient } from "../modules/ai/openai-compatible-client.js";
import type { AiProviderRecord } from "../modules/ai/ai-types.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";

const provider: AiProviderRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Fictional AI",
  apiKind: "chat-completions",
  baseUrl: "https://ai.example.test/v1/",
  model: "fictional-model",
  secretRef: "FICTIONAL_AI_KEY",
  parameters: { top_p: 0.9 },
  requestTimeoutMs: 5_000,
  enabled: true,
  sortOrder: 100,
  version: 1,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const request = {
  messages: [
    { role: "system" as const, content: "Be concise." },
    { role: "user" as const, content: "Fictional question" },
  ],
  maxOutputTokens: 128,
  temperature: 0.2,
  timeoutMs: 5_000,
};

describe("OpenAiCompatibleClient", () => {
  it("rejects missing and placeholder server secrets before network access", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "CHANGE_ME_AI_KEY" }),
      fetchImplementation,
    );
    await expect(client.call(provider, request)).resolves.toMatchObject({
      status: "failed",
      code: "AI_PROVIDER_SECRET_NOT_CONFIGURED",
      fallbackAllowed: true,
      countsForDegrade: false,
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("sends Chat Completions without exposing the secret in the result", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "Answer" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "server-secret" }),
      fetchImplementation,
    );

    await expect(client.call(provider, request)).resolves.toMatchObject({
      status: "succeeded",
      text: "Answer",
    });
    const [url, options] = fetchImplementation.mock.calls[0] ?? [];
    const urlText =
      url instanceof URL
        ? url.toString()
        : typeof url === "string"
          ? url
          : url?.url;
    expect(urlText).toBe("https://ai.example.test/v1/chat/completions");
    expect(options?.headers).toMatchObject({
      authorization: "Bearer server-secret",
      "content-type": "application/json",
    });
    const payload = JSON.parse(
      typeof options?.body === "string" ? options.body : "null",
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      model: "fictional-model",
      stream: false,
      messages: request.messages,
      max_tokens: 128,
      temperature: 0.2,
      top_p: 0.9,
    });
  });

  it("uses the Responses contract and extracts nested output text", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ content: [{ type: "output_text", text: "Response" }] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "server-secret" }),
      fetchImplementation,
    );

    await expect(
      client.call({ ...provider, apiKind: "responses" }, request),
    ).resolves.toMatchObject({ status: "succeeded", text: "Response" });
    const body = fetchImplementation.mock.calls[0]?.[1]?.body;
    const payload = JSON.parse(
      typeof body === "string" ? body : "null",
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      input: request.messages,
      max_output_tokens: 128,
    });
  });

  it("classifies safe error categories without returning provider bodies", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { type: "server_error", message: "contains server-secret" },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({ FICTIONAL_AI_KEY: "server-secret" }),
      fetchImplementation,
    );
    const result = await client.call(provider, request);
    expect(result).toMatchObject({
      status: "failed",
      code: "AI_PROVIDER_HTTP_503",
      retryable: true,
      fallbackAllowed: true,
      countsForDegrade: true,
    });
    expect(JSON.stringify(result)).not.toContain("server-secret");
  });
});
