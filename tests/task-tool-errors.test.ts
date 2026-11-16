import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { TaskService } from "../modules/scheduled-tasks/task-service.js";
import { TaskError } from "../modules/scheduled-tasks/task-policy.js";
import type { WorkflowRepository } from "../modules/workflow/workflow-repository.js";

function fixture() {
  const query = vi.fn().mockResolvedValue({
    rows: [
      {
        chat_id: "fictional-chat",
        provider_chat_id: "fictional-chat",
        workflow_id: "fictional-workflow",
        sender_id: "fictional-member",
        message_id: "fictional-message",
        body: "fictional-request",
      },
    ],
  });
  const service = new TaskService(
    { query } as unknown as Pool,
    {} as WorkflowRepository,
  );
  vi.spyOn(service, "binding").mockResolvedValue({
    definition: {
      nodes: [
        {
          type: "message-trigger",
          config: {
            scheduled: {
              enabled: true,
              timeZone: "Asia/Shanghai",
              chatIds: ["fictional-chat"],
            },
          },
        },
      ],
    },
  } as never);
  const context = {
    signal: new AbortController().signal,
    deadline: Date.now() + 10000,
    maxOutputCharacters: 10000,
  };
  return { service, query, context };
}

describe("model-facing scheduled task errors", () => {
  it("reports safe invalid fields and rules before attempting a mutation", async () => {
    const f = fixture();
    const tools = await f.service.tools("fictional-execution");
    const create = vi.spyOn(f.service, "create");
    const tool = tools.find(
      (item) => item.definition.name === "create_scheduled_task",
    )!;
    const result = await tool.execute(
      JSON.stringify({
        summary: "",
        content: "fictional-private-content",
        timeZone: "Asia/Shanghai",
        "fictional-private-field": "private-value",
      }),
      f.context,
    );
    expect(typeof result).toBe("string");
    const payload = JSON.parse(result as string) as {
      issues: unknown[];
      errorCode: string;
    };
    expect(payload.errorCode).toBe("TASK_ARGUMENTS_INVALID");
    expect(payload.issues).toContainEqual(
      expect.objectContaining({ field: "summary", code: "too_small" }),
    );
    expect(JSON.stringify(payload)).not.toContain("fictional-private");
    expect(create).not.toHaveBeenCalled();
  });

  it("explains known task errors without exposing raw exceptions", async () => {
    const f = fixture();
    const tools = await f.service.tools("fictional-execution");
    vi.spyOn(f.service, "list").mockRejectedValue(
      new TaskError("TASK_VERSION_CONFLICT"),
    );
    const tool = tools.find(
      (item) => item.definition.name === "list_scheduled_tasks",
    )!;
    const result = await tool.execute("{}", f.context);
    expect(JSON.parse(result as string)).toMatchObject({
      status: "failed",
      errorCode: "TASK_VERSION_CONFLICT",
      guidance: "任务已发生变化，请刷新后重试。",
    });
  });
  it("rejects conflicting legacy fields before mutation and tells the model how to correct them", async () => {
    const f = fixture();
    const tools = await f.service.tools("fictional-execution");
    const create = vi.spyOn(f.service, "create");
    const result = await tools
      .find((item) => item.definition.name === "create_scheduled_task")!
      .execute(
        JSON.stringify({
          summary: "虚构提醒",
          content: "虚构任务",
          timeZone: "UTC",
          scheduledAt: "2030-01-02T05:00:00Z",
          schedule: {
            kind: "recurring",
            startsAt: "2030-01-02T05:00:00Z",
            rule: { type: "daily", localTime: "05:00" },
            end: { kind: "never" },
          },
        }),
        f.context,
      );
    const conflict = JSON.parse(result as string) as {
      errorCode: string;
      issues: { code: string }[];
      guidance: string;
    };
    expect(conflict.errorCode).toBe("TASK_ARGUMENTS_INVALID");
    expect(
      conflict.issues.some((issue) => issue.code === "unrecognized_keys"),
    ).toBe(true);
    expect(conflict.guidance).toContain("do not submit it at the top level");
    expect(create).not.toHaveBeenCalled();
    const change = vi.spyOn(f.service, "change");
    const update = await tools
      .find((item) => item.definition.name === "update_scheduled_task")!
      .execute(
        JSON.stringify({
          id: "00000000-0000-4000-8000-000000000001",
          expectedVersion: 1,
          timeZone: "UTC",
        }),
        f.context,
      );
    const invalidUpdate = JSON.parse(update as string) as {
      errorCode: string;
      issues: { guidance?: string }[];
    };
    expect(invalidUpdate.errorCode).toBe("TASK_ARGUMENTS_INVALID");
    expect(
      invalidUpdate.issues.some(
        (issue) =>
          issue.guidance ===
          "Provide the complete schedule when changing timeZone.",
      ),
    ).toBe(true);
    expect(change).not.toHaveBeenCalled();
  });
});
