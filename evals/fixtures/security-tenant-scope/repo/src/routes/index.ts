/** Route table for the support console API. */
import { Router } from "express";

import { getCustomer } from "./customer-detail.js";
import { getCustomers } from "./customers.js";

export function createRouter(): Router {
  const router = Router();

  router.get("/customers", getCustomers);
  router.get("/customers/:customerId", getCustomer);

  return router;
}
