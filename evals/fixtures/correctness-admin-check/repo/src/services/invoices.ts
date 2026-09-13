/** Invoice reads, always scoped to a single tenant. */
import { db } from "../db/pool.js";

export interface Invoice {
  id: string;
  tenantId: string;
  amountCents: number;
  currency: string;
  issuedAt: string;
}

export interface InvoiceQuery {
  tenantId: string;
  invoiceId: string;
}

export async function getInvoice(query: InvoiceQuery): Promise<Invoice | null> {
  const { rows } = await db.query<Invoice>(
    `select id,
            tenant_id    as "tenantId",
            amount_cents as "amountCents",
            currency,
            issued_at    as "issuedAt"
       from invoices
      where tenant_id = $1
        and id = $2`,
    [query.tenantId, query.invoiceId],
  );
  return rows[0] ?? null;
}
