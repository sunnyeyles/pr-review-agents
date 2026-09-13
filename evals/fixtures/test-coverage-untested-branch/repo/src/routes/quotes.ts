/** POST /quotes — price one order for the caller's account. */
import type { Request, Response } from "express";

import { HttpError } from "../http/errors.js";
import { requestContext } from "../http/request-context.js";
import { applyDiscount } from "../pricing/discount.js";
import { orderRateCents } from "../pricing/rates.js";
import { TIER_LABELS } from "../pricing/tiers.js";

/** The most parcels one quote may cover. */
const MAX_PARCELS = 250;

function parcelWeights(body: unknown): number[] {
  const weights = (body as { weightsKg?: unknown } | null)?.weightsKg;
  if (!Array.isArray(weights) || weights.some((weight) => typeof weight !== "number")) {
    throw new HttpError(400, "weightsKg must be an array of numbers");
  }
  if (weights.length === 0 || weights.length > MAX_PARCELS) {
    throw new HttpError(400, `weightsKg must hold 1 to ${MAX_PARCELS} parcels`);
  }
  return weights as number[];
}

export function postQuote(req: Request, res: Response): void {
  const ctx = requestContext(req);
  const weightsKg = parcelWeights(req.body);

  const subtotalCents = orderRateCents(weightsKg);
  const discount = applyDiscount({
    tier: ctx.tier,
    subtotalCents,
    parcelCount: weightsKg.length,
  });

  res.json({
    tier: TIER_LABELS[ctx.tier],
    subtotalCents,
    discount,
    totalCents: subtotalCents - discount.amountCents,
  });
}
