/** Application error with a stable machine-readable code and an HTTP status. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
  }
}
