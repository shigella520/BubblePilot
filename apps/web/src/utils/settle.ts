/**
 * Loads independent page sections in parallel. One failing request no longer
 * blanks the whole page: successful sections render, failures are listed.
 */
export async function settleAll<
  T extends Record<string, () => Promise<unknown>>,
>(
  tasks: T,
): Promise<{
  values: { [K in keyof T]?: Awaited<ReturnType<T[K]>> };
  failed: Array<{ key: keyof T; cause: unknown }>;
}> {
  const entries = Object.entries(tasks) as Array<
    [keyof T, () => Promise<unknown>]
  >;
  const results = await Promise.all(
    entries.map(([key, task]) =>
      task().then(
        (value) => ({ key, ok: true as const, value }),
        (cause: unknown) => ({ key, ok: false as const, cause }),
      ),
    ),
  );
  const values: Partial<Record<keyof T, unknown>> = {};
  const failed: Array<{ key: keyof T; cause: unknown }> = [];
  for (const result of results) {
    if (result.ok) values[result.key] = result.value;
    else failed.push({ key: result.key, cause: result.cause });
  }
  return {
    values: values as { [K in keyof T]?: Awaited<ReturnType<T[K]>> },
    failed,
  };
}

/** "部分内容未能加载：触发器、AI 路由。" plus the first error's diagnostics. */
export function partialFailureMessage<K extends string>(
  failed: Array<{ key: K; cause: unknown }>,
  names: Record<K, string>,
  describe: (cause: unknown) => string,
): string {
  const [first] = failed;
  if (!first) return "";
  const list = failed.map((f) => names[f.key]).join("、");
  return `部分内容未能加载：${list}。可点击刷新重试。\n${describe(first.cause)}`;
}
