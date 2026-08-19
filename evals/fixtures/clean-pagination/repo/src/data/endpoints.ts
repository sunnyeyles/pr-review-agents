/** Webhook endpoint reads, always scoped to the caller's tenant. */
import { db } from "../db/pool.js";
import type { RequestContext } from "../http/request-context.js";

export interface Endpoint {
  id: string;
  tenantId: string;
  url: string;
  active: boolean;
}

export async function listEndpoints(ctx: RequestContext): Promise<Endpoint[]> {
  const { rows } = await db.query<Endpoint>(
    `select id, tenant_id as "tenantId", url, active
       from endpoints
      where tenant_id = $1
      order by url asc`,
    [ctx.tenantId],
  );
  return rows;
}
