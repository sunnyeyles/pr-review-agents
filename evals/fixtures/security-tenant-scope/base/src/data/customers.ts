/**
 * Customer reads for the support console.
 *
 * Every query in this module is scoped to the caller's tenant: the
 * console is used by support staff whose accounts belong to exactly
 * one tenant, and cross-tenant reads are a reportable incident.
 */
import type { Pool } from "pg";

import type { RequestContext } from "../context.js";

export interface CustomerRecord {
  id: string;
  tenantId: string;
  displayName: string;
  email: string;
  plan: string;
  createdAt: string;
}

const CUSTOMER_COLUMNS = `id,
       tenant_id    as "tenantId",
       display_name as "displayName",
       email,
       plan,
       created_at   as "createdAt"`;

/** The tenant's customers, newest first. */
export async function listCustomers(
  ctx: RequestContext,
  db: Pool,
  limit: number,
): Promise<CustomerRecord[]> {
  const { rows } = await db.query<CustomerRecord>(
    `select ${CUSTOMER_COLUMNS}
       from customers
      where tenant_id = $1
      order by created_at desc
      limit $2`,
    [ctx.tenantId, limit],
  );
  return rows;
}

/** Customers whose display name or email matches the search term. */
export async function searchCustomers(
  ctx: RequestContext,
  db: Pool,
  term: string,
): Promise<CustomerRecord[]> {
  const { rows } = await db.query<CustomerRecord>(
    `select ${CUSTOMER_COLUMNS}
       from customers
      where tenant_id = $1
        and (display_name ilike $2 or email ilike $2)
      order by display_name asc
      limit 50`,
    [ctx.tenantId, `%${term}%`],
  );
  return rows;
}
