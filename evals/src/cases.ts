/**
 * The evaluation suite: the three fixtures of spec §27 and what each
 * one must produce.
 *
 * The set is fixed by the spec, and the third fixture is the reason
 * the other two are not enough. A reviewer that reports something on
 * every pull request will pass the correctness and security fixtures
 * by accident; only the clean fixture separates a reviewer that finds
 * problems from one that manufactures them.
 */
import type { FixtureExpectation } from "./expectations.js";

/** One fixture and the expectations its review must satisfy. */
export interface EvalCase {
  /** Fixture directory name under evals/fixtures. */
  fixture: string;
  expectations: FixtureExpectation[];
}

/**
 * Every review is expected to complete all three lenses. A failed
 * agent is a degraded review — the pipeline correctly publishes what
 * the others found — but it makes the fixture's real expectation
 * unmeasurable, so it is reported as its own failure rather than
 * left to look like a quality result.
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
