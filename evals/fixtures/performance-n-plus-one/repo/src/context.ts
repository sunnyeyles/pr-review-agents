/** The per-request context every data-access function takes. */
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
