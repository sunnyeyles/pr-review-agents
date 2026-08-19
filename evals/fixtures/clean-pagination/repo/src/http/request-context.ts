/** Builds the per-request context from the authenticated session. */
import type { Request } from "express";

import { HttpError } from "./errors.js";

export interface RequestContext {
  requestId: string;
  tenantId: string;
}

export function requestContext(req: Request): RequestContext {
  const session = req.session;
  if (session === undefined) {
    throw new HttpError(401, "authentication required");
  }
  return { requestId: req.id, tenantId: session.tenantId };
}
