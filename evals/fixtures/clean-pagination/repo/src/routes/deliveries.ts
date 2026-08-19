/** GET /deliveries — the webhook delivery log. */
import type { Request, Response } from "express";

import { listDeliveries } from "../data/deliveries.js";
import { requestContext } from "../http/request-context.js";
import { parsePagination } from "../http/pagination.js";

export async function getDeliveries(req: Request, res: Response): Promise<void> {
  const ctx = requestContext(req);

  const { page, pageSize, offset } = parsePagination(req.query);

  const deliveries = await listDeliveries(ctx, { limit: pageSize, offset });
  res.json({ deliveries, page, pageSize });
}
