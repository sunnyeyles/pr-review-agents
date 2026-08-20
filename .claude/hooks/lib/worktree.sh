#!/usr/bin/env bash
#
# Shared helpers for the hooks in .claude/hooks/. Sourced, never executed.
#
# Both worktree hooks need the *main* repository root, and both used to derive
# it themselves — cleanup stripping a trailing slash before ".git", repair
# stripping only ".git". That is a latent bug rather than a style difference, so
# the derivation lives here once.

# Absolute path of the main repository root, from anywhere inside it — including
# from a linked worktree, where --show-toplevel would answer with the worktree
# instead. --git-common-dir always resolves to the main repository's .git, which
# is what any git call that has to reason about *other* worktrees needs.
#
# Prints nothing and returns 1 when this is not a git repository.
resolve_repo_root() {
  local common_dir
  common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [ -n "$common_dir" ] || return 1
  common_dir=${common_dir%/}
  common_dir=${common_dir%/.git}
  [ -n "$common_dir" ] || return 1
  printf '%s' "$common_dir"
}
