/** GET /customers — the customer list and search. */
import type { Request, Response } from "express";

import { db } from "../db/pool.js";
import { listCustomers, searchCustomers } from "../data/customers.js";
import { requestContext } from "../http/request-context.js";

const PAGE_SIZE = 50;

export async function getCustomers(req: Request, res: Response): Promise<void> {
  const ctx = requestContext(req);
  const term = req.query["q"];

  const customers =
    typeof term === "string" && term.length > 0
      ? await searchCustomers(ctx, db, term)
      : await listCustomers(ctx, db, PAGE_SIZE);

  res.json({ customers });
}
