/** Subscription routes. */
import type { Request, Response } from "express";

import { loadSessionUser } from "../auth/session.js";
import { listForTenant } from "../services/subscriptions.js";

export async function listSubscriptions(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await loadSessionUser(req);
  if (user === null) {
    res.status(401).json({ error: "authentication required" });
    return;
  }

  const subscriptions = await listForTenant(user.tenantId);
  res.json({ subscriptions });
}
