import { describe, expect, it } from "vitest";
import {
  strictToolParameters,
  restoreToolArguments,
} from "../modules/ai/tool-schema.js";
import { compileMcpSchema } from "../modules/plugins/plugin-schema.js";
import { taskToolSchemas } from "../modules/scheduled-tasks/task-tool-definitions.js";
import { allToolDefinitions } from "./support/tool-schema-fixtures.js";

const required: Record<string, string[]> = {
  query_chat_messages: [],
  count_chat_messages: [],
  get_chat_message_extrema: ["pick"],
  search_chat_history: ["query"],
  read_chat_excerpt: ["ref"],
  import_chat_attachment: ["attachment_ref"],
  view_chat_image: ["image_ref"],
  search_memes: ["query"],
  select_meme: ["id"],
  web_search: ["query"],
  capability_probe: ["acknowledgement"],
  fictional_mcp: [],
  load_plugin_skill: ["id"],
  read_plugin_reference: ["id"],
  read_tool_result: ["result_ref"],
  search_tool_result: ["result_ref", "query"],
  create_scheduled_task: [
    "summary",
    "content",
    "requestSnapshot",
    "timeZone",
    "schedule",
  ],
  list_scheduled_tasks: [],
  update_scheduled_task: ["id", "expectedVersion"],
  cancel_scheduled_task: ["id", "expectedVersion"],
  pause_scheduled_task: ["id", "expectedVersion"],
  resume_scheduled_task: ["id", "expectedVersion"],
  skip_next_scheduled_task: ["id", "expectedVersion"],
};

describe("model tool parameter contracts", () => {
  it("keeps required fields and nullable placeholders consistent for every built-in tool", () => {
    const definitions = allToolDefinitions();
    expect(definitions.map((t) => t.name).sort()).toEqual(
      Object.keys(required).sort(),
    );
    for (const tool of definitions) {
      expect(
        [...((tool.parameters.required as string[] | undefined) ?? [])].sort(),
      ).toEqual([...required[tool.name]!].sort());
      const wire = strictToolParameters(tool);
      const properties = wire.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(wire.required).toEqual(Object.keys(properties));
      for (const [name, schema] of Object.entries(properties)) {
        if (!required[tool.name]!.includes(name)) {
          expect(
            compileMcpSchema(schema)(null),
            `${tool.name}.${name} must allow its unused placeholder`,
          ).toBe(true);
          expect(
            JSON.parse(
              restoreToolArguments(
                tool.parameters,
                JSON.stringify({ [name]: null }),
              ),
            ),
          ).toEqual({});
        }
      }
    }
    // This is a deliberate business null, not an unused placeholder.
    const select = definitions.find((t) => t.name === "select_meme")!;
    expect(compileMcpSchema(strictToolParameters(select))({ id: null })).toBe(
      true,
    );
    expect(
      JSON.parse(restoreToolArguments(select.parameters, '{"id":null}')),
    ).toEqual({ id: null });
  });

  it("validates and restores single, recurring, list and update inputs without choosing between conflicts", () => {
    const definitions = allToolDefinitions();
    const create = definitions.find((t) => t.name === "create_scheduled_task")!;
    const list = definitions.find((t) => t.name === "list_scheduled_tasks")!;
    const update = definitions.find((t) => t.name === "update_scheduled_task")!;
    const at = "2030-01-02T05:00:00Z";
    const schedules = [
      { kind: "once", scheduledAt: at },
      {
        kind: "recurring",
        startsAt: at,
        rule: { type: "daily", localTime: "05:00" },
        end: { kind: "never" },
      },
      {
        kind: "recurring",
        startsAt: at,
        rule: { type: "weekly", weekdays: [1, 5], localTime: "05:00" },
        end: { kind: "count", count: 3 },
      },
      {
        kind: "recurring",
        startsAt: at,
        rule: { type: "monthly", dayOfMonth: "last", localTime: "05:00" },
        end: { kind: "until", until: "2030-05-02T05:00:00Z" },
      },
      {
        kind: "recurring",
        startsAt: at,
        rule: { type: "interval", everyMinutes: 120 },
        end: { kind: "never" },
      },
    ];
    const checkCreate = compileMcpSchema(strictToolParameters(create));
    for (const schedule of schedules) {
      const input = {
        summary: "虚构提醒",
        content: "虚构内容",
        requestSnapshot: "请设置虚构提醒。",
        timeZone: "UTC",
        schedule,
      };
      expect(checkCreate(input), JSON.stringify(schedule)).toBe(true);
      expect(
        taskToolSchemas.create_scheduled_task.safeParse(
          JSON.parse(
            restoreToolArguments(create.parameters, JSON.stringify(input)),
          ),
        ).success,
      ).toBe(true);
      expect(checkCreate({ ...input, scheduledAt: at })).toBe(false);
    }
    const listInput = { status: null, offset: null, limit: null };
    expect(compileMcpSchema(strictToolParameters(list))(listInput)).toBe(true);
    expect(
      taskToolSchemas.list_scheduled_tasks.parse(
        JSON.parse(
          restoreToolArguments(list.parameters, JSON.stringify(listInput)),
        ),
      ),
    ).toEqual({ offset: 0, limit: 10 });
    const updateInput = {
      id: "00000000-0000-4000-8000-000000000001",
      expectedVersion: 1,
      summary: "新概要",
      content: null,
      timeZone: null,
      schedule: null,
    };
    expect(compileMcpSchema(strictToolParameters(update))(updateInput)).toBe(
      true,
    );
    expect(
      taskToolSchemas.update_scheduled_task.parse(
        JSON.parse(
          restoreToolArguments(update.parameters, JSON.stringify(updateInput)),
        ),
      ),
    ).toEqual({ id: updateInput.id, expectedVersion: 1, summary: "新概要" });
    expect(
      taskToolSchemas.update_scheduled_task.safeParse({
        id: updateInput.id,
        expectedVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      taskToolSchemas.create_scheduled_task.safeParse({
        summary: "x",
        content: "y",
        requestSnapshot: "Fictional request",
        timeZone: "UTC",
        schedule: {
          ...schedules[0],
          rule: { type: "daily", localTime: "05:00" },
        },
      }).success,
    ).toBe(false);
  });
});
