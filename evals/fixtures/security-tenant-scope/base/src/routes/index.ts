/** Route table for the support console API. */
import { Router } from "express";

import { getCustomers } from "./customers.js";

export function createRouter(): Router {
  const router = Router();

  router.get("/customers", getCustomers);

  return router;
}
