export type WorkflowCapacityErrorCode =
  "WORKFLOW_QUEUE_FULL" | "WORKFLOW_QUEUE_WAIT_TIMEOUT";

export class WorkflowCapacityError extends Error {
  constructor(readonly code: WorkflowCapacityErrorCode) {
    super(
      code === "WORKFLOW_QUEUE_FULL"
        ? "The workflow execution queue is full."
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
  timer: ReturnType<typeof setTimeout>;
}

export class BoundedExecutionGate {
  private active = 0;
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
          clearTimeout(waiting.timer);
          void this.start(task, key).then(resolve, reject);
        },
        reject,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(waiting);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new WorkflowCapacityError("WORKFLOW_QUEUE_WAIT_TIMEOUT"));
        }, this.queueWaitMs),
      };
      this.waiting.push(waiting);
    });
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
      this.drain();
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
