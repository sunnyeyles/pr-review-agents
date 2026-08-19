/** The single Postgres pool the data layer shares. */
import { Pool } from "pg";

export const db = new Pool({
  connectionString: process.env["DATABASE_URL"],
  max: 20,
});
