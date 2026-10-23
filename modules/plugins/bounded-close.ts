/** Best-effort cleanup must never hold a completed Agent answer indefinitely. */
export async function boundedClose(
  action: () => Promise<unknown>,
  timeoutMs = 1500,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(action)
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
