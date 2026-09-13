import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestContext } from "../context.js";
import { findOrderById, listOrderLines } from "../data/orders.js";
import { HttpError } from "../http/errors.js";
import { buildOrderSummary } from "./order-summary.js";

vi.mock("../data/orders.js", () => ({
  findOrderById: vi.fn(),
  listOrderLines: vi.fn(),
}));

const ORDER = {
  id: "order-1",
  tenantId: "tenant-1",
  reference: "INV-1001",
  currency: "EUR",
  placedAt: "2026-02-01T09:12:00Z",
};

const LINES = [
  {
    id: "line-1",
    orderId: "order-1",
    productId: "prod-1",
    sku: "LAMP-01",
    quantity: 2,
    unitPriceMinor: 1500,
  },
  {
    id: "line-2",
    orderId: "order-1",
    productId: "prod-2",
    sku: "TIDY-04",
    quantity: 1,
    unitPriceMinor: 400,
  },
];

const ctx: RequestContext = {
  requestId: "req-1",
  tenantId: "tenant-1",
  actorId: "user-1",
  logger: { debug: vi.fn(), info: vi.fn() },
};

beforeEach(() => {
  vi.mocked(findOrderById).mockResolvedValue(ORDER);
  vi.mocked(listOrderLines).mockResolvedValue(LINES);
});

describe("buildOrderSummary", () => {
  it("totals every line in the order's currency", async () => {
    const summary = await buildOrderSummary(ctx, "order-1");

    expect(summary.reference).toBe("INV-1001");
    expect(summary.total).toEqual({ amountMinor: 3400, currency: "EUR" });
  });

  it("rejects an order this tenant cannot see", async () => {
    vi.mocked(findOrderById).mockResolvedValue(undefined);

    await expect(buildOrderSummary(ctx, "order-9")).rejects.toThrow(HttpError);
  });

  it("returns an empty summary for an order with no lines", async () => {
    vi.mocked(listOrderLines).mockResolvedValue([]);

    const summary = await buildOrderSummary(ctx, "order-1");

    expect(summary.lines).toEqual([]);
    expect(summary.total).toEqual({ amountMinor: 0, currency: "EUR" });
  });
});
