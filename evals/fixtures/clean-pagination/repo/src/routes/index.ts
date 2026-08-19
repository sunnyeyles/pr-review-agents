/** Route table for the notifications API. */
import { Router } from "express";

import { getDeliveries } from "./deliveries.js";
import { getEndpoints } from "./endpoints.js";

export function createRouter(): Router {
  const router = Router();

  router.get("/deliveries", getDeliveries);
  router.get("/endpoints", getEndpoints);

  return router;
}
