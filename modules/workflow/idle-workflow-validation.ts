import type { WorkflowDefinition } from "./workflow-definition.js";

/** Validate the actual idle path, including failure edges, rather than every node. */
export function validateIdlePaths(
  definition: WorkflowDefinition,
  eventType: "chat-idle" | "scheduled-task" = "chat-idle",
): void {
  const enabled = (node: WorkflowDefinition["nodes"][number]) =>
    node.type === "message-trigger" &&
    (eventType === "chat-idle"
      ? node.config.idle?.enabled
      : node.config.scheduled?.enabled);
  const start = definition.nodes.find(
    (node) => node.id === definition.startNodeId,
  );
  const idleStarts = definition.nodes.filter((node) => enabled(node));
  if (!idleStarts.length) return;
  if (
    idleStarts.length !== 1 ||
    start?.type !== "message-trigger" ||
    !enabled(start)
  )
    throw new Error(
      "Idle triggering must be configured on the single workflow entry node.",
    );
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const visit = (id: string, decision: boolean, sent: boolean): void => {
    const key = `${id}:${decision}:${sent}`;
    if (visited.has(key)) return;
    visited.add(key);
    const node = nodes.get(id);
    if (!node) return; // Graph validation reports this first.
    const reject = (field: string): never => {
      throw new Error(
        `Node '${id}' is incompatible with ${eventType}: ${field}.`,
      );
    };
    const check = (value: unknown, path: string): void => {
      if (
        typeof value === "string" &&
        /(?:\{\{\s*(?:context\.event\.)?message\.|^context\.event\.message\.)/u.test(
          value,
        )
      )
        reject(`${path} requires a current message`);
      if (Array.isArray(value))
        value.forEach((v, index) => check(v, `${path}.${index}`));
      else if (value && typeof value === "object")
        Object.entries(value).forEach(([k, v]) => check(v, `${path}.${k}`));
    };
    if (node.type !== "message-trigger") {
      check(node.config, "config");
      for (const [name, input] of Object.entries(node.inputs ?? {})) {
        // A direct current-text prompt is optional on idle runs; idle_task supplies the task.
        if (
          node.type === "ai-chat" &&
          name === "prompt" &&
          input.kind === "path" &&
          input.path === "context.event.message.text"
        )
          continue;
        check(input, `inputs.${name}`);
      }
    }
    if (node.type === "condition") {
      if (node.config.field.startsWith("message."))
        reject("config.field requires a current message");
      if (node.config.field === "event.type") {
        const value = node.config.caseSensitive
          ? eventType
          : eventType.toLowerCase();
        const expected = node.config.caseSensitive
          ? (node.config.value ?? "")
          : (node.config.value ?? "").toLowerCase();
        const matched =
          node.config.operator === "exists"
            ? true
            : node.config.operator === "equals"
              ? value === expected
              : node.config.operator === "contains"
                ? value.includes(expected)
                : node.config.operator === "starts-with"
                  ? value.startsWith(expected)
                  : new RegExp(
                      expected,
                      node.config.caseSensitive ? "u" : "iu",
                    ).test(value);
        visit(matched ? node.onTrue : node.onFalse, decision, sent);
      } else {
        visit(node.onTrue, decision, sent);
        visit(node.onFalse, decision, sent);
      }
      return;
    }
    if (
      node.type === "ai-chat" &&
      !decision &&
      node.config.outputFormat !== "text"
    )
      reject("first AI node must use text answer mode");
    if (node.type === "reply") {
      if (!decision) reject("reply requires a successful AI send decision");
      if (sent) reject("only one reply is allowed per idle attempt");
      if (node.config.replyToSourceMessage)
        reject("native reply requires a current message");
    }
    if (eventType === "scheduled-task" && node.type === "ai-chat" && decision)
      reject("only one AI generation node is allowed");
    if (eventType === "scheduled-task" && node.type === "end" && !sent)
      reject("reminder path must send a reply");
    const nextDecision = decision || node.type === "ai-chat";
    const nextSent = sent || node.type === "reply";
    if ("onSuccess" in node && node.onSuccess)
      visit(node.onSuccess, nextDecision, nextSent);
    if ("onFailure" in node && node.onFailure)
      visit(node.onFailure, decision, nextSent);
  };
  visit(start.id, false, false);
}
