/** GET /endpoints — the configured webhook endpoints. */
import type { Request, Response } from "express";

import { listEndpoints } from "../data/endpoints.js";
import { requestContext } from "../http/request-context.js";

export async function getEndpoints(req: Request, res: Response): Promise<void> {
  const ctx = requestContext(req);
  const endpoints = await listEndpoints(ctx);
  res.json({ endpoints });
}
