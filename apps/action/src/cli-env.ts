/**
 * Plumbing both `apps/action` commands need. It lives here rather than in
 * either command so neither has to import the other.
 */
import {
  DEFAULT_LANGFUSE_BASE_URL,
  type LangfusePromptClientConfig,
} from "@pr-review/ai";

/** Environment variables the Langfuse commands authenticate with. */
export const PUBLIC_KEY_ENV = "LANGFUSE_PUBLIC_KEY";
export const SECRET_KEY_ENV = "LANGFUSE_SECRET_KEY";
export const BASE_URL_ENV = "LANGFUSE_BASE_URL";

/** Exit code for a usage or credentials problem, before anything ran. */
export const USAGE_EXIT_CODE = 2;

export interface MissingCredentials {
  /** What the keys are needed for, completing "must both be set to …". */
  purpose: string;
  /** Why both keys, and what did not happen without them. */
  rationale: string[];
  /** The command to re-run once they are set. */
  command: string;
}

export function missingCredentialsMessage({
  purpose,
  rationale,
  command,
}: MissingCredentials): string {
  return [
    `${PUBLIC_KEY_ENV} and ${SECRET_KEY_ENV} must both be set to ${purpose}.`,
    "",
    ...rationale,
    "",
    "Set them in the environment or in .env.local (gitignored) and re-run:",
    "",
    `  ${PUBLIC_KEY_ENV}=…`,
    `  ${SECRET_KEY_ENV}=…`,
    `  ${BASE_URL_ENV}=…      # optional; defaults to ${DEFAULT_LANGFUSE_BASE_URL}`,
    "",
    `  ${command}`,
  ].join("\n");
}

export function requireLangfuseConfig(
  env: Record<string, string | undefined>,
  missing: string,
): LangfusePromptClientConfig {
  const publicKey = env[PUBLIC_KEY_ENV]?.trim() ?? "";
  const secretKey = env[SECRET_KEY_ENV]?.trim() ?? "";
  if (publicKey === "" || secretKey === "") {
    throw new Error(missing);
  }
  const baseUrl = env[BASE_URL_ENV]?.trim() ?? "";
  return {
    publicKey,
    secretKey,
    baseUrl: baseUrl === "" ? DEFAULT_LANGFUSE_BASE_URL : baseUrl,
  };
}

/** Reads `--flag value`; the caller advances past the value it consumed. */
export function takeValue(
  argv: string[],
  index: number,
  flag: string,
  example: string,
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} needs a value, for example ${flag} ${example}`);
  }
  return value;
}
