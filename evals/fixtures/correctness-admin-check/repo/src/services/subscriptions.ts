/** Subscription reads, always scoped to a single tenant. */
import { db } from "../db/pool.js";

export interface Subscription {
  id: string;
  tenantId: string;
  plan: string;
  seats: number;
  renewsAt: string;
}

export async function listForTenant(tenantId: string): Promise<Subscription[]> {
  const { rows } = await db.query<Subscription>(
    `select id,
            tenant_id as "tenantId",
            plan,
            seats,
            renews_at as "renewsAt"
       from subscriptions
      where tenant_id = $1
      order by renews_at asc`,
    [tenantId],
  );
  return rows;
}
