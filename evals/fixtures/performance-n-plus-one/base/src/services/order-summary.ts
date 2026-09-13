/** The order summary payload the order detail page renders. */
import type { RequestContext } from "../context.js";
import { findOrderById, listOrderLines } from "../data/orders.js";
import { HttpError } from "../http/errors.js";
import { multiply, sum, type Money } from "../money.js";

export interface SummaryLine {
  lineId: string;
  sku: string;
  quantity: number;
  lineTotal: Money;
}

export interface OrderSummary {
  orderId: string;
  reference: string;
  lines: SummaryLine[];
  total: Money;
}

export async function buildOrderSummary(
  ctx: RequestContext,
  orderId: string,
): Promise<OrderSummary> {
  const order = await findOrderById(ctx, orderId);
  if (order === undefined) {
    throw new HttpError(404, "order not found");
  }

  const lines = await listOrderLines(ctx, orderId);

  const summaryLines: SummaryLine[] = lines.map((line) => ({
    lineId: line.id,
    sku: line.sku,
    quantity: line.quantity,
    lineTotal: multiply(
      { amountMinor: line.unitPriceMinor, currency: order.currency },
      line.quantity,
    ),
  }));

  ctx.logger.info("order.summary.built", { orderId, lineCount: summaryLines.length });

  return {
    orderId: order.id,
    reference: order.reference,
    lines: summaryLines,
    total: sum(
      summaryLines.map((line) => line.lineTotal),
      order.currency,
    ),
  };
}
