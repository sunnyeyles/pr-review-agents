#!/usr/bin/env bash
# WorktreeCreate hook: create the git worktree ourselves so we can seed it with
# the gitignored env files (.env.local etc.) that live only in the main checkout.
#
# stdin: {"cwd","worktree_path","branch","detach"}
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
input=$(cat)

fail() { printf '%s\n' "$1" >&2; exit 2; }
decline() {
  # let Claude Code fall back to its own git logic
  jq -nc '{hookSpecificOutput:{hookEventName:"WorktreeCreate",worktreeCreated:false}}'
  exit 0
}

command -v jq >/dev/null 2>&1 || decline

main=$(jq -r '.cwd // empty' <<<"$input")
worktree=$(jq -r '.worktree_path // empty' <<<"$input")
branch=$(jq -r '.branch // empty' <<<"$input")
detach=$(jq -r '.detach // false' <<<"$input")

[ -n "$worktree" ] || decline
[ -n "$main" ] && [ -d "$main" ] || decline
git -C "$main" rev-parse --git-dir >/dev/null 2>&1 || decline

# Mirror the `worktree.baseRef` setting: "fresh" (default) branches from
# origin/<default-branch>, "head" branches from local HEAD.
base_ref=$(
  for f in "$main/.claude/settings.local.json" "$main/.claude/settings.json" "$HOME/.claude/settings.json"; do
    [ -f "$f" ] || continue
    v=$(jq -r '.worktree.baseRef // empty' "$f" 2>/dev/null)
    [ -n "$v" ] && { printf '%s' "$v"; break; }
  done
)
: "${base_ref:=fresh}"

base=HEAD
if [ "$base_ref" != "head" ]; then
  default=$(git -C "$main" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
  if [ -z "$default" ]; then
    for c in origin/main origin/master; do
      git -C "$main" rev-parse --verify --quiet "$c" >/dev/null 2>&1 && { default="$c"; break; }
    done
  fi
  [ -n "$default" ] && base="$default"
fi

mkdir -p "$(dirname "$worktree")" || fail "cannot create $(dirname "$worktree")"

if [ "$detach" = "true" ] || [ -z "$branch" ]; then
  git -C "$main" worktree add --detach "$worktree" "$base" >&2 || fail "git worktree add --detach failed"
elif git -C "$main" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null 2>&1; then
  git -C "$main" worktree add "$worktree" "$branch" >&2 || fail "git worktree add failed"
else
  git -C "$main" worktree add -b "$branch" "$worktree" "$base" >&2 || fail "git worktree add -b failed"
fi

bash "$here/copy-env-to-worktree.sh" "$worktree" "$main"

jq -nc --arg p "$worktree" \
  '{hookSpecificOutput:{hookEventName:"WorktreeCreate",worktreeCreated:true,createdPath:$p}}'
