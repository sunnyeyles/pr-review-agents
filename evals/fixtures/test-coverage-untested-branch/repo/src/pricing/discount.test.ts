import { describe, expect, it } from "vitest";

import { applyDiscount, MAX_DISCOUNT_RATE, PARTNER_RATE } from "./discount.js";

describe("applyDiscount", () => {
  it("gives a standard order no discount", () => {
    expect(applyDiscount({ tier: "standard", subtotalCents: 50_000, parcelCount: 4 })).toEqual({
      rate: 0,
      amountCents: 0,
      reason: "standard tier",
    });
  });

  it("gives a partner order the partner rate", () => {
    expect(applyDiscount({ tier: "partner", subtotalCents: 50_000, parcelCount: 4 })).toEqual({
      rate: PARTNER_RATE,
      amountCents: 5_000,
      reason: "partner tier",
    });
  });

  it("gives an order with no parcels no discount, whatever the tier", () => {
    for (const tier of ["standard", "partner"] as const) {
      expect(applyDiscount({ tier, subtotalCents: 50_000, parcelCount: 0 })).toEqual({
        rate: 0,
        amountCents: 0,
        reason: "empty order",
      });
    }
  });

  it("rounds the discount to whole cents", () => {
    const discount = applyDiscount({
      tier: "partner",
      subtotalCents: 1_235,
      parcelCount: 2,
    });

    expect(discount.amountCents).toBe(124);
  });

  it("never discounts more than the maximum rate", () => {
    const discount = applyDiscount({
      tier: "partner",
      subtotalCents: 100_000,
      parcelCount: 1,
    });

    expect(discount.rate).toBeLessThanOrEqual(MAX_DISCOUNT_RATE);
  });
});
