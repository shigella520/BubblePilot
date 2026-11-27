import { expect, it, vi } from "vitest";
import { ToolError } from "../src/errors.js";
import { endpoint, imagesClient, NotSentError } from "../src/upstream.js";
import { solid } from "./support.js";

const ok = async () =>
  new Response(
    JSON.stringify({
      data: [{ b64_json: (await solid("png")).toString("base64") }],
      usage: { input_tokens: 19, output_tokens: 196 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const failure = (status: number, error: Record<string, unknown>) =>
  new Response(JSON.stringify({ error }), { status });
const options = (
  fetch: typeof globalThis.fetch,
  editField: "auto" | "image" | "image[]" = "auto",
) =>
  imagesClient({
    baseUrl: "https://images.example.test",
    apiKey: "fictional-upstream-key-000000000000",
    model: "gpt-image-2",
    timeoutMs: 2000,
    editField,
    fetch,
  });
const signal = () => new AbortController().signal;
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof ToolError ? error.message : "other"),
  );

it("joins the versioned endpoint without duplicating /v1", () => {
  expect(endpoint("https://a.test", "/images/edits").href).toBe(
    "https://a.test/v1/images/edits",
  );
  expect(endpoint("https://a.test/v1/", "/images/edits").href).toBe(
    "https://a.test/v1/images/edits",
  );
  expect(endpoint("https://a.test/proxy", "/images/generations").href).toBe(
    "https://a.test/proxy/v1/images/generations",
  );
});

it("sends a JSON generation request with model, size, quality and n=1", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(ok);
  const result = await options(fetch).generate(
    { prompt: "a boat", size: "1024x1024", quality: "low" },
    signal(),
  );
  expect(result.usage).toEqual({ inputTokens: 19, outputTokens: 196 });
  const [url, init] = fetch.mock.calls[0]!;
  expect((url as URL).href).toBe(
    "https://images.example.test/v1/images/generations",
  );
  expect(init?.redirect).toBe("error");
  expect((init?.headers as Record<string, string>).authorization).toBe(
    "Bearer fictional-upstream-key-000000000000",
  );
  expect(JSON.parse(init?.body as string)).toEqual({
    model: "gpt-image-2",
    prompt: "a boat",
    size: "1024x1024",
    quality: "low",
    n: 1,
  });
});

it("uploads edit inputs as image for one file and image[] for several", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(ok);
  const png = await solid("png");
  const jpeg = await solid("jpeg");
  const client = options(fetch);
  await client.edit(
    {
      prompt: "edit",
      size: "1024x1024",
      quality: "low",
      images: [{ data: png, mime: "image/png", filename: "input-1.png" }],
    },
    signal(),
  );
  await client.edit(
    {
      prompt: "edit",
      size: "auto",
      quality: "medium",
      images: [
        { data: png, mime: "image/png", filename: "input-1.png" },
        { data: jpeg, mime: "image/jpeg", filename: "input-2.jpg" },
      ],
    },
    signal(),
  );
  const single = fetch.mock.calls[0]![1]!.body as FormData;
  expect(single.getAll("image")).toHaveLength(1);
  expect(single.get("model")).toBe("gpt-image-2");
  expect((single.get("image") as File).type).toBe("image/png");
  const multiple = fetch.mock.calls[1]![1]!.body as FormData;
  expect(multiple.getAll("image[]")).toHaveLength(2);
  expect(multiple.getAll("image")).toHaveLength(0);
  expect((multiple.getAll("image[]")[1] as File).name).toBe("input-2.jpg");
  await options(fetch, "image").edit(
    {
      prompt: "edit",
      size: "auto",
      quality: "medium",
      images: [
        { data: png, mime: "image/png", filename: "input-1.png" },
        { data: jpeg, mime: "image/jpeg", filename: "input-2.jpg" },
      ],
    },
    signal(),
  );
  expect(
    (fetch.mock.calls[2]![1]!.body as FormData).getAll("image"),
  ).toHaveLength(2);
});

it("maps upstream errors to fixed codes without leaking upstream text", async () => {
  const cases: [Response, string][] = [
    [
      failure(400, {
        code: "moderation_blocked",
        message: "secret upstream detail",
      }),
      "content_rejected",
    ],
    [
      failure(400, {
        type: "image_generation_user_error",
        code: "content_policy_violation",
      }),
      "content_rejected",
    ],
    [
      failure(400, {
        code: "unsupported_file_mimetype",
        message: "image/heic",
      }),
      "input_type_unsupported",
    ],
    [failure(400, { code: "invalid_value" }), "invalid_arguments"],
    [failure(401, { code: "invalid_api_key" }), "upstream_unavailable"],
    [failure(429, { code: "rate_limit" }), "upstream_unavailable"],
    [failure(502, { code: "bad_gateway" }), "upstream_unavailable"],
    [new Response('{"data":[]}', { status: 200 }), "upstream_unavailable"],
    [new Response("not json", { status: 200 }), "upstream_unavailable"],
  ];
  for (const [response, expected] of cases) {
    const client = options(
      vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response)),
    );
    expect(
      await code(
        client.generate(
          { prompt: "x", size: "auto", quality: "auto" },
          signal(),
        ),
      ),
    ).toBe(expected);
  }
});

it("retries once only when the connection provably never opened", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ECONNREFUSED" },
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(refused)
    .mockImplementationOnce(ok);
  await options(fetch).generate(
    { prompt: "x", size: "auto", quality: "auto" },
    signal(),
  );
  expect(fetch).toHaveBeenCalledTimes(2);

  const twice = vi.fn<typeof globalThis.fetch>().mockRejectedValue(refused);
  const error = await options(twice)
    .generate({ prompt: "x", size: "auto", quality: "auto" }, signal())
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(NotSentError);
  expect(twice).toHaveBeenCalledTimes(2);
});

it("never replays after a possibly delivered request or a timeout", async () => {
  const reset = Object.assign(new TypeError("fetch failed"), {
    cause: { code: "ECONNRESET" },
  });
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(reset);
  const error = await options(fetch)
    .generate({ prompt: "x", size: "auto", quality: "auto" }, signal())
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ToolError);
  expect(error).not.toBeInstanceOf(NotSentError);
  expect((error as Error).message).toBe("upstream_unavailable");
  expect(fetch).toHaveBeenCalledTimes(1);

  const slow = vi.fn<typeof globalThis.fetch>(
    (_url, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("timeout", "TimeoutError")),
        ),
      ),
  );
  const client = imagesClient({
    baseUrl: "https://images.example.test",
    apiKey: "fictional-upstream-key-000000000000",
    model: "gpt-image-2",
    timeoutMs: 20,
    editField: "auto",
    fetch: slow,
  });
  expect(
    await code(
      client.generate({ prompt: "x", size: "auto", quality: "auto" }, signal()),
    ),
  ).toBe("upstream_timeout");
  expect(slow).toHaveBeenCalledTimes(1);
});
