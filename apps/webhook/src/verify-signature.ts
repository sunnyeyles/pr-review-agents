import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";
const HEX_DIGEST_LENGTH = 64;
const HEX_PATTERN = /^[0-9a-f]+$/i;

export interface VerifyWebhookSignatureInput {
  /** The shared webhook secret configured on the GitHub App. */
  secret: string;
  /** The raw request body bytes exactly as GitHub signed them. */
  payload: Buffer;
  /** The X-Hub-Signature-256 header value, if present. */
  signatureHeader: string | undefined;
}

/**
 * Verifies a GitHub X-Hub-Signature-256 webhook signature using a
 * timing-safe comparison. Returns false for missing or malformed
 * headers rather than throwing.
 */
export function verifyWebhookSignature({
  secret,
  payload,
  signatureHeader,
}: VerifyWebhookSignatureInput): boolean {
  if (!signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (
    providedHex.length !== HEX_DIGEST_LENGTH ||
    !HEX_PATTERN.test(providedHex)
  ) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(payload).digest();
  const provided = Buffer.from(providedHex, "hex");
  return timingSafeEqual(expected, provided);
}
