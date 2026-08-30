# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Work in a worktree

**Before making any code change, call `EnterWorktree` and work there.** Do not
edit files in the main checkout. `EnterWorktree` is opt-in by design — it acts
only on an explicit instruction from the user or from this file — so this
paragraph is what turns it on for this repo.

The exceptions are narrow, and they are about the change not being code:
answering a question, reading the tree, or editing this file and the hooks under
`.claude/` that implement the workflow below. A session already pinned to a
directory (a background job, or a subagent launched with an explicit cwd) cannot
move, and should say so rather than silently editing the main checkout.

Worktrees live at `.claude/worktrees/<name>`, gitignored, one per branch.

**A fresh worktree is not a usable checkout on its own** — it carries tracked
files and nothing else. Two gitignored things it needs arrive automatically:

- `.env.local`, via `.worktreeinclude`. That file lists gitignored paths for the
  worktree copier to bring across. It copies file _content_ — a symlink listed
  there never arrives, so keep the entries pointing at real files.
- `node_modules`, via `.claude/hooks/install-worktree-deps.sh`, a `SessionStart`
  hook that runs `pnpm install --frozen-lockfile` the first time a session opens
  in a worktree that has none. `--frozen-lockfile` is deliberate: a worktree is
  never the place to resolve new versions, and a drifted `pnpm-lock.yaml` should
  fail loudly rather than be rewritten in a checkout nobody is watching. Set
  `WORKTREE_INSTALL_SKIP=1` to disable it.

The install runs at session start, so it does **not** cover a worktree created
mid-session — the hook fires on the next session there. If a command fails on a
missing module in a worktree you just made, run `pnpm install` rather than
treating it as a regression.

Because worktrees sit _inside_ the main checkout, pnpm walks up to the outer
`pnpm-workspace.yaml` and warns about multiple lockfiles. That warning is how
you tell a worktree run from a main-checkout one; it is not a problem.

**A `SessionEnd` hook deletes worktrees whose work is already published.**
`.claude/hooks/cleanup-merged-worktrees.sh` removes a checkout under
`.claude/worktrees/` and its local branch once every commit it holds exists
somewhere else — on the default branch, on a remote branch, or as the head of a
pull request GitHub still knows about. An unpushed commit satisfies none of
those, and it is the one thing the hook must never destroy; uncommitted changes
and a live `claude` process holding the worktree also make it refuse. Being
unable to reach GitHub is always a reason to keep, never to remove.

The evidence is graded. A pull request sitting on exactly this tip is **strong**
and collects immediately. Merely being contained in the default branch, or on
some remote ref, is **weak** — true of a brand-new worktree that has not been
committed to yet — and collects only after `WORKTREE_CLEANUP_MIN_IDLE_HOURS`
(72) of inactivity. Every decision is logged with a reason to
`~/.claude/worktree-cleanup.log`. `WORKTREE_CLEANUP_DRY_RUN=1` removes nothing.
The ladder is tested by `bash .claude/hooks/cleanup-merged-worktrees.test.sh`,
run by hand — it builds throwaway repos and stubs `gh` on `PATH`, so it is not
part of `pnpm test`.

Worktrees outside `.claude/worktrees/` are never touched.

## Comments

Keep code comments minimal: 1–2 lines at most, only when the code isn't self-explanatory. No long explanatory blocks, no ticket references (PROD-XXXX, #issue) in comments.

Inline comments should be concise. Use them for important, non-obvious facts about the code at hand. Avoid comments that:

- restate the code, repeat a type signature, or describe a general API contract;
- document old behavior, rejected alternatives, or the history of the change (that belongs in the PR body or commit message);
- explain API usage that belongs with the API definition instead of this call site.

Rewrite a stale comment instead of adding a new one beside it. If a fact applies generally, document it at the definition.

## Commands

```bash
pnpm test          # vitest run
pnpm typecheck     # pnpm -r typecheck
pnpm build         # pnpm -r build
pnpm eval          # vitest run --config evals/vitest.eval.config.ts
```
