/**
 * Builds the per-request context from the authenticated session that
 * src/http/middleware.ts attached to the request.
 */
import type { Request } from "express";

import type { RequestContext } from "../context.js";
import { HttpError } from "./errors.js";
import { logger } from "../logger.js";

export function requestContext(req: Request): RequestContext {
  const session = req.session;
  if (session === undefined) {
    throw new HttpError(401, "authentication required");
  }
  return {
    requestId: req.id,
    tenantId: session.tenantId,
    actorId: session.userId,
    logger,
  };
}
