#!/usr/bin/env bash
# CwdChanged hook: when the session moves into a linked worktree (e.g. via
# EnterWorktree), make sure the gitignored env files are there. No-op otherwise.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
input=$(cat)
command -v jq >/dev/null 2>&1 || exit 0

cwd=$(jq -r '.cwd // empty' <<<"$input")
[ -n "$cwd" ] && [ -d "$cwd" ] || exit 0

git_dir=$(git -C "$cwd" rev-parse --path-format=absolute --git-dir 2>/dev/null) || exit 0
common_dir=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
# in the main checkout git-dir == git-common-dir; in a linked worktree they differ
[ "$git_dir" != "$common_dir" ] || exit 0

bash "$here/copy-env-to-worktree.sh" "$cwd" "$(dirname "$common_dir")"
exit 0
