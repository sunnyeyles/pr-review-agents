/** Billing routes. The shape every route handler in this app follows. */
import type { Request, Response } from "express";

import { loadSessionUser } from "../auth/session.js";
import { HttpError } from "../http/errors.js";
import { getInvoice } from "../services/invoices.js";

export async function getInvoiceById(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await loadSessionUser(req);
  if (user === null) {
    res.status(401).json({ error: "authentication required" });
    return;
  }

  if (user.role !== "admin" && user.role !== "billing") {
    res.status(403).json({ error: "billing access required" });
    return;
  }

  const invoiceId = req.params["invoiceId"];
  if (typeof invoiceId !== "string") {
    throw new HttpError(400, "invoiceId is required");
  }

  const invoice = await getInvoice({ tenantId: user.tenantId, invoiceId });
  if (invoice === null) {
    res.status(404).json({ error: "invoice not found" });
    return;
  }

  res.json({ invoice });
}
