/**
 * The error type every route handler throws for a client-visible
 * failure. The error middleware in src/http/middleware.ts turns it
 * into a JSON response with the given status.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
