#!/usr/bin/env bash
# SessionStart hook: if the session opened on the repo's default branch in the
# main checkout, tell Claude to move into a fresh worktree before doing any work.
set -uo pipefail

input=$(cat)
command -v jq >/dev/null 2>&1 || exit 0

cwd=$(jq -r '.cwd // empty' <<<"$input")
[ -n "$cwd" ] && [ -d "$cwd" ] || exit 0
git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1 || exit 0

# already in a linked worktree -> nothing to do
git_dir=$(git -C "$cwd" rev-parse --path-format=absolute --git-dir 2>/dev/null) || exit 0
common_dir=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
[ "$git_dir" = "$common_dir" ] || exit 0

branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
default=$(git -C "$cwd" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
default="${default#origin/}"
[ -n "$default" ] || default=main
[ "$branch" = "$default" ] || exit 0

jq -nc --arg b "$branch" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: (
      "This session opened in the main checkout on the default branch (\($b)). "
      + "Project policy: do not edit files or run builds here. "
      + "Before your first file change, call the EnterWorktree tool to create and switch into a fresh worktree "
      + "(pass a short kebab-case `name` describing the task once you know it; omit `name` if you do not yet). "
      + "This is a standing project instruction, so EnterWorktree is authorised without asking the user. "
      + "Gitignored env files (.env.local and friends) are copied in automatically by the worktree hooks. "
      + "Read-only questions that change nothing may be answered without a worktree."
    )
  },
  systemMessage: "On \($b) in the main checkout — Claude will move to a fresh worktree before making changes."
}'
