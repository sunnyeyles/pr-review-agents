#!/usr/bin/env bash
#
# SessionEnd hook — garbage-collect the worktrees whose work is already published.
#
# Claude Code leaves a worktree under .claude/worktrees/ behind whenever a
# session is kept rather than discarded, so they accumulate long after the work
# they held has been reviewed and merged. This removes such a worktree and its
# local branch once every commit it holds exists somewhere else.
#
# "Somewhere else" is the whole of the safety argument, so it is worth being
# precise about it. A commit is published when it is contained in the default
# branch, when some remote-tracking ref contains it, or when it is the head of a
# pull request GitHub still knows about. Any one of those means the work can be
# got back after this script deletes it. An unpushed commit satisfies none of
# them, and it is the only thing here that cannot be got back — so it is the one
# thing this script must never destroy.
#
# The evidence is graded, because not all of it means the same thing:
#
#   * STRONG — a pull request sits on exactly this commit. Merged is the obvious
#     case; open counts too, since a review is answered from a fresh
#     `gh pr checkout` and holding the original checkout open buys nothing.
#     Collected immediately.
#   * WEAK — the tip is merely contained in the default branch, or merely on
#     some remote ref. True of a brand-new worktree that has not been committed
#     to yet, which sits at the default branch tip and is therefore trivially
#     "published" while being exactly the thing you are about to work in. Weak
#     evidence collects only after WORKTREE_CLEANUP_MIN_IDLE_HOURS of inactivity.
#
# Idleness is read from the mtime of .git/worktrees/<id>/index, not from the
# admin directory, whose mtime `git worktree list` touches on every run.
#
# Beyond that it refuses a worktree a live claude process holds, one with
# uncommitted changes, and one whose state it could not determine at all —
# being unable to reach GitHub is a reason to keep, never a reason to remove.
#
# The pull-request index is keyed by head SHA as well as by head-ref name, and
# that is load-bearing rather than a nicety. A local branch name and the head-ref
# name of its pull request are not always equal, so a name-only lookup leaves
# such a worktree immortal. And because this repo squash-merges (RELEASING.md),
# a merged branch's tip is never an ancestor of the default branch; once the
# upstream branch is deleted and `fetch --prune` drops its remote-tracking ref,
# the pull request's head SHA is the *only* surviving evidence that the work
# reached GitHub. Never reduce the gate to the two local checks.
#
# Everything it decides — keep or remove — is logged with a reason.
#
# Log:   ~/.claude/worktree-cleanup.log  (override with WORKTREE_CLEANUP_LOG)
# Tests: .claude/hooks/cleanup-merged-worktrees.test.sh
#
# Options, as flags for a manual run or environment variables for the hook path
# (settings.json invokes this with no arguments, so flags alone are unreachable
# there):
#
#   --dry-run       WORKTREE_CLEANUP_DRY_RUN=1        log decisions, remove nothing
#   --no-fetch      WORKTREE_CLEANUP_NO_FETCH=1       skip the pre-pass fetch
#   --conservative  WORKTREE_CLEANUP_GATE=pr          require a finished pull request
#                   WORKTREE_CLEANUP_MIN_IDLE_HOURS   idle window for weak evidence (72)
#                   WORKTREE_CLEANUP_LOG              log file path

set -uo pipefail

log_file="${WORKTREE_CLEANUP_LOG:-$HOME/.claude/worktree-cleanup.log}"
dry_run=${WORKTREE_CLEANUP_DRY_RUN:-0}
no_fetch=${WORKTREE_CLEANUP_NO_FETCH:-0}
gate=${WORKTREE_CLEANUP_GATE:-published}
min_idle_hours=${WORKTREE_CLEANUP_MIN_IDLE_HOURS:-72}
pr_limit=${WORKTREE_CLEANUP_PR_LIMIT:-200}
log_max=${WORKTREE_CLEANUP_LOG_MAX:-2000}
log_keep=${WORKTREE_CLEANUP_LOG_KEEP:-500}

for arg in "$@"; do
  case "$arg" in
  --dry-run) dry_run=1 ;;
  --no-fetch) no_fetch=1 ;;
  --conservative) gate=pr ;;
  esac
done

min_idle_seconds=$((min_idle_hours * 3600))

say() {
  mkdir -p "$(dirname "$log_file")" 2>/dev/null
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >>"$log_file"
}

# Trim the log rather than let it grow forever — it is a file the user greps.
# Temp-and-rename, never `printf '%s' "$(tail …)" >"$log"`, so a kill mid-write
# cannot truncate it to nothing.
rotate_log() {
  [ -f "$log_file" ] || return 0
  local lines tmp
  lines=$(wc -l <"$log_file" 2>/dev/null | tr -d ' ') || return 0
  [ -n "$lines" ] || return 0
  [ "$lines" -gt "$log_max" ] 2>/dev/null || return 0
  tmp="$log_file.tmp.$$"
  if tail -n "$log_keep" "$log_file" >"$tmp" 2>/dev/null; then
    mv "$tmp" "$log_file" 2>/dev/null || rm -f "$tmp"
  else
    rm -f "$tmp"
  fi
}

command -v git >/dev/null 2>&1 || exit 0

# shellcheck source=lib/worktree.sh
. "${BASH_SOURCE[0]%/*}/lib/worktree.sh" 2>/dev/null || exit 0

repo=$(resolve_repo_root) || exit 0
worktree_root="$repo/.claude/worktrees"
[ -d "$worktree_root" ] || exit 0

default_ref=$(git -C "$repo" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null)
default_ref=${default_ref:-refs/remotes/origin/main}
default_name=${default_ref#refs/remotes/}

# ---------------------------------------------------------------- pull requests

pr_index_status=unavailable
pr_rows=""
pr_state=""
pr_oid=""

# One query for the whole run. The previous shape asked `gh pr list --head` once
# per worktree, which is both slower and unable to see a pull request whose head
# ref is named differently from the local branch.
load_pr_index() {
  local out rc count
  command -v gh >/dev/null 2>&1 || {
    say "note: gh is not installed — falling back to local git evidence only"
    return 0
  }
  out=$(cd "$repo" && gh pr list --state all --limit "$pr_limit" \
    --json state,headRefName,headRefOid \
    --jq '.[] | "\(.state)\t\(.headRefName)\t\(.headRefOid)"' 2>/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    say "note: gh pr list failed (exit $rc) — falling back to local git evidence only"
    return 0
  fi
  pr_rows=$out
  pr_index_status=ok
  count=0
  [ -n "$pr_rows" ] && count=$(printf '%s\n' "$pr_rows" | wc -l | tr -d ' ')
  if [ "$count" -ge "$pr_limit" ]; then
    say "warning: the pull request index hit its limit of $pr_limit rows — older pull requests are invisible to this run"
  fi
}

# Sets pr_state and pr_oid. Returns 1 when the index holds nothing for this
# worktree, which is not the same as the index being unavailable — the caller
# distinguishes those, because one means "no pull request" and the other means
# "we could not ask".
pr_lookup() {
  local branch=$1 sha=$2 row
  pr_state=""
  pr_oid=""
  [ "$pr_index_status" = ok ] || return 1
  [ -n "$pr_rows" ] || return 1

  if [ -n "$branch" ]; then
    # A branch can carry more than one pull request over its life. One sitting
    # on exactly this tip settles it; otherwise prefer a merged one.
    row=$(printf '%s\n' "$pr_rows" | awk -F'\t' -v b="$branch" -v s="$sha" '
      $2 == b {
        if ($3 == s) { print; exit }
        if (best == "" || ($1 == "MERGED" && best_state != "MERGED")) { best = $0; best_state = $1 }
      }
      END { if (best != "") print best }')
    if [ -n "$row" ]; then
      pr_state=${row%%$'\t'*}
      pr_oid=${row##*$'\t'}
      return 0
    fi
  fi

  # Fall back to the head SHA, which is what finds a pull request opened from a
  # differently-named remote branch. Restricted to finished pull requests: an
  # open one's head can legitimately be shared by a branch cut from it, and
  # attributing that PR to this worktree would be wrong.
  if [ -n "$sha" ]; then
    row=$(printf '%s\n' "$pr_rows" | awk -F'\t' -v s="$sha" '$3 == s && $1 != "OPEN" { print; exit }')
    if [ -n "$row" ]; then
      pr_state=${row%%$'\t'*}
      pr_oid=${row##*$'\t'}
      return 0
    fi
  fi

  return 1
}

# ---------------------------------------------------------------------- gates
#
# Both gates share one contract: return 0 published, 1 not published, 2 unknown,
# and set publish_reason (always) and publish_strength (when returning 0). That
# is what lets WORKTREE_CLEANUP_GATE swap them at a single call site.

publish_reason=""
publish_strength=""

tip_is_published() {
  local branch=$1 head=$2 have_pr=1 remote_ref
  publish_reason=""
  publish_strength=""

  if pr_lookup "$branch" "$head"; then
    have_pr=0
  fi

  # Strong: a pull request sitting on exactly this commit.
  if [ "$have_pr" -eq 0 ] && [ "$pr_oid" = "$head" ]; then
    case "$pr_state" in
    MERGED)
      publish_reason="merged pull request at this exact tip"
      publish_strength=strong
      return 0
      ;;
    OPEN)
      publish_reason="open pull request at this exact tip"
      publish_strength=strong
      return 0
      ;;
    CLOSED)
      # Closing merged nothing, so a closed pull request is only evidence if
      # the commits reached the default branch by some other route.
      if git -C "$repo" merge-base --is-ancestor "$head" "$default_ref" 2>/dev/null; then
        publish_reason="pull request was closed, but the tip reached $default_name anyway"
        publish_strength=strong
        return 0
      fi
      ;;
    esac
  fi

  # Weak: the commit is reachable from something on the remote, but nothing says
  # this worktree is finished with. A fresh worktree lands here.
  if git -C "$repo" merge-base --is-ancestor "$head" "$default_ref" 2>/dev/null; then
    publish_reason="tip is contained in $default_name"
    publish_strength=weak
    return 0
  fi

  remote_ref=$(git -C "$repo" branch -r --contains "$head" --format '%(refname:short)' 2>/dev/null |
    grep -v '^origin/HEAD$' | head -n 1)
  if [ -n "$remote_ref" ]; then
    publish_reason="tip is on $remote_ref"
    publish_strength=weak
    return 0
  fi

  # A pull request exists but sits elsewhere, and no remote ref reaches this
  # tip: there are commits here that only this worktree has.
  if [ "$have_pr" -eq 0 ]; then
    publish_reason="pull request head is ${pr_oid:0:8} but the tip is ${head:0:8}, which no remote has seen"
    return 1
  fi

  if [ "$pr_index_status" != ok ]; then
    publish_reason="gh is unavailable and the tip is on no known remote ref"
    return 2
  fi

  publish_reason="no remote ref and no pull request contains this tip"
  return 1
}

# The pre-existing semantics, kept behind WORKTREE_CLEANUP_GATE=pr as the escape
# hatch if the looser gate ever misbehaves.
pr_is_finished() {
  local branch=$1 head=$2
  publish_reason=""
  publish_strength=""

  if ! pr_lookup "$branch" "$head"; then
    if [ "$pr_index_status" != ok ]; then
      publish_reason="gh is unavailable, so no pull request could be checked"
      return 2
    fi
    publish_reason="no pull request found for this worktree"
    return 1
  fi

  if [ "$pr_state" = OPEN ]; then
    publish_reason="its pull request is still open"
    return 1
  fi

  if [ "$pr_oid" != "$head" ]; then
    publish_reason="pull request head is ${pr_oid:0:8} but the tip is ${head:0:8}"
    return 1
  fi

  if [ "$pr_state" = CLOSED ] &&
    ! git -C "$repo" merge-base --is-ancestor "$head" "$default_ref" 2>/dev/null; then
    publish_reason="pull request was closed and the tip never reached $default_name"
    return 1
  fi

  publish_reason="finished pull request at this exact tip"
  publish_strength=strong
  return 0
}

# ------------------------------------------------------------------ liveness

lock_detail=""

# A lock reason looks like: claude session <name> (pid 81567 start <date>).
# Returns 0 when a live claude process holds it. The ps check may only ever
# demote a live pid — a dead pid is never promoted to held.
session_holds_lock() {
  local lock_line=$1 pid comm
  lock_detail=""
  pid=$(printf '%s' "$lock_line" | sed -n 's/.*(pid \([0-9][0-9]*\).*/\1/p')

  # A lock we cannot parse is still a lock.
  if [ -z "$pid" ]; then
    lock_detail="it is locked and the lock reason could not be parsed"
    return 0
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    lock_detail="pid $pid is gone"
    return 1
  fi

  # A live pid is not proof on its own: pids are recycled, and an unrelated
  # process inheriting one would keep a worktree alive forever.
  comm=$(ps -p "$pid" -o comm= 2>/dev/null)
  if [ -z "$comm" ]; then
    lock_detail="a live process holds it (pid $pid)"
    return 0
  fi
  case "$comm" in
  *claude*)
    lock_detail="a live claude session holds it (pid $pid, $comm)"
    return 0
    ;;
  esac
  lock_detail="pid $pid is $comm, not a claude session"
  return 1
}

# Seconds since the worktree's index was last written. Prints nothing and
# returns 1 when it cannot be read.
worktree_idle_seconds() {
  local path=$1 admin index mtime
  admin=$(git -C "$path" rev-parse --absolute-git-dir 2>/dev/null) || return 1
  index="$admin/index"
  [ -f "$index" ] || return 1
  mtime=$(stat -f %m "$index" 2>/dev/null || stat -c %Y "$index" 2>/dev/null)
  [ -n "$mtime" ] || return 1
  printf '%s' "$(($(date +%s) - mtime))"
}

# -------------------------------------------------------------------- freshness

# git@github.com:owner/repo.git -> https://github.com/owner/repo.git
https_url_for() {
  local url=$1
  case "$url" in
  https://*) printf '%s' "$url" ;;
  ssh://git@*) printf 'https://%s' "${url#ssh://git@}" ;;
  git@*:*)
    url=${url#git@}
    printf 'https://%s' "${url/://}"
    ;;
  *) return 1 ;;
  esac
}

# Remote-tracking refs are only as fresh as the last fetch, and both of the weak
# signals read them. --prune matters as much as the fetch: a lingering ref for a
# branch GitHub has already deleted would otherwise read as "published".
refresh_remote_refs() {
  local url https
  [ "$no_fetch" -eq 1 ] && return 0
  url=$(git -C "$repo" remote get-url origin 2>/dev/null) || return 0

  # Nothing here may block a session from ending, so no prompting, ever.
  export GIT_TERMINAL_PROMPT=0
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=5}"

  git -C "$repo" fetch --prune --quiet origin 2>/dev/null && return 0

  # An ssh remote generally cannot authenticate from a hook: there is no askpass
  # and often no agent. gh holds a token and installs itself as the credential
  # helper for github.com, so the same fetch over https usually does work.
  https=$(https_url_for "$url") || {
    say "note: git fetch --prune failed — remote-tracking refs may be stale"
    return 0
  }
  if [ "$https" != "$url" ] &&
    git -C "$repo" fetch --prune --quiet "$https" '+refs/heads/*:refs/remotes/origin/*' 2>/dev/null; then
    return 0
  fi
  say "note: git fetch --prune failed — remote-tracking refs may be stale"
}

# ------------------------------------------------------------------ collection

collect_worktree() {
  local path=$1 branch=$2
  git -C "$repo" worktree unlock "$path" >/dev/null 2>&1
  if ! git -C "$repo" worktree remove "$path" >/dev/null 2>&1 &&
    ! git -C "$repo" worktree remove --force "$path" >/dev/null 2>&1; then
    return 1
  fi
  [ -n "$branch" ] && git -C "$repo" branch -D "$branch" >/dev/null 2>&1
  return 0
}

removed=0
would_remove=0

decide() {
  local path=$1 branch=$2 locked=$3 lock_line=$4
  local head idle gate_rc label

  if [ "$locked" -eq 1 ]; then
    if session_holds_lock "$lock_line"; then
      say "keep $path — $lock_detail"
      return 0
    fi
    say "note $path — ignoring a stale lock ($lock_detail)"
  fi

  # Cheapest and strongest safety signal, so it goes first. Nothing above it
  # makes a network call any more, which is what used to justify deferring it.
  #
  # --no-optional-locks is not decoration: a plain `git status` refreshes the
  # index and writes it back, which would stamp the worktree as active every
  # time this hook ran and stop the idle guard below from ever firing.
  if [ -n "$(git -C "$path" --no-optional-locks status --porcelain 2>/dev/null)" ]; then
    say "keep $path — uncommitted changes"
    return 0
  fi

  head=$(git -C "$path" rev-parse HEAD 2>/dev/null)
  if [ -z "$head" ]; then
    say "keep $path — could not resolve HEAD"
    return 0
  fi

  if [ "$gate" = pr ]; then
    pr_is_finished "$branch" "$head"
  else
    tip_is_published "$branch" "$head"
  fi
  gate_rc=$?

  if [ "$gate_rc" -eq 2 ]; then
    say "keep $path — cannot verify: $publish_reason"
    return 0
  fi
  if [ "$gate_rc" -ne 0 ]; then
    say "keep $path — $publish_reason"
    return 0
  fi

  if [ "$publish_strength" = weak ]; then
    idle=$(worktree_idle_seconds "$path")
    if [ -z "$idle" ]; then
      say "keep $path — $publish_reason, but its idle time could not be read"
      return 0
    fi
    if [ "$idle" -lt "$min_idle_seconds" ]; then
      say "keep $path — $publish_reason, but it was active $((idle / 3600))h ago and weak evidence needs ${min_idle_hours}h idle"
      return 0
    fi
  fi

  label=${branch:-"detached at ${head:0:8}"}

  if [ "$dry_run" -eq 1 ]; then
    say "would remove $path ($label) — $publish_reason [$publish_strength]"
    would_remove=$((would_remove + 1))
    return 0
  fi

  if ! collect_worktree "$path" "$branch"; then
    say "keep $path — git worktree remove refused"
    return 0
  fi

  # The tip goes in the log because `branch -D` force-deletes: with it,
  # `git branch <name> <sha>` puts the branch back.
  say "removed $path ($label) at $head — $publish_reason [$publish_strength]"
  removed=$((removed + 1))
}

# ---------------------------------------------------------------------- main

# Parse the whole list before doing anything expensive, so a repo with no
# managed worktrees still makes no network call and writes nothing.
paths=()
branches=()
lockeds=()
lock_lines=()

path=""
branch=""
locked=0
lock_line=""

record() {
  [ -n "$path" ] || return 0
  case "$path" in
  "$worktree_root"/*) ;;
  *) return 0 ;;
  esac
  paths+=("$path")
  branches+=("$branch")
  lockeds+=("$locked")
  lock_lines+=("$lock_line")
}

while IFS= read -r line; do
  case "$line" in
  "worktree "*)
    path=${line#worktree }
    branch=""
    locked=0
    lock_line=""
    ;;
  "branch refs/heads/"*) branch=${line#branch refs/heads/} ;;
  "locked"*)
    locked=1
    lock_line=$line
    ;;
  "")
    record
    path=""
    branch=""
    locked=0
    lock_line=""
    ;;
  esac
done < <(git -C "$repo" worktree list --porcelain)
record

[ "${#paths[@]}" -gt 0 ] || exit 0

rotate_log

refresh_remote_refs

load_pr_index

for i in "${!paths[@]}"; do
  decide "${paths[$i]}" "${branches[$i]}" "${lockeds[$i]}" "${lock_lines[$i]}"
done

if [ "$removed" -gt 0 ]; then
  git -C "$repo" worktree prune >/dev/null 2>&1
  printf '{"systemMessage":"Removed %d finished worktree(s); see %s"}\n' "$removed" "$log_file"
fi

exit 0
