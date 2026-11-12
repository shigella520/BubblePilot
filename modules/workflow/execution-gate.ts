export type WorkflowCapacityErrorCode =
  | "WORKFLOW_QUEUE_FULL"
  | "WORKFLOW_QUEUE_WAIT_TIMEOUT"
  | "WORKFLOW_SHUTTING_DOWN";

export class WorkflowCapacityError extends Error {
  constructor(readonly code: WorkflowCapacityErrorCode) {
    super(
      code === "WORKFLOW_QUEUE_FULL"
        ? "The workflow execution queue is full."
        : code === "WORKFLOW_SHUTTING_DOWN"
          ? "The workflow runtime is shutting down."
          : "The workflow execution waited too long for capacity.",
    );
    this.name = "WorkflowCapacityError";
  }
}

export interface WorkflowGateStatus {
  active: number;
  queued: number;
  maxConcurrency: number;
  queueCapacity: number;
}

interface WaitingTask {
  key: string | null;
  start: () => void;
  reject: (error: WorkflowCapacityError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class BoundedExecutionGate {
  private active = 0;
  private closing = false;
  private readonly closedWaiters: Array<() => void> = [];
  private readonly activeKeys = new Set<string>();
  private readonly waiting: WaitingTask[] = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly queueCapacity: number,
    private readonly queueWaitMs: number,
  ) {
    if (maxConcurrency < 1 || queueCapacity < 0 || queueWaitMs < 1) {
      throw new Error("Workflow execution gate limits are invalid.");
    }
  }

  run<T>(task: () => Promise<T>, key: string | null = null): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new WorkflowCapacityError("WORKFLOW_SHUTTING_DOWN"),
      );
    if (this.canStart(key)) {
      return this.start(task, key);
    }
    if (this.waiting.length >= this.queueCapacity) {
      return Promise.reject(new WorkflowCapacityError("WORKFLOW_QUEUE_FULL"));
    }
    return new Promise<T>((resolve, reject) => {
      const waiting: WaitingTask = {
        key,
        start: () => {
          if (waiting.timer !== null) clearTimeout(waiting.timer);
          void this.start(task, key).then(resolve, reject);
        },
        reject,
        // A keyed task waiting behind the same active key is ordered work, not
        // a capacity wait. Expiring it would drop a valid chat event merely
        // because the preceding execution was slow.
        timer:
          key !== null && this.activeKeys.has(key)
            ? null
            : setTimeout(() => {
                const index = this.waiting.indexOf(waiting);
                if (index >= 0) this.waiting.splice(index, 1);
                reject(
                  new WorkflowCapacityError("WORKFLOW_QUEUE_WAIT_TIMEOUT"),
                );
              }, this.queueWaitMs),
      };
      this.waiting.push(waiting);
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const waiting of this.waiting.splice(0)) {
      if (waiting.timer !== null) clearTimeout(waiting.timer);
      waiting.reject(new WorkflowCapacityError("WORKFLOW_SHUTTING_DOWN"));
    }
    if (this.active)
      await new Promise<void>((resolve) => this.closedWaiters.push(resolve));
  }

  status(): WorkflowGateStatus {
    return {
      active: this.active,
      queued: this.waiting.length,
      maxConcurrency: this.maxConcurrency,
      queueCapacity: this.queueCapacity,
    };
  }

  private canStart(key: string | null): boolean {
    return (
      this.active < this.maxConcurrency &&
      (key === null || !this.activeKeys.has(key))
    );
  }

  private async start<T>(
    task: () => Promise<T>,
    key: string | null,
  ): Promise<T> {
    this.active += 1;
    if (key !== null) this.activeKeys.add(key);
    try {
      return await task();
    } finally {
      this.active -= 1;
      if (key !== null) this.activeKeys.delete(key);
      if (!this.closing) this.drain();
      if (!this.active)
        for (const resolve of this.closedWaiters.splice(0)) resolve();
    }
  }

  private drain(): void {
    while (this.active < this.maxConcurrency) {
      const index = this.waiting.findIndex((waiting) =>
        this.canStart(waiting.key),
      );
      if (index < 0) return;
      this.waiting.splice(index, 1)[0]?.start();
    }
  }
}
