/** Product catalogue reads. Every query is scoped to the caller's tenant. */
import { query } from "../db/pool.js";
import type { RequestContext } from "../context.js";

export interface ProductRecord {
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  category: string;
}

const PRODUCT_COLUMNS = `id,
       tenant_id as "tenantId",
       sku,
       name,
       category`;

/** One round trip for any number of ids, keyed by id. */
export async function findProductsByIds(
  ctx: RequestContext,
  productIds: readonly string[],
): Promise<Map<string, ProductRecord>> {
  if (productIds.length === 0) {
    return new Map();
  }
  const rows = await query<ProductRecord>(
    `select ${PRODUCT_COLUMNS}
       from products
      where tenant_id = $1
        and id = any($2::uuid[])`,
    [ctx.tenantId, [...new Set(productIds)]],
  );
  return new Map(rows.map((row) => [row.id, row]));
}
