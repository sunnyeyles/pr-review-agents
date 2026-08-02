/**
 * @pr-review/config
 *
 * Configuration loading for the Lambda entrypoints.
 *
 * Secrets strategy: Terraform injects the ARN of each Secrets Manager
 * secret as an environment variable named `<NAME>_SECRET_ARN` (for
 * example `GITHUB_WEBHOOK_SECRET_SECRET_ARN`). `resolveSecret` fetches
 * the value from Secrets Manager at runtime when that variable is
 * present, and falls back to the plain `<NAME>` environment variable
 * for local development and tests. Secret values therefore never
 * appear in source control, Terraform files, or Lambda bundles.
 *
 * Entrypoints call `resolveSecret` once during cold start and cache
 * the built handler, so warm invocations do not re-fetch.
 */
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/** Suffix of the environment variable carrying a secret's ARN. */
export const SECRET_ARN_ENV_SUFFIX = "_SECRET_ARN";

/**
 * The slice of the Secrets Manager client this package needs.
 * SecretsManagerClient satisfies it structurally; tests inject a stub
 * so no real AWS calls happen.
 */
export interface SecretsManagerLike {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

export interface ResolveSecretOptions {
  /** Environment to read from; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injectable Secrets Manager client; defaults to a shared real client. */
  client?: SecretsManagerLike;
}

/** Reads a required plain (non-secret) environment variable. */
export function requireEnv(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Created lazily and shared so warm invocations reuse the connection.
let defaultClient: SecretsManagerLike | undefined;

/**
 * Resolves a secret configuration value.
 *
 * If `<name>_SECRET_ARN` is set, the value is fetched from Secrets
 * Manager (the deployed path). Otherwise the plain `<name>` variable
 * is used (local development and tests). Throws if neither is set or
 * the fetched secret has no string value.
 */
export async function resolveSecret(
  name: string,
  options: ResolveSecretOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const arnVariable = `${name}${SECRET_ARN_ENV_SUFFIX}`;
  const secretArn = env[arnVariable];

  if (secretArn) {
    const client = options.client ?? (defaultClient ??= new SecretsManagerClient({}));
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    if (!result.SecretString) {
      throw new Error(`Secret at ${arnVariable} (${secretArn}) has no string value`);
    }
    return result.SecretString;
  }

  const plain = env[name];
  if (plain) {
    return plain;
  }

  throw new Error(
    `Missing configuration for ${name}: set ${arnVariable} to a Secrets Manager ` +
      `ARN (deployed) or ${name} as a plain environment variable (local/test)`,
  );
}
