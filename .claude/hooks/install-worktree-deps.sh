#!/usr/bin/env bash
#
# SessionStart hook — pnpm install --frozen-lockfile the first time a session
# opens in a worktree under .claude/worktrees/ that has no node_modules.
#
# --frozen-lockfile is deliberate: a drifted lockfile should fail loudly rather
# than be rewritten in a checkout nobody is watching.
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
