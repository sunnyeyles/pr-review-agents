import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestContext } from "../context.js";
import { findOrderById, listOrderLines } from "../data/orders.js";
import { findProductById, type ProductRecord } from "../data/products.js";
import { HttpError } from "../http/errors.js";
import { buildOrderSummary } from "./order-summary.js";

vi.mock("../data/orders.js", () => ({
  findOrderById: vi.fn(),
  listOrderLines: vi.fn(),
}));

vi.mock("../data/products.js", () => ({
  findProductById: vi.fn(),
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

const PRODUCTS: Record<string, ProductRecord> = {
  "prod-1": {
    id: "prod-1",
    tenantId: "tenant-1",
    sku: "LAMP-01",
    name: "Desk lamp",
    category: "office",
  },
  "prod-2": {
    id: "prod-2",
    tenantId: "tenant-1",
    sku: "TIDY-04",
    name: "Cable tidy",
    category: "office",
  },
};

const ctx: RequestContext = {
  requestId: "req-1",
  tenantId: "tenant-1",
  actorId: "user-1",
  logger: { debug: vi.fn(), info: vi.fn() },
};

beforeEach(() => {
  vi.mocked(findOrderById).mockResolvedValue(ORDER);
  vi.mocked(listOrderLines).mockResolvedValue(LINES);
  vi.mocked(findProductById).mockImplementation(
    async (_ctx, productId: string) => PRODUCTS[productId],
  );
});

describe("buildOrderSummary", () => {
  it("totals every line in the order's currency", async () => {
    const summary = await buildOrderSummary(ctx, "order-1");

    expect(summary.reference).toBe("INV-1001");
    expect(summary.total).toEqual({ amountMinor: 3400, currency: "EUR" });
  });

  it("carries the product name and category on every line", async () => {
    const summary = await buildOrderSummary(ctx, "order-1");

    expect(summary.lines.map((line) => line.productName)).toEqual([
      "Desk lamp",
      "Cable tidy",
    ]);
    expect(summary.lines.map((line) => line.category)).toEqual([
      "office",
      "office",
    ]);
  });

  it("falls back to the sku and uncategorised when a product is gone", async () => {
    vi.mocked(findProductById).mockResolvedValue(undefined);

    const summary = await buildOrderSummary(ctx, "order-1");

    expect(summary.lines.map((line) => line.productName)).toEqual([
      "LAMP-01",
      "TIDY-04",
    ]);
    expect(summary.lines.map((line) => line.category)).toEqual([
      "uncategorised",
      "uncategorised",
    ]);
    expect(summary.total).toEqual({ amountMinor: 3400, currency: "EUR" });
  });

  it("falls back for the one line whose product is gone", async () => {
    vi.mocked(findProductById).mockImplementation(async (_ctx, productId: string) =>
      productId === "prod-2" ? undefined : PRODUCTS[productId],
    );

    const summary = await buildOrderSummary(ctx, "order-1");

    expect(summary.lines.map((line) => line.productName)).toEqual([
      "Desk lamp",
      "TIDY-04",
    ]);
    expect(summary.lines.map((line) => line.category)).toEqual([
      "office",
      "uncategorised",
    ]);
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
    expect(findProductById).not.toHaveBeenCalled();
  });
});
