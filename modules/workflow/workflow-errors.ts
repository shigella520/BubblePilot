export class WorkflowExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly requiresManualRecovery = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkflowExecutionError";
  }
}
