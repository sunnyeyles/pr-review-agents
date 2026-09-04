/**
 * Reading optional files from disk. A missing file is the ordinary case
 * for configuration the caller may or may not have written.
 */
import { readFile } from "node:fs/promises";

/** Reads a file as UTF-8, resolving undefined when it does not exist. */
export async function readOptional(
  filePath: string,
): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
