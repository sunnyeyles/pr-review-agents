/**
 * The three evaluation fixtures and what each must produce. The clean
 * fixture is what separates a reviewer that finds problems from one
 * that manufactures them.
 */
import type { FixtureExpectation } from "./expectations.js";

/** One fixture and the expectations its review must satisfy. */
export interface EvalCase {
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
  description: "all three review agents complete",
};

export const evalCases: EvalCase[] = [
  {
    fixture: "correctness-admin-check",
    expectations: [
      agentsCompleted,
      {
        kind: "reads-file",
        description:
          "the correctness agent opens the changed route before judging it",
        agent: "correctness",
        file: "src/routes/admin-audit.ts",
        withinFirst: 3,
      },
      {
        kind: "finding",
        description:
          "reports a correctness finding on the admin check that assigns instead of comparing",
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
    fixture: "security-tenant-scope",
    expectations: [
      agentsCompleted,
      {
        kind: "reads-file",
        description:
          "the security agent follows the route into the data layer it calls",
        agent: "security",
        file: "src/data/customers.ts",
      },
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
