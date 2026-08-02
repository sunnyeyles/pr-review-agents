import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyWebhookSignature } from "./verify-signature.js";

const secret = "test-webhook-secret";
const payload = Buffer.from('{"action":"opened"}', "utf8");

function sign(body: Buffer, key: string): string {
  return `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  it("accepts a correct sha256 signature", () => {
    expect(
      verifyWebhookSignature({
        secret,
        payload,
        signatureHeader: sign(payload, secret),
      }),
    ).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    expect(
      verifyWebhookSignature({
        secret,
        payload,
        signatureHeader: sign(payload, "wrong-secret"),
      }),
    ).toBe(false);
  });

  it("rejects a signature computed over a different payload", () => {
    expect(
      verifyWebhookSignature({
        secret,
        payload,
        signatureHeader: sign(Buffer.from("tampered", "utf8"), secret),
      }),
    ).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(
      verifyWebhookSignature({ secret, payload, signatureHeader: undefined }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({ secret, payload, signatureHeader: "" }),
    ).toBe(false);
  });

  it("rejects a signature without the sha256= prefix", () => {
    const bare = sign(payload, secret).replace("sha256=", "");
    expect(
      verifyWebhookSignature({ secret, payload, signatureHeader: bare }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        secret,
        payload,
        signatureHeader: `sha1=${bare}`,
      }),
    ).toBe(false);
  });

  it("rejects malformed signatures of the wrong length or alphabet", () => {
    expect(
      verifyWebhookSignature({ secret, payload, signatureHeader: "sha256=abc" }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        secret,
        payload,
        signatureHeader: `sha256=${"z".repeat(64)}`,
      }),
    ).toBe(false);
  });
});
