/** The single Postgres pool the data layer shares. */
import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env["DATABASE_URL"],
  max: 20,
});

/** Every read in src/data goes through here. */
export async function query<Row>(sql: string, params: unknown[]): Promise<Row[]> {
  const result = await pool.query<Row>(sql, params);
  return result.rows;
}
