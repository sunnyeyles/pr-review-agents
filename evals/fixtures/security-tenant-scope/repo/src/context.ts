/**
 * The per-request context every data-access function takes.
 *
 * `tenantId` comes from the authenticated session, never from the
 * request body or path, and every query in src/data is scoped by it.
 */
export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
}

export interface RequestContext {
  requestId: string;
  tenantId: string;
  actorId: string;
  logger: Logger;
}
