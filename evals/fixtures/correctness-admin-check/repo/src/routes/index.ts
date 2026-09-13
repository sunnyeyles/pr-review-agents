/** Route table for the billing API. */
import { Router } from "express";

import { getAuditEvents } from "./admin-audit.js";
import { getInvoiceById } from "./billing.js";
import { listSubscriptions } from "./subscriptions.js";

export function createRouter(): Router {
  const router = Router();

  router.get("/admin/audit-events", getAuditEvents);
  router.get("/invoices/:invoiceId", getInvoiceById);
  router.get("/subscriptions", listSubscriptions);

  return router;
}
