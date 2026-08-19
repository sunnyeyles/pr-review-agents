/**
 * The error type route handlers throw for a client-visible failure.
 * src/http/middleware.ts turns it into a JSON response.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
