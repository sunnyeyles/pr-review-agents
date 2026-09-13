/** GET /orders/:orderId/invoice-lines — the printable invoice body. */
import type { Request, Response } from "express";

import { listOrderLines } from "../data/orders.js";
import { findProductsByIds } from "../data/products.js";
import { HttpError } from "../http/errors.js";
import { requestContext } from "../http/request-context.js";

export async function getInvoiceLines(req: Request, res: Response): Promise<void> {
  const ctx = requestContext(req);

  const orderId = req.params["orderId"];
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new HttpError(400, "orderId is required");
  }

  const lines = await listOrderLines(ctx, orderId);
  const products = await findProductsByIds(
    ctx,
    lines.map((line) => line.productId),
  );

  res.json({
    lines: lines.map((line) => ({
      sku: line.sku,
      description: products.get(line.productId)?.name ?? line.sku,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
    })),
  });
}
