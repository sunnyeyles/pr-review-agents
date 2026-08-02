# 01 — Monorepo (Turborepo) scaffold with green CI

**What to build:** A developer can clone the repo, run one install command, and get a passing typecheck and test run — locally and in CI. The pnpm workspace contains the webhook app, the worker app, and the shared packages (schemas, github, ai, reviewer) as empty-but-wired packages, with Vitest and TypeScript configured across the workspace and a GitHub Actions workflow that runs install → typecheck → tests on every push. Follows the project structure in spec.md §28.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] `pnpm install` followed by typecheck and test commands succeed from a fresh clone
- [ ] Workspace contains both apps and all four shared packages, each importable from the others where appropriate
- [ ] A trivial placeholder test passes under Vitest in at least one app and one package
- [ ] CI workflow runs install, typecheck, and tests, and is green
