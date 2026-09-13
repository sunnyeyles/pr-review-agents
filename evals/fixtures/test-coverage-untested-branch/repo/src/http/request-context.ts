/**
 * The per-request context. The tier comes from the authenticated
 * account, never from the request body.
 */
import type { Request } from "express";

import { isCustomerTier, type CustomerTier } from "../pricing/tiers.js";
import { HttpError } from "./errors.js";

export interface RequestContext {
  requestId: string;
  accountId: string;
  tier: CustomerTier;
}

export function requestContext(req: Request): RequestContext {
  const session = req.session;
  if (session === undefined) {
    throw new HttpError(401, "authentication required");
  }
  if (!isCustomerTier(session.tier)) {
    throw new HttpError(403, "account has no pricing tier");
  }
  return {
    requestId: req.id,
    accountId: session.accountId,
    tier: session.tier,
  };
}
