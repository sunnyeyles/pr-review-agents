/** GET /orders/:orderId/summary — the order detail page payload. */
import type { Request, Response } from "express";

import { HttpError } from "../http/errors.js";
import { requestContext } from "../http/request-context.js";
import { buildOrderSummary } from "../services/order-summary.js";

export async function getOrderSummary(req: Request, res: Response): Promise<void> {
  const ctx = requestContext(req);

  const orderId = req.params["orderId"];
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new HttpError(400, "orderId is required");
  }

  const summary = await buildOrderSummary(ctx, orderId);

  res.json({
    summary,
    columns: ["sku", "quantity", "lineTotal"],
  });
}
