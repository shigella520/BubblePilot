export class ApplicationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApplicationError";
  }
}

export class InvalidWebhookError extends ApplicationError {
  constructor(
    message = "The webhook payload is invalid.",
    options?: ErrorOptions,
  ) {
    super("INVALID_WEBHOOK", message, 400, options);
    this.name = "InvalidWebhookError";
  }
}
