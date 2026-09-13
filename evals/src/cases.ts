/**
 * The evaluation fixtures and what each must produce. The clean fixture
 * separates a reviewer that finds problems from one that invents them.
 */
import type { FixtureExpectation } from "./expectations.js";

/** One fixture and the expectations its review must satisfy. */
interface EvalCase {
  /** Fixture directory name under evals/fixtures. */
  fixture: string;
  expectations: FixtureExpectation[];
}

/**
 * A failed agent makes the fixture's real expectation unmeasurable, so
 * it is reported separately rather than as a quality result.
 */
const agentsCompleted: FixtureExpectation = {
  kind: "agents-completed",
  description: "every review agent completes",
};

export const evalCases: EvalCase[] = [
  {
    fixture: "security-tenant-scope",
    expectations: [
      agentsCompleted,
      {
        kind: "finding",
        description:
          "reports a security finding on the customer query that never validates the tenant",
        category: "security",
        anchors: [
          {
            file: "src/data/customers.ts",
            startMarker: "export async function findCustomerById",
          },
          {
            file: "src/routes/customer-detail.ts",
            startMarker: "export async function getCustomer",
          },
        ],
      },
    ],
  },
  {
    fixture: "correctness-admin-check",
    expectations: [
      agentsCompleted,
      {
        kind: "finding",
        description:
          "reports a correctness finding on the since filter, which keeps the events before the timestamp instead of the events after it",
        category: "correctness",
        anchors: [
          {
            file: "src/routes/admin-audit.ts",
            startMarker: "export async function getAuditEvents",
          },
        ],
      },
    ],
  },
  {
    fixture: "test-coverage-untested-branch",
    expectations: [
      agentsCompleted,
      {
        kind: "finding",
        description:
          "reports a test-coverage finding on the new bulk tier branch the untouched discount test never exercises",
        category: "test-coverage",
        anchors: [
          {
            file: "src/pricing/discount.ts",
            startMarker: "export const BULK_PARCEL_RATE",
          },
          {
            file: "src/pricing/discount.ts",
            startMarker: "export function applyDiscount",
          },
        ],
      },
    ],
  },
  {
    fixture: "performance-n-plus-one",
    expectations: [
      agentsCompleted,
      {
        kind: "finding",
        description:
          "reports a performance finding on the summary loop that queries one product per order line",
        category: "performance",
        anchors: [
          {
            file: "src/services/order-summary.ts",
            startMarker: "export async function buildOrderSummary",
          },
        ],
      },
    ],
  },
  {
    fixture: "clean-pagination",
    expectations: [
      agentsCompleted,
      {
        kind: "no-findings",
        description: "reports no findings at all on correct, idiomatic code",
      },
    ],
  },
];
