/**
 * Order discount rules for shipping quotes. Rates are decided here and
 * nowhere else; every rate is capped before it reaches an amount.
 */
import type { CustomerTier } from "./tiers.js";

/** The largest share of a subtotal any order may have discounted. */
export const MAX_DISCOUNT_RATE = 0.25;

/** The flat rate a partner account earns on every order. */
export const PARTNER_RATE = 0.1;

/** The rate a bulk order earns for each parcel, once it reaches the minimum. */
export const BULK_PARCEL_RATE = 0.01;

/** Parcels a bulk order needs before it earns any discount at all. */
export const BULK_MIN_PARCELS = 10;

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
  if (input.tier === "bulk") {
    if (input.parcelCount < BULK_MIN_PARCELS) {
      return discountOf(0, input.subtotalCents, "bulk tier below the parcel minimum");
    }
    return discountOf(
      BULK_PARCEL_RATE * input.parcelCount,
      input.subtotalCents,
      "bulk tier",
    );
  }
  return discountOf(0, input.subtotalCents, "standard tier");
}
