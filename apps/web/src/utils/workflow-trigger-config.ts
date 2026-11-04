export function serializeTriggerConfig(nodeConfig: Record<string, unknown>) {
  return {
    ...(nodeConfig.idle ? { idle: nodeConfig.idle } : {}),
    ...(nodeConfig.scheduled ? { scheduled: nodeConfig.scheduled } : {}),
    provider: nodeConfig.provider ?? "",
    chatIds: Array.isArray(nodeConfig.chatIds) ? nodeConfig.chatIds : [],
    senderIds: Array.isArray(nodeConfig.senderIds) ? nodeConfig.senderIds : [],
    contentTypes: Array.isArray(nodeConfig.contentTypes)
      ? nodeConfig.contentTypes
      : [],
    includeFromMe: Boolean(nodeConfig.includeFromMe),
    enabled: Boolean(nodeConfig.enabled),
    text: nodeConfig.textValue
      ? {
          kind: nodeConfig.textKind ?? "prefix",
          value: nodeConfig.textValue,
          caseSensitive: false,
        }
      : null,
  };
}
