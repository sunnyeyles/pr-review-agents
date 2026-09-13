/** Route table for the shipping pricing API. */
import { Router } from "express";

import { postQuote } from "./quotes.js";

export function createRouter(): Router {
  const router = Router();

  router.post("/quotes", postQuote);

  return router;
}
