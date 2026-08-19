/** Webhook delivery reads, always scoped to the caller's tenant. */
import { db } from "../db/pool.js";
import type { RequestContext } from "../http/request-context.js";

export interface Delivery {
  id: string;
  tenantId: string;
  endpointId: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  createdAt: string;
}

export interface DeliveryPage {
  limit: number;
  offset: number;
}

export async function listDeliveries(
  ctx: RequestContext,
  page: DeliveryPage,
): Promise<Delivery[]> {
  const { rows } = await db.query<Delivery>(
    `select id,
            tenant_id   as "tenantId",
            endpoint_id as "endpointId",
            status,
            attempts,
            created_at  as "createdAt"
       from deliveries
      where tenant_id = $1
      order by created_at desc
      limit $2
     offset $3`,
    [ctx.tenantId, page.limit, page.offset],
  );
  return rows;
}
