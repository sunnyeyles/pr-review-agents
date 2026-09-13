/** The commercial tiers a customer account can sit in. */
export type CustomerTier = "standard" | "partner";

/** Tier labels for the quote response and the invoice PDF. */
export const TIER_LABELS: Record<CustomerTier, string> = {
  standard: "Standard",
  partner: "Partner",
};

export function isCustomerTier(value: unknown): value is CustomerTier {
  return typeof value === "string" && value in TIER_LABELS;
}
