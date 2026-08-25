#!/usr/bin/env bash
# Copy gitignored env files (.env, .env.local, ...) from the main repo checkout
# into a worktree. Idempotent: never overwrites a file that already exists.
#
# Usage: copy-env-to-worktree.sh <worktree_path> [main_repo_path]
set -uo pipefail

worktree="${1:-}"
[ -n "$worktree" ] && [ -d "$worktree" ] || exit 0

main="${2:-}"
if [ -z "$main" ]; then
  common_dir=$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
  main=$(dirname "$common_dir")
fi
[ -d "$main" ] || exit 0
[ "$(cd "$main" && pwd -P)" != "$(cd "$worktree" && pwd -P)" ] || exit 0

copied=()
while IFS= read -r -d '' src; do
  rel="${src#"$main"/}"
  # skip anything git actually tracks (templates like .env.example live in the branch)
  git -C "$main" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1 && continue
  dest="$worktree/$rel"
  [ -e "$dest" ] && continue
  mkdir -p "$(dirname "$dest")" || continue
  cp -p "$src" "$dest" 2>/dev/null && copied+=("$rel")
done < <(
  find "$main" \
    \( -name node_modules -o -name .git -o -path "$main/.claude/worktrees" -o -name dist -o -name .next \) -prune -o \
    -type f -name '.env*' -print0 2>/dev/null
)

if [ ${#copied[@]} -gt 0 ]; then
  printf 'copied env files into worktree: %s\n' "$(IFS=', '; echo "${copied[*]}")" >&2
fi
exit 0
