import type { AiChatMessage } from "./ai-types.js";

// The context extractor applies the user-configured character budget. The AI
// node deliberately does not reuse that budget: it only keeps a large guard
// against pathological prompt assembly. Image payloads are counted as their
// decoded bytes, never as the much larger Base64 Data URL string. Image input
// itself is already bounded by the native-image-input settings.
export const AI_CHAT_INPUT_HARD_PAYLOAD_BYTES = 64 * 1024 * 1024;

function dataUrlDecodedBytes(value: string): number {
  const match = /^data:[^,]*;base64,([A-Za-z0-9+/=\s]*)$/su.exec(value);
  if (match?.[1] === undefined) return Buffer.byteLength(value, "utf8");
  const encoded = match[1].replace(/\s/gu, "");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
}

function promptMessagePayloadBytes(message: AiChatMessage): number {
  if (typeof message.content === "string") {
    return Buffer.byteLength(message.content, "utf8");
  }
  return message.content.reduce(
    (total, part) =>
      total +
      (part.type === "text"
        ? Buffer.byteLength(part.text, "utf8")
        : dataUrlDecodedBytes(part.dataUrl) +
          Buffer.byteLength(part.label, "utf8")),
    0,
  );
}

export function aiChatInputPayloadBytes(
  messages: readonly AiChatMessage[],
): number {
  return messages.reduce(
    (total, message) => total + promptMessagePayloadBytes(message),
    0,
  );
}
