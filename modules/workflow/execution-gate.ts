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
  start: () => void;
  reject: (error: WorkflowCapacityError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BoundedExecutionGate {
  private active = 0;
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

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.maxConcurrency) {
      return this.start(task);
    }
    if (this.waiting.length >= this.queueCapacity) {
      return Promise.reject(new WorkflowCapacityError("WORKFLOW_QUEUE_FULL"));
    }
    return new Promise<T>((resolve, reject) => {
      const waiting: WaitingTask = {
        start: () => {
          clearTimeout(waiting.timer);
          void this.start(task).then(resolve, reject);
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

  private async start<T>(task: () => Promise<T>): Promise<T> {
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.start();
    }
  }
}
