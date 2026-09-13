/** Base carriage rates, before any discount. */
import { HttpError } from "../http/errors.js";

/** Cents charged for the first kilogram of a parcel. */
export const FIRST_KG_CENTS = 850;

/** Cents charged for every kilogram after the first. */
export const ADDITIONAL_KG_CENTS = 120;

/** The heaviest parcel the network accepts. */
export const MAX_PARCEL_KG = 30;

/** The base price of one parcel, in whole cents. */
export function parcelRateCents(weightKg: number): number {
  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    throw new HttpError(400, "weightKg must be a positive number");
  }
  if (weightKg > MAX_PARCEL_KG) {
    throw new HttpError(400, `weightKg must not exceed ${MAX_PARCEL_KG}`);
  }
  const additional = Math.ceil(weightKg) - 1;
  return FIRST_KG_CENTS + additional * ADDITIONAL_KG_CENTS;
}

/** The base price of a whole order. */
export function orderRateCents(weightsKg: readonly number[]): number {
  return weightsKg.reduce((total, weight) => total + parcelRateCents(weight), 0);
}
