/** Read access to the tenant audit trail. */
import { db } from "../db/pool.js";

export interface AuditEvent {
  id: string;
  tenantId: string;
  actorId: string;
  action: string;
  target: string | null;
  createdAt: string;
}

export interface AuditEventQuery {
  tenantId: string;
  limit: number;
}

/** Most recent events first, always scoped to a single tenant. */
export async function listAuditEvents(
  query: AuditEventQuery,
): Promise<AuditEvent[]> {
  const { rows } = await db.query<AuditEvent>(
    `select id,
            tenant_id   as "tenantId",
            actor_id    as "actorId",
            action,
            target,
            created_at  as "createdAt"
       from audit_events
      where tenant_id = $1
      order by created_at desc
      limit $2`,
    [query.tenantId, query.limit],
  );
  return rows;
}
