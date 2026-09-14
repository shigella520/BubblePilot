/** Shared, side-effect-free defaults for new generation requests and retrieval. */
export const executionPolicy = {
  protectionFactor: 3,
  chat: {
    targetCharacters: 2_000,
    maxTargetCharacters: 4_000,
    maxTokens: 8_192,
  },
  legacy: { maxCharacters: 4_000, maxTokens: 1_024 },
  image: { targetCharacters: 500, maxTokens: 2_048 },
  search: { limit: 8, maxLimit: 20, candidates: 40 },
  excerpt: { surrounding: 8, maxSurrounding: 20 },
} as const;

export const maxReplyCharacters =
  executionPolicy.chat.maxTargetCharacters * executionPolicy.protectionFactor;

export function resolveGenerationPolicy(config: {
  targetOutputCharacters?: number | undefined;
  maxOutputCharacters?: number | undefined;
  maxOutputTokens?: number | undefined;
}) {
  if (
    config.targetOutputCharacters !== undefined &&
    config.maxOutputCharacters !== undefined
  )
    throw new Error("Conflicting generation character policies");
  const target = config.targetOutputCharacters;
  return {
    targetOutputCharacters: target,
    maxOutputCharacters:
      target === undefined
        ? (config.maxOutputCharacters ?? executionPolicy.legacy.maxCharacters)
        : target * executionPolicy.protectionFactor,
    maxOutputTokens:
      config.maxOutputTokens ??
      (target === undefined
        ? executionPolicy.legacy.maxTokens
        : executionPolicy.chat.maxTokens),
  };
}

export function generationLengthInstruction(target: number): string {
  return `输出长度要求：最终回答尽量不超过 ${target} 个字符（含标点、空格和来源说明）。工具查询后的最终回答和引用修正同样遵守此要求。JSON 输出按完整序列化文本计数。优先保留直接回答问题的内容，并完整结束句子和结构；不要为了凑长度补充内容。`;
}
