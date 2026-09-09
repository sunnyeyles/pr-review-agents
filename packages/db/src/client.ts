import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { databaseUrl } from "./env.js";
import * as schema from "./schema.js";

export type Database = NeonHttpDatabase<typeof schema>;

let cached: Database | undefined;

// Lazy so importing the package never needs DATABASE_URL; only a query does.
export function db(): Database {
  cached ??= drizzle(neon(databaseUrl()), { schema });
  return cached;
}
