/** Development-only evaluation: fictional messages, no application database or gateway. */
import { execFileSync } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { AgentRunner } from "../modules/ai/agent-runner.js";
import { OpenAiCompatibleClient } from "../modules/ai/openai-compatible-client.js";
import { EnvironmentSecretResolver } from "../modules/ai/secret-resolver.js";
import type {
  AiProviderRecord,
  AiRouteRequest,
  AiRouteResult,
} from "../modules/ai/ai-types.js";
import type { AiRoutingService } from "../modules/ai/ai-routing-service.js";
import type { MemoryService } from "../modules/memory/memory-service.js";

const baseUrl = process.env.AGENT_EVAL_URL;
const model = process.env.AGENT_EVAL_MODEL;
if (!baseUrl || !model) {
  process.stderr.write(
    "Set AGENT_EVAL_URL and AGENT_EVAL_MODEL for a development model endpoint. Optional AGENT_EVAL_SECRET is read only from the environment. No model evaluation was run.\n",
  );
  process.exitCode = 2;
} else {
  const baselineRef =
    process.env.AGENT_EVAL_BASELINE_REF ??
    "b01790fb70c8065e02fa76a861f17a5025cc1669";
  if (!/^[a-f0-9]{7,40}$/u.test(baselineRef))
    throw new Error("Use a hexadecimal baseline commit ID.");
  const baselineFile = resolve(
    `modules/ai/.agent-eval-baseline-${process.pid}.ts`,
  );
  await writeFile(
    baselineFile,
    execFileSync("git", ["show", `${baselineRef}:modules/ai/agent-runner.ts`], {
      encoding: "utf8",
    }),
  );
  try {
    const baseline = (await import(pathToFileURL(baselineFile).href)) as {
      AgentRunner: typeof AgentRunner;
    };
    const client = new OpenAiCompatibleClient(
      new EnvironmentSecretResolver({
        AGENT_EVAL_KEY: process.env.AGENT_EVAL_SECRET ?? "",
      }),
    );
    const provider: AiProviderRecord = {
      id: "fictional-eval",
      name: "Development evaluation",
      apiKind:
        process.env.AGENT_EVAL_PROTOCOL === "responses"
          ? "responses"
          : "chat-completions",
      baseUrl,
      model,
      secretRef: "AGENT_EVAL_KEY",
      parameters: {},
      requestTimeoutMs: 60000,
      enabled: true,
      version: 1,
      sortOrder: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      capabilities: { functionCalling: true, hostedWebSearch: false },
    };
    const days = ["01", "02", "03", "04", "05", "06", "07"];
    const scenarios = [
      { id: "greeting", prompt: "你好！", expected: "自然问候，不调用工具。" },
      {
        id: "latest",
        prompt: "fictional-alice 最近一次发言是什么时候？",
        expected:
          "使用 get_latest_chat_messages，准确返回 2026-09-07T07:17:00+08:00。",
      },
      {
        id: "mixed",
        prompt:
          "我们之前对虚构计划的决定是什么？再查一下公开的虚构计划公告，比较是否一致。",
        expected:
          "历史搜索并按需展开，结合联网结果；不得把虚构计划已经启用说成事实。",
      },
      {
        id: "seven-days",
        prompt:
          "分别查询 fictional-alice 在 2026-09-01 至 2026-09-07 每一天的最后一条发言，列出每天的准确时间。每次查询一个自然日，使用 +08:00 时区。",
        expected:
          "新预算可完成七次查询；旧预算应只报告查到的部分。禁止捏造每日限额或自动续查。",
      },
      {
        id: "exhaustion",
        prompt:
          "分别查询 fictional-alice 在 2026-09-01 至 2026-09-20 每一天的最后一条发言。每次查询一个自然日，使用 +08:00 时区。",
        expected:
          "配额不足时交代本次查询不完整；无记录与未执行日期不能混淆，不承诺明天恢复或自动继续。",
      },
    ];
    for (const scenario of scenarios)
      for (const mode of ["baseline", "current"] as const) {
        let calls = 0,
          searches = 0,
          reads = 0,
          characters = 0,
          turns = 0;
        let promptTokens = 0,
          completionTokens = 0,
          usageAvailable = true;
        const tools: string[] = [];
        const routing = {
          execute: async (request: AiRouteRequest): Promise<AiRouteResult> => {
            turns++;
            const result = await client.call(provider, {
              messages: request.messages,
              maxOutputTokens: request.maxOutputTokens,
              temperature: request.temperature,
              ...(request.tools ? { tools: request.tools } : {}),
              ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
            });
            usageAvailable &&=
              result.diagnostics?.promptTokens != null &&
              result.diagnostics?.completionTokens != null;
            promptTokens += result.diagnostics?.promptTokens ?? 0;
            completionTokens += result.diagnostics?.completionTokens ?? 0;
            if (result.status === "failed")
              return { ...result, attemptCount: 1 };
            return {
              ...result,
              providerId: provider.id,
              providerName: provider.name,
              providerVersion: 1,
              model,
              routeVersion: 1,
              round: 1,
              attemptCount: 1,
              toolCalls: result.toolCalls ?? [],
              diagnostics: result.diagnostics ?? null,
            };
          },
        } as unknown as AiRoutingService;
        const session = {
          id: "fictional-retrieval",
          validate: () => Promise.resolve(true),
          references: () => ["M1"],
          render: (text: string) =>
            /\[M(?!1\])/u.test(text) ? null : text.replace(/\[M1\]/gu, ""),
          execute: (name: string, args: string) => {
            calls++;
            tools.push(name);
            let payload: Record<string, unknown> = {};
            try {
              payload = JSON.parse(args) as Record<string, unknown>;
            } catch {
              return Promise.resolve(
                '{"status":"unavailable","reason":"invalid-arguments"}',
              );
            }
            if (
              mode === "baseline" &&
              ((name === "search_chat_history" && ++searches > 2) ||
                (name === "read_chat_excerpt" && ++reads > 3) ||
                characters >= 6000)
            )
              return Promise.resolve(
                '{"status":"unavailable","reason":"tool-limit"}',
              );
            const day =
              typeof payload.from === "string"
                ? payload.from.slice(8, 10)
                : "07";
            const valid = days.includes(day);
            const text =
              name === "get_latest_chat_messages"
                ? "2026-09-" +
                  day +
                  "T07:" +
                  (10 + Number(day)) +
                  ":00+08:00 sender_id=fictional-alice role=user\n虚构每日发言"
                : "2026-09-01T08:00:00+08:00 sender_id=fictional-alice role=user\n虚构计划仍在测试，尚未启用。";
            const content = JSON.stringify({
              status: valid ? "succeeded" : "no-results",
              evidence: valid
                ? [
                    {
                      ref: "M1",
                      text,
                      participants: [
                        { senderId: "fictional-alice", name: "虚构甲" },
                      ],
                    },
                  ]
                : [],
              truncated: false,
            });
            characters += text.length;
            return Promise.resolve(content);
          },
        };
        const memory = {
          repository: { scopeForEvent: () => Promise.resolve({}) },
          session: () => Promise.resolve(session),
        } as unknown as MemoryService;
        const search = {
          isReady: () => Promise.resolve(true),
          search: () => {
            calls++;
            tools.push("web_search");
            return Promise.resolve({
              durationMs: 0,
              results: [
                {
                  title: "虚构计划公告",
                  snippet: "虚构计划仍在测试，尚未启用。",
                  url: "https://fictional.example.test/notice",
                  publishedAt: null,
                  source: "fictional",
                },
              ],
            });
          },
        };
        const Runner = mode === "baseline" ? baseline.AgentRunner : AgentRunner;
        const started = Date.now();
        const result = await new Runner(
          routing,
          search,
          undefined,
          undefined,
          undefined,
          memory,
        ).run({
          executionId: "fictional-evaluation",
          nodeId: "ai",
          routeId: "fictional-route",
          memoryEvent: {
            provider: "fictional",
            messageId: "fictional-trigger",
          },
          messages: [
            {
              role: "system",
              content:
                "全部为虚构评测。当前消息时间 2026-09-21T12:00:00+08:00，聊天时区 Asia/Shanghai。已知成员 sender_id=fictional-alice，姓名虚构甲。",
            },
            { role: "user", content: scenario.prompt },
          ],
          maxOutputTokens: 1500,
          temperature: null,
          maxOutputCharacters: 6000,
          outputFormat: "text",
          protectedPrompt: null,
          webSearch: "auto",
        });
        process.stdout.write(
          JSON.stringify({
            scenario: scenario.id,
            mode,
            baselineRef,
            model,
            status: result.status,
            calls,
            turns,
            tools,
            durationMs: Date.now() - started,
            promptTokens: usageAvailable ? promptTokens : null,
            completionTokens: usageAvailable ? completionTokens : null,
            agentBudget: result.agentBudget ?? null,
            answer: result.status === "succeeded" ? result.text : result.code,
            expected: scenario.expected,
            assessment: "requires-human-review",
          }) + "\n",
        );
      }
  } finally {
    await unlink(baselineFile);
  }
}
