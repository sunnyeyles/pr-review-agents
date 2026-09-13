import { describe, expect, it } from "vitest";

import { HttpError } from "../http/errors.js";
import {
  ADDITIONAL_KG_CENTS,
  FIRST_KG_CENTS,
  MAX_PARCEL_KG,
  orderRateCents,
  parcelRateCents,
} from "./rates.js";

describe("parcelRateCents", () => {
  it("charges the first-kilogram rate for a parcel under one kilogram", () => {
    expect(parcelRateCents(0.4)).toBe(FIRST_KG_CENTS);
  });

  it("charges a part kilogram as a whole one", () => {
    expect(parcelRateCents(2.1)).toBe(FIRST_KG_CENTS + 2 * ADDITIONAL_KG_CENTS);
  });

  it("rejects a weight that is not a positive number", () => {
    for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parcelRateCents(weight)).toThrow(HttpError);
    }
  });

  it("rejects a parcel over the network maximum", () => {
    expect(() => parcelRateCents(MAX_PARCEL_KG + 1)).toThrow(HttpError);
  });
});

describe("orderRateCents", () => {
  it("sums every parcel in the order", () => {
    expect(orderRateCents([1, 1])).toBe(2 * FIRST_KG_CENTS);
  });

  it("prices an empty order at nothing", () => {
    expect(orderRateCents([])).toBe(0);
  });
});
