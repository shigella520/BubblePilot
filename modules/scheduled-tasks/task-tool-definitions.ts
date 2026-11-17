import { z } from "zod";
import type { AiToolDefinition } from "../ai/ai-types.js";
import {
  cancelTaskSchema,
  createTaskSchema,
  listTasksSchema,
  updateTaskSchema,
} from "./task-policy.js";

export const taskToolSchemas = {
  create_scheduled_task: createTaskSchema,
  list_scheduled_tasks: listTasksSchema,
  update_scheduled_task: updateTaskSchema,
  cancel_scheduled_task: cancelTaskSchema,
  pause_scheduled_task: cancelTaskSchema,
  resume_scheduled_task: cancelTaskSchema,
  skip_next_scheduled_task: cancelTaskSchema,
};

const descriptions: Record<keyof typeof taskToolSchemas, string> = {
  create_scheduled_task:
    "Create a one-time or recurring reminder only for the current user's explicit request. Required: summary, content, requestSnapshot, timeZone and schedule. requestSnapshot faithfully synthesizes this creator's confirmed request across relevant turns, including clarifications; do not copy only the last confirmation or invent authorization. It is explanatory context, not a verbatim quote or extra execution authority. A one-time schedule has kind=once and scheduledAt; a recurring schedule has kind=recurring, startsAt, rule and end. Do not put scheduledAt at the top level. Use absolute datetimes with offsets and an IANA timezone. Confirm only after success.",
  list_scheduled_tasks:
    "List this member's reminder tasks in this chat and workflow before changing or cancelling them. status, offset and limit are optional; follow the current tool schema for unused fields.",
  update_scheduled_task:
    "Change a reminder owned by this member. Required: id and expectedVersion from list, plus at least one of summary, content, timeZone or schedule. Represent unchanged optional fields according to the current tool schema. When changing timeZone, provide the complete schedule as well. Do not put scheduledAt at the top level; use schedule. A summary-only update does not reschedule or interrupt execution.",
  pause_scheduled_task:
    "Pause this member's recurring reminder using its id and expectedVersion. Future occurrences stop until resumed.",
  resume_scheduled_task:
    "Resume this member's recurring reminder using its id and expectedVersion, from its next future occurrence; do not catch up paused times.",
  skip_next_scheduled_task:
    "Skip exactly one next occurrence of this member's recurring reminder, using its id and expectedVersion. Counts toward the occurrence limit.",
  cancel_scheduled_task:
    "Cancel this member's reminder using its id and expectedVersion. Sending already started cannot be guaranteed cancelled.",
};

export function taskToolDefinitions(zone: string): AiToolDefinition[] {
  return (
    Object.keys(taskToolSchemas) as Array<keyof typeof taskToolSchemas>
  ).map((name) => ({
    name,
    description: `${descriptions[name]} Configured reminder timezone: ${zone}.`,
    parameters: z.toJSONSchema(taskToolSchemas[name], { io: "input" }),
  }));
}
