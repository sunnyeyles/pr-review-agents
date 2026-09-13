/**
 * What a repository has done with our findings, aggregated per (category,
 * title shape). The stored file is untrusted: a bad read degrades to empty.
 */
import { httpStatus, type GithubInstallationClient } from "@pr-review/github";
import { errorMessage, type StructuredLogger } from "@pr-review/logging";
import {
  reviewMemorySchema,
  type MemoryShape,
  type ReviewMemory,
} from "@pr-review/schemas";

export type FindingOutcome = "resolved" | "outdated" | "ignored";

export interface FindingSignal {
  category: string;
  title: string;
  outcome: FindingOutcome;
}

/** A shape needs this many ignores, and no resolve, before it earns a hint. */
export const HINT_IGNORED_THRESHOLD = 5;

/** At most this many hints reach the prompt, across every category. */
export const HINT_CAP = 10;

/** A shape with no fresh signal for this long is forgotten. */
export const MEMORY_TTL_DAYS = 90;

const MAX_SHAPE_LENGTH = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Path-, dotted- and camelCase tokens name one call site, not a pattern. */
function isSpecific(token: string): boolean {
  return (
    token.includes("/") ||
    token.includes("_") ||
    /\w\.\w/.test(token) ||
    /[a-z][A-Z]/.test(token)
  );
}

/**
 * The pattern behind a title: identifiers and numbers dropped, so the same
 * problem in two files collapses to one shape.
 */
export function titleShape(title: string): string {
  const general = title.split(/\s+/).filter((token) => !isSpecific(token));
  const shape = general
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SHAPE_LENGTH)
    .trim();
  return shape === "" ? "untitled" : shape;
}

/** The storage seam: one file, read and written by the caller's transport. */
export interface MemoryStore {
  read(): Promise<string | undefined>;
  write(content: string): Promise<void>;
}

export const MEMORY_FILE_PATH = "memory.json";

/** The store the action uses: one JSON file on a branch it owns. */
export function createBranchMemoryStore(
  client: Pick<GithubInstallationClient, "getFileContents" | "writeFileOnBranch">,
  repository: { owner: string; repo: string },
  branch: string,
): MemoryStore {
  return {
    async read() {
      try {
        return await client.getFileContents({
          ...repository,
          path: MEMORY_FILE_PATH,
          ref: branch,
        });
      } catch (error: unknown) {
        if (httpStatus(error) === 404) {
          return undefined;
        }
        throw error;
      }
    },
    write(content) {
      return client.writeFileOnBranch({
        ...repository,
        branch,
        path: MEMORY_FILE_PATH,
        content,
        message: "chore(pr-review-agents): update review memory",
      });
    },
  };
}

export function emptyMemory(): ReviewMemory {
  return { version: 1, shapes: [] };
}

export async function readMemory(
  store: MemoryStore,
  logger: StructuredLogger,
): Promise<ReviewMemory> {
  let raw: string | undefined;
  try {
    raw = await store.read();
  } catch (error) {
    logger.error("memory.invalid", { reason: errorMessage(error) });
    return emptyMemory();
  }
  if (raw === undefined) {
    return emptyMemory();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.error("memory.invalid", { reason: errorMessage(error) });
    return emptyMemory();
  }

  const validated = reviewMemorySchema.safeParse(parsed);
  if (!validated.success) {
    logger.error("memory.invalid", {
      reason: validated.error.issues[0]?.message ?? "does not match the schema",
    });
    return emptyMemory();
  }
  return validated.data;
}

export async function writeMemory(
  store: MemoryStore,
  memory: ReviewMemory,
): Promise<void> {
  await store.write(`${JSON.stringify(memory, null, 2)}\n`);
}

function isFresh(shape: MemoryShape, now: Date): boolean {
  const at = Date.parse(shape.lastSignalAt);
  return Number.isFinite(at) && now.getTime() - at <= MEMORY_TTL_DAYS * DAY_MS;
}

/** Folds signals into the memory and forgets shapes past the TTL. */
export function recordSignals(
  memory: ReviewMemory,
  signals: readonly FindingSignal[],
  now: Date,
): ReviewMemory {
  const byKey = new Map<string, MemoryShape>();
  for (const shape of memory.shapes) {
    byKey.set(`${shape.category}|${shape.shape}`, { ...shape });
  }

  for (const signal of signals) {
    const shape = titleShape(signal.title);
    const key = `${signal.category}|${shape}`;
    const existing = byKey.get(key) ?? {
      category: signal.category,
      shape,
      resolved: 0,
      ignored: 0,
      outdated: 0,
      lastSignalAt: now.toISOString(),
    };
    const updated: MemoryShape = { ...existing, lastSignalAt: now.toISOString() };
    updated[signal.outcome] += 1;
    byKey.set(key, updated);
  }

  return {
    version: 1,
    shapes: [...byKey.values()].filter((shape) => isFresh(shape, now)),
  };
}

function hintSentence(shape: string): string {
  const quoted = shape.replace(/["\r\n]/g, "");
  return `Findings like "${quoted}".`;
}

/** Deprioritise hints per category, most-ignored first, capped overall. */
export function computeHints(
  memory: ReviewMemory,
  now: Date,
): ReadonlyMap<string, readonly string[]> {
  const qualifying = memory.shapes
    .filter(
      (shape) =>
        shape.ignored >= HINT_IGNORED_THRESHOLD &&
        shape.resolved === 0 &&
        isFresh(shape, now),
    )
    .sort((a, b) => b.ignored - a.ignored)
    .slice(0, HINT_CAP);

  const hints = new Map<string, string[]>();
  for (const shape of qualifying) {
    const forCategory = hints.get(shape.category) ?? [];
    forCategory.push(hintSentence(shape.shape));
    hints.set(shape.category, forCategory);
  }
  return hints;
}
