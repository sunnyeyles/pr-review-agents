/** Order reads. Every query is scoped to the caller's tenant. */
import { query } from "../db/pool.js";
import type { RequestContext } from "../context.js";

export interface OrderRecord {
  id: string;
  tenantId: string;
  reference: string;
  currency: string;
  placedAt: string;
}

export interface OrderLineRecord {
  id: string;
  orderId: string;
  productId: string;
  sku: string;
  quantity: number;
  unitPriceMinor: number;
}

export async function findOrderById(
  ctx: RequestContext,
  orderId: string,
): Promise<OrderRecord | undefined> {
  const rows = await query<OrderRecord>(
    `select id,
            tenant_id as "tenantId",
            reference,
            currency,
            placed_at as "placedAt"
       from orders
      where tenant_id = $1
        and id = $2`,
    [ctx.tenantId, orderId],
  );
  return rows[0];
}

/** The lines of one order, in the order they were added. */
export async function listOrderLines(
  ctx: RequestContext,
  orderId: string,
): Promise<OrderLineRecord[]> {
  return query<OrderLineRecord>(
    `select id,
            order_id         as "orderId",
            product_id       as "productId",
            sku,
            quantity,
            unit_price_minor as "unitPriceMinor"
       from order_lines
      where tenant_id = $1
        and order_id = $2
      order by position asc`,
    [ctx.tenantId, orderId],
  );
}
