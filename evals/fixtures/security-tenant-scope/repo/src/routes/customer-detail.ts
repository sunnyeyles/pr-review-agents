/** GET /customers/:customerId — the customer detail page. */
import type { Request, Response } from "express";

import { db } from "../db/pool.js";
import { findCustomerById } from "../data/customers.js";
import { HttpError } from "../http/errors.js";
import { requestContext } from "../http/request-context.js";

export async function getCustomer(req: Request, res: Response): Promise<void> {
  const ctx = requestContext(req);

  const customerId = req.params["customerId"];
  if (typeof customerId !== "string" || customerId.length === 0) {
    throw new HttpError(400, "customerId is required");
  }

  const customer = await findCustomerById(ctx, db, customerId);
  if (customer === null) {
    res.status(404).json({ error: "customer not found" });
    return;
  }

  res.json({ customer });
}
