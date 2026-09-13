/** The commercial tiers a customer account can sit in. */
export type CustomerTier = "standard" | "partner" | "bulk";

/** Tier labels for the quote response and the invoice PDF. */
export const TIER_LABELS: Record<CustomerTier, string> = {
  standard: "Standard",
  partner: "Partner",
  bulk: "Bulk",
};

export function isCustomerTier(value: unknown): value is CustomerTier {
  return typeof value === "string" && value in TIER_LABELS;
}
