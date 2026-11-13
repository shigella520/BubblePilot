import type { AiChatMessage } from "./ai-types.js";

interface AiPromptZones {
  system: readonly AiChatMessage[];
  executionSystem: readonly AiChatMessage[];
  staticTask: AiChatMessage | null;
  participants: AiChatMessage | null;
  history: readonly AiChatMessage[];
  currentMessage: AiChatMessage | null;
  dynamicTask: readonly AiChatMessage[];
  currentResources: AiChatMessage | null;
  diagnostics: AiChatMessage | null;
}

function joinedSystem(messages: readonly AiChatMessage[]): AiChatMessage[] {
  const content = messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
    )
    .filter((text) => text.length > 0)
    .join("\n");
  return content ? [{ role: "system", content }] : [];
}

/** Keep data in its original role; ordering must not promote reference material. */
export function assemblePromptZones(zones: AiPromptZones): {
  messages: AiChatMessage[];
  configurationMessageCount: number;
} {
  const messages = joinedSystem(zones.system);
  if (zones.staticTask) messages.push(zones.staticTask);
  if (zones.participants) messages.push(zones.participants);
  const configurationMessageCount = messages.length;
  messages.push(...zones.history);
  messages.push(...joinedSystem(zones.executionSystem));
  if (zones.currentMessage) messages.push(zones.currentMessage);
  messages.push(...zones.dynamicTask);
  if (zones.currentResources) messages.push(zones.currentResources);
  if (zones.diagnostics) messages.push(zones.diagnostics);
  return { messages, configurationMessageCount };
}
