/**
 * Order discount rules for shipping quotes. Rates are decided here and
 * nowhere else; every rate is capped before it reaches an amount.
 */
import type { CustomerTier } from "./tiers.js";

/** The largest share of a subtotal any order may have discounted. */
export const MAX_DISCOUNT_RATE = 0.25;

/** The flat rate a partner account earns on every order. */
export const PARTNER_RATE = 0.1;

export interface DiscountInput {
  tier: CustomerTier;
  /** Order subtotal in whole cents. */
  subtotalCents: number;
  parcelCount: number;
}

export interface Discount {
  /** Share of the subtotal discounted; never above MAX_DISCOUNT_RATE. */
  rate: number;
  amountCents: number;
  /** Shown to the customer on the quote, so it names the rule that fired. */
  reason: string;
}

function discountOf(rate: number, subtotalCents: number, reason: string): Discount {
  const capped = Math.min(rate, MAX_DISCOUNT_RATE);
  return { rate: capped, amountCents: Math.round(subtotalCents * capped), reason };
}

/** The discount one order earns. */
export function applyDiscount(input: DiscountInput): Discount {
  if (input.parcelCount <= 0) {
    return discountOf(0, input.subtotalCents, "empty order");
  }
  if (input.tier === "partner") {
    return discountOf(PARTNER_RATE, input.subtotalCents, "partner tier");
  }
  return discountOf(0, input.subtotalCents, "standard tier");
}
