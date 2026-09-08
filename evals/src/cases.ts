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

/** Precision on fixes: a proposed patch must match the file it edits. */
const patchesVerify: FixtureExpectation = {
  kind: "patches-verify",
  description: "every patch an agent proposed matches the file at head",
};

export const evalCases: EvalCase[] = [
  {
    fixture: "security-tenant-scope",
    expectations: [
      agentsCompleted,
      patchesVerify,
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
      patchesVerify,
      {
        kind: "no-findings",
        description: "reports no findings at all on correct, idiomatic code",
      },
    ],
  },
];
