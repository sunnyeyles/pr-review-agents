#!/usr/bin/env bash
#
# SessionStart hook — install node_modules in a fresh worktree.
#
# A worktree carries only tracked files, and node_modules is gitignored, so a
# newly created worktree has no dependencies at all. Nothing in this repo runs
# without them: vitest, tsc and the workspace's own bin scripts all resolve out
# of node_modules, so the first command in a fresh worktree fails in a way that
# reads like a broken checkout rather than a missing install.
#
# .worktreeinclude handles the other half of this problem (.env.local, which is
# gitignored too) — but the copier only moves files, so dependencies need an
# actual install. This runs one, exactly once per worktree.
#
# It acts only when:
#   * the session's cwd is inside a worktree under .claude/worktrees/ (never the
#     main checkout, never a worktree added by hand elsewhere), and
#   * that worktree has no node_modules of its own.
#
# --frozen-lockfile is deliberate: pnpm-lock.yaml is tracked, so it arrives in
# the worktree intact, and a worktree is never the place to resolve new
# versions. A drifted lockfile should fail loudly here rather than be silently
# rewritten in a checkout nobody is watching.
#
# WORKTREE_INSTALL_SKIP=1 disables this entirely.

set -uo pipefail

[ "${WORKTREE_INSTALL_SKIP:-0}" = "1" ] && exit 0
command -v git >/dev/null 2>&1 || exit 0
command -v pnpm >/dev/null 2>&1 || exit 0

# shellcheck source=lib/worktree.sh
. "${BASH_SOURCE[0]%/*}/lib/worktree.sh" 2>/dev/null || exit 0

toplevel=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
repo=$(resolve_repo_root) || exit 0

# Only act inside a worktree under .claude/worktrees/.
case "$toplevel" in
  "$repo"/.claude/worktrees/*) ;;
  *) exit 0 ;;
esac

[ -d "$toplevel/node_modules" ] && exit 0
[ -f "$toplevel/pnpm-lock.yaml" ] || exit 0

if out=$(cd "$toplevel" && pnpm install --frozen-lockfile 2>&1); then
  printf '{"systemMessage":"Installed node_modules in this worktree (fresh checkouts carry none) — see CLAUDE.md"}\n'
else
  # A failed install is worth surfacing: every later command will fail too, and
  # the reason will be much less obvious by then.
  tail=$(printf '%s' "$out" | tail -5 | tr '\n' ' ' | sed 's/"/\\"/g')
  printf '{"systemMessage":"pnpm install failed in this worktree; run it by hand before trusting any command here. %s"}\n' "$tail"
fi
