import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";

import { requireEnv, resolveSecret } from "./index.js";

const WEBHOOK_SECRET_ARN =
  "arn:aws:secretsmanager:eu-central-1:123456789012:secret:pr-review/github-webhook-secret-AbCdEf";

describe("requireEnv", () => {
  it("returns the value when the variable is set", () => {
    expect(requireEnv("REVIEW_QUEUE_URL", { REVIEW_QUEUE_URL: "https://sqs/queue" })).toBe(
      "https://sqs/queue",
    );
  });

  it("throws a descriptive error when the variable is missing", () => {
    expect(() => requireEnv("REVIEW_QUEUE_URL", {})).toThrow(/REVIEW_QUEUE_URL/);
  });

  it("throws when the variable is set but empty", () => {
    expect(() => requireEnv("REVIEW_QUEUE_URL", { REVIEW_QUEUE_URL: "" })).toThrow(
      /REVIEW_QUEUE_URL/,
    );
  });
});

describe("resolveSecret", () => {
  it("fetches the value from Secrets Manager when <NAME>_SECRET_ARN is set", async () => {
    const send = vi.fn(async (_command: GetSecretValueCommand) => ({
      SecretString: "from-secrets-manager",
    }));

    const value = await resolveSecret("GITHUB_WEBHOOK_SECRET", {
      env: { GITHUB_WEBHOOK_SECRET_SECRET_ARN: WEBHOOK_SECRET_ARN },
      client: { send },
    });

    expect(value).toBe("from-secrets-manager");
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetSecretValueCommand);
    expect(command?.input.SecretId).toBe(WEBHOOK_SECRET_ARN);
  });

  it("prefers Secrets Manager over a plain environment variable when both are set", async () => {
    const send = vi.fn(async (_command: GetSecretValueCommand) => ({
      SecretString: "from-secrets-manager",
    }));

    const value = await resolveSecret("GITHUB_WEBHOOK_SECRET", {
      env: {
        GITHUB_WEBHOOK_SECRET: "from-plain-env",
        GITHUB_WEBHOOK_SECRET_SECRET_ARN: WEBHOOK_SECRET_ARN,
      },
      client: { send },
    });

    expect(value).toBe("from-secrets-manager");
  });

  it("falls back to the plain environment variable when no secret ARN is set", async () => {
    const send = vi.fn(async (_command: GetSecretValueCommand) => ({
      SecretString: "unused",
    }));

    const value = await resolveSecret("GITHUB_WEBHOOK_SECRET", {
      env: { GITHUB_WEBHOOK_SECRET: "from-plain-env" },
      client: { send },
    });

    expect(value).toBe("from-plain-env");
    expect(send).not.toHaveBeenCalled();
  });

  it("throws when neither the secret ARN nor the plain variable is set", async () => {
    await expect(resolveSecret("GITHUB_WEBHOOK_SECRET", { env: {} })).rejects.toThrow(
      /GITHUB_WEBHOOK_SECRET_SECRET_ARN.*GITHUB_WEBHOOK_SECRET|GITHUB_WEBHOOK_SECRET.*GITHUB_WEBHOOK_SECRET_SECRET_ARN/,
    );
  });

  it("throws when the fetched secret has no string value", async () => {
    const send = vi.fn(async (_command: GetSecretValueCommand) => ({}));

    await expect(
      resolveSecret("GITHUB_WEBHOOK_SECRET", {
        env: { GITHUB_WEBHOOK_SECRET_SECRET_ARN: WEBHOOK_SECRET_ARN },
        client: { send },
      }),
    ).rejects.toThrow(/no string value/i);
  });

  it("propagates Secrets Manager errors", async () => {
    const send = vi.fn(async (_command: GetSecretValueCommand) => {
      throw new Error("AccessDeniedException");
    });

    await expect(
      resolveSecret("GITHUB_WEBHOOK_SECRET", {
        env: { GITHUB_WEBHOOK_SECRET_SECRET_ARN: WEBHOOK_SECRET_ARN },
        client: { send },
      }),
    ).rejects.toThrow("AccessDeniedException");
  });
});
