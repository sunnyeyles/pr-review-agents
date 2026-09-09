import { defineConfig } from "drizzle-kit";
import { loadLocalEnv } from "./src/env.js";

loadLocalEnv();

// Empty url lets `generate` run without a database; push/migrate need a real one.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
