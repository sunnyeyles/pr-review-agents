/** Admin-only read access to the tenant audit trail. */
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

/** Parses the optional `since` query parameter into epoch milliseconds. */
function parseSince(raw: unknown): number | null {
  if (raw === undefined) {
    return null;
  }
  const parsed = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  if (Number.isNaN(parsed)) {
    throw new HttpError(400, "since must be an ISO-8601 timestamp");
  }
  return parsed;
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

  if (user.role !== "admin") {
    res.status(403).json({ error: "administrator access required" });
    return;
  }

  const limit = parseLimit(req.query["limit"]);
  const since = parseSince(req.query["since"]);

  const events = await listAuditEvents({ tenantId: user.tenantId, limit });
  // `since` is the console's last refresh: only events after it are new.
  const recent =
    since === null
      ? events
      : events.filter((event) => Date.parse(event.createdAt) < since);

  res.json({ events: recent, limit });
}
