export class WorkflowExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly requiresManualRecovery = false,
    options?: ErrorOptions,
    readonly outputSummary?: Readonly<Record<string, unknown>>,
  ) {
    super(message, options);
    this.name = "WorkflowExecutionError";
  }
}
