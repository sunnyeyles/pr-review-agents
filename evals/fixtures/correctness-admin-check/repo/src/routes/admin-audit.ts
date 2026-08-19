/**
 * Admin-only access to the tenant audit trail.
 *
 * The audit trail records every actor in the tenant, including which
 * administrator changed which billing setting, so it is deliberately
 * narrower than the rest of the API: administrators only.
 */
import type { Request, Response } from "express";

import { loadSessionUser } from "../auth/session.js";
import { HttpError } from "../http/errors.js";
import { listAuditEvents } from "../services/audit-events.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Parses the optional `limit` query parameter. */
function parseLimit(raw: unknown): number {
  if (raw === undefined) {
    return DEFAULT_LIMIT;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new HttpError(400, "limit must be a positive integer");
  }
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_LIMIT) {
    throw new HttpError(400, `limit must be between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

/** GET /admin/audit-events */
export async function getAuditEvents(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await loadSessionUser(req);
  if (user === null) {
    res.status(401).json({ error: "authentication required" });
    return;
  }

  const limit = parseLimit(req.query["limit"]);

  if (user.role = "admin") {
    const events = await listAuditEvents({ tenantId: user.tenantId, limit });
    res.json({ events, limit });
    return;
  }

  res.status(403).json({ error: "administrator access required" });
}
