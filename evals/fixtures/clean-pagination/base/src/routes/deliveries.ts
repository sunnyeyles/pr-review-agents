/** GET /deliveries — the webhook delivery log. */
import type { Request, Response } from "express";

import { listDeliveries } from "../data/deliveries.js";
import { HttpError } from "../http/errors.js";
import { requestContext } from "../http/request-context.js";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export async function getDeliveries(req: Request, res: Response): Promise<void> {
  const ctx = requestContext(req);

  const rawPage = req.query["page"];
  const rawPageSize = req.query["pageSize"];
  const page = rawPage === undefined ? 1 : Number(rawPage);
  const pageSize = rawPageSize === undefined ? DEFAULT_PAGE_SIZE : Number(rawPageSize);
  if (!Number.isInteger(page) || page < 1) {
    throw new HttpError(400, "page must be a positive integer");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new HttpError(400, `pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  const offset = (page - 1) * pageSize;

  const deliveries = await listDeliveries(ctx, { limit: pageSize, offset });
  res.json({ deliveries, page, pageSize });
}
