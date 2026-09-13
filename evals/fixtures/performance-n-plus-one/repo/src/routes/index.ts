/** Route table for the invoicing service API. */
import { Router } from "express";

import { getInvoiceLines } from "./invoice-lines.js";
import { getOrderSummary } from "./order-summary.js";

export function createRouter(): Router {
  const router = Router();

  router.get("/orders/:orderId/summary", getOrderSummary);
  router.get("/orders/:orderId/invoice-lines", getInvoiceLines);

  return router;
}
