import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Vercel injects DATABASE_URL; locally it comes from the nearest .env.local up the tree.
export function loadLocalEnv(): void {
  if (process.env.DATABASE_URL) return;
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, ".env.local");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export function databaseUrl(): string {
  loadLocalEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set; add it to .env.local");
  }
  return url;
}
