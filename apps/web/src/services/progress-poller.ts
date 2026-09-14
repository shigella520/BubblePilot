/** Single-flight polling. Epochs invalidate responses after navigation/actions. */
export class ProgressPoller<T> {
  private timer: ReturnType<typeof setInterval> | undefined;
  private epoch = 0;
  private pending = false;
  private stopped = false;
  constructor(
    private readonly options: {
      enabled: () => boolean;
      load: () => Promise<T>;
      apply: (result: T) => void;
      failed: () => void;
    },
  ) {}
  invalidate() {
    this.epoch++;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 5000);
  }
  async tick() {
    if (this.stopped || this.pending || !this.options.enabled()) return;
    const epoch = this.epoch;
    this.pending = true;
    try {
      const result = await this.options.load();
      if (!this.stopped && epoch === this.epoch && this.options.enabled())
        this.options.apply(result);
    } catch {
      if (!this.stopped && epoch === this.epoch && this.options.enabled())
        this.options.failed();
    } finally {
      this.pending = false;
    }
  }
  stop() {
    this.stopped = true;
    this.invalidate();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
