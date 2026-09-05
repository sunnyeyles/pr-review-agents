#!/usr/bin/env bash
#
# Tests for cleanup-merged-worktrees.sh. Throwaway repos under mktemp -d with
# `gh` stubbed on PATH, almost all in --dry-run. Not part of `pnpm test`:
#
#   bash .claude/hooks/cleanup-merged-worktrees.test.sh

set -uo pipefail

hook_dir=$(cd "${BASH_SOURCE[0]%/*}" && pwd)
hook="$hook_dir/cleanup-merged-worktrees.sh"
[ -f "$hook" ] || {
  echo "cannot find $hook" >&2
  exit 1
}

t=$(mktemp -d)
live_pid=""
cleanup() {
  [ -n "$live_pid" ] && kill "$live_pid" 2>/dev/null
  rm -rf "$t"
}
trap cleanup EXIT

repo="$t/repo"
wt="$repo/.claude/worktrees"
log="$t/run.log"

pass=0
fail=0
ok() {
  printf '  ok    %s\n' "$1"
  pass=$((pass + 1))
}
bad() {
  printf '  FAIL  %s\n' "$1"
  fail=$((fail + 1))
}

skip() {
  printf '  skip  %s\n' "$1"
}

# Assert some log line about worktree <name> matches <regex>. A worktree can
# draw more than one line — a stale-lock note and then the decision — so this
# looks at all of them rather than only the last.
assert() {
  local desc=$1 name=$2 pattern=$3 lines
  lines=$(grep -F -- "$wt/$name " "$log" 2>/dev/null)
  if [ -z "$lines" ]; then
    bad "$desc — no log line for $name"
    return
  fi
  if printf '%s\n' "$lines" | grep -Eq -- "$pattern"; then
    ok "$desc"
  else
    bad "$desc"
    printf '        want /%s/\n' "$pattern"
    printf '%s\n' "$lines" | sed 's/^[^ ]* /         got /'
  fi
}

assert_absent() {
  local desc=$1 pattern=$2
  if grep -Eq -- "$pattern" "$log" 2>/dev/null; then
    bad "$desc"
    printf '        unexpected: %s\n' "$(grep -E -- "$pattern" "$log" | head -n 1)"
  else
    ok "$desc"
  fi
}

# ------------------------------------------------------------------- fixtures

export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

git init --quiet --bare --initial-branch=main "$t/origin.git"
git init --quiet --initial-branch=main "$repo"
git -C "$repo" remote add origin "$t/origin.git"
printf 'one\n' >"$repo/file"
git -C "$repo" add file
git -C "$repo" commit --quiet -m "first"
git -C "$repo" push --quiet -u origin main
git -C "$repo" remote set-head origin main >/dev/null 2>&1
mkdir -p "$wt"

# A worktree on a new branch, carrying one commit of its own.
mkwt() { # <name> <branch>
  git -C "$repo" worktree add --quiet -b "$2" "$wt/$1" main
  printf '%s\n' "$1" >"$wt/$1/$1"
  git -C "$wt/$1" add "$1"
  git -C "$wt/$1" commit --quiet -m "$1"
}

tip() { git -C "$wt/$1" rev-parse HEAD; }

admin_index() { git -C "$wt/$1" rev-parse --absolute-git-dir; }

# 1. merged pull request sitting on exactly this tip. Never pushed, so the
#    pull-request index is the only evidence — which is the point.
mkwt merged-at-tip br-merged

# 2. open pull request sitting on exactly this tip.
mkwt open-at-tip br-open

# 3. open pull request whose head is an *earlier* commit: this worktree carries
#    a commit no remote has seen. The one case that must never be collected.
mkwt open-diverged br-diverged
diverged_pr_head=$(tip open-diverged)
printf 'more\n' >"$wt/open-diverged/extra"
git -C "$wt/open-diverged" add extra
git -C "$wt/open-diverged" commit --quiet -m "unpushed"

# 4. merged pull request opened from a remote branch whose name differs from the
#    local branch name. Only a SHA-keyed index finds it.
mkwt renamed-ref worktree-renamed

# 5. uncommitted changes.
mkwt dirty br-dirty
printf 'scratch\n' >>"$wt/dirty/file"

# 6a. locked by a live process whose name looks like a claude session. The
#     fixture is a copy of a system binary under a claude-ish name, so that
#     `ps -o comm=` really does report one; if the copy will not run, the case
#     is skipped rather than reported as a failure of the hook.
mkwt locked-live br-locked-live
live_ok=0
if cp "$(command -v sleep)" "$t/claude-session-fake" 2>/dev/null; then
  chmod +x "$t/claude-session-fake" 2>/dev/null
  # Redirect its streams: inherited, they would hold this script's stdout open
  # and make `… | tail` block until the fixture's own timeout expired.
  "$t/claude-session-fake" 300 >/dev/null 2>&1 </dev/null &
  live_pid=$!
  sleep 0.3
  if kill -0 "$live_pid" 2>/dev/null &&
    ps -p "$live_pid" -o comm= 2>/dev/null | grep -q claude; then
    live_ok=1
  fi
fi
git -C "$repo" worktree lock --reason "claude session live (pid ${live_pid:-1} start now)" "$wt/locked-live"

# 6b. locked by a live process that is NOT a claude session — a recycled pid.
#     The lock must be ignored rather than honoured forever. $$ is this test,
#     which `ps` reports as bash.
mkwt locked-stale br-locked-stale
git -C "$repo" worktree lock --reason "claude session gone (pid $$ start now)" "$wt/locked-stale"

# 6c. locked by a process that has exited.
mkwt locked-dead br-locked-dead
(exit 0) &
dead_pid=$!
wait "$dead_pid" 2>/dev/null
git -C "$repo" worktree lock --reason "claude session dead (pid $dead_pid start now)" "$wt/locked-dead"

# 6d. a lock reason this hook cannot parse. A lock it does not understand is
#     still a lock — the fail-safe direction.
mkwt locked-opaque br-locked-opaque
git -C "$repo" worktree lock --reason "held by something else" "$wt/locked-opaque"

# 7. a brand-new worktree: clean, no commits of its own, therefore sitting at the
#    default branch tip and trivially "published". Must survive.
git -C "$repo" worktree add --quiet -b br-fresh-recent "$wt/fresh-recent" main

# 8. the same worktree, untouched for years. Now it may go.
git -C "$repo" worktree add --quiet -b br-fresh-old "$wt/fresh-old" main

# ----------------------------------------------------------------- gh stubbing

mkdir -p "$t/bin"
export PATH="$t/bin:$PATH"

cat >"$t/bin/gh" <<EOF
#!/usr/bin/env bash
# Stands in for: gh pr list --json state,headRefName,headRefOid --jq '...'
cat "$t/prs.tsv"
EOF
chmod +x "$t/bin/gh"

{
  printf 'MERGED\tbr-merged\t%s\n' "$(tip merged-at-tip)"
  printf 'OPEN\tbr-open\t%s\n' "$(tip open-at-tip)"
  printf 'OPEN\tbr-diverged\t%s\n' "$diverged_pr_head"
  printf 'MERGED\trenamed\t%s\n' "$(tip renamed-ref)"
} >"$t/prs.tsv"

run() { # extra args to the hook
  : >"$log"
  (cd "$repo" && WORKTREE_CLEANUP_LOG="$log" bash "$hook" "$@" >/dev/null 2>&1)
}

# ------------------------------------------------------------------ the ladder

echo "the decision ladder (dry run)"

# Age the fixtures last: `git worktree add` and the commits above rewrite the
# index, and the idle clock is that file's mtime.
touch -t 202001010000 "$(admin_index fresh-old)/index"
touch -t 202001010000 "$(admin_index merged-at-tip)/index"

run --dry-run

assert "a merged PR at the tip is strong evidence" \
  merged-at-tip 'would remove .* \[strong\]'
assert "an open PR at the tip is strong evidence" \
  open-at-tip 'would remove .* \[strong\]'
assert "an unpushed commit is never collected" \
  open-diverged 'keep .* no remote has seen'
assert "a PR is found by head SHA when the branch name differs" \
  renamed-ref 'would remove .* \[strong\]'
assert "uncommitted changes are kept" \
  dirty 'keep .* uncommitted changes'
if [ "$live_ok" -eq 1 ]; then
  assert "a live claude session keeps its worktree" \
    locked-live 'keep .* a live claude session holds it'
else
  skip "a live claude session keeps its worktree — could not start the fixture process"
fi
assert "a lock held by a non-claude process is ignored" \
  locked-stale 'ignoring a stale lock .* not a claude session'
assert "a lock whose process has exited is ignored" \
  locked-dead 'ignoring a stale lock .* is gone'
assert "a lock reason that cannot be parsed is still honoured" \
  locked-opaque 'keep .* lock reason could not be parsed'
assert "a brand-new worktree survives its first session end" \
  fresh-recent 'keep .* weak evidence needs'
assert "the same worktree is collected once it has gone idle" \
  fresh-old 'would remove .* \[weak\]'

assert_absent "a dry run removes nothing" '^[^ ]+ removed '

# The rung order matters as much as the rungs: a dirty worktree must be kept for
# being dirty, and a locked one for being locked, not incidentally by a later
# check that happens to agree.
assert "dirty is judged before publication" dirty 'keep .* uncommitted changes$'
if [ "$live_ok" -eq 1 ]; then
  assert "the lock is judged before anything else" locked-live 'keep .* \(pid '
else
  skip "the lock is judged before anything else — could not start the fixture process"
fi

# ------------------------------------------------------------- gh unavailable

echo
echo "gh unavailable"

cat >"$t/bin/gh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$t/bin/gh"

run --dry-run

assert "a failed gh call is not read as 'no pull request'" \
  renamed-ref 'keep .* cannot verify'
assert "unpushed work is still kept when gh is down" \
  open-diverged 'keep .* cannot verify'
assert "local evidence still stands without gh" \
  fresh-old 'would remove .* \[weak\]'

# ------------------------------------------------------- the conservative gate

echo
echo "WORKTREE_CLEANUP_GATE=pr"

cat >"$t/bin/gh" <<EOF
#!/usr/bin/env bash
cat "$t/prs.tsv"
EOF
chmod +x "$t/bin/gh"

run --dry-run --conservative

assert "the old gate still collects a merged PR" \
  merged-at-tip 'would remove'
assert "the old gate leaves an open PR alone" \
  open-at-tip 'keep .* still open'
assert "the old gate collects nothing without a pull request" \
  fresh-old 'keep .* no pull request found'

# ------------------------------------------------------------- real removal

echo
echo "removal"

run

if [ -d "$wt/merged-at-tip" ]; then
  bad "a collected worktree is gone from disk"
else
  ok "a collected worktree is gone from disk"
fi
if git -C "$repo" branch --list br-merged | grep -q .; then
  bad "a collected worktree's branch is deleted"
else
  ok "a collected worktree's branch is deleted"
fi
if [ -d "$wt/open-diverged" ]; then
  ok "the worktree holding unpushed work is still there"
else
  bad "the worktree holding unpushed work is still there"
fi
assert "the removal log records the tip, so the branch can be restored" \
  renamed-ref 'removed .* at [0-9a-f]{40} '

# ------------------------------------------------------------- log rotation

echo
echo "log rotation"

: >"$log"
i=0
while [ "$i" -lt 40 ]; do
  printf 'filler line %s\n' "$i" >>"$log"
  i=$((i + 1))
done
(cd "$repo" && WORKTREE_CLEANUP_LOG="$log" WORKTREE_CLEANUP_LOG_MAX=20 WORKTREE_CLEANUP_LOG_KEEP=5 \
  bash "$hook" --dry-run >/dev/null 2>&1)
lines=$(wc -l <"$log" | tr -d ' ')
if [ "$lines" -lt 40 ]; then
  ok "an oversized log is trimmed"
else
  bad "an oversized log is trimmed (still $lines lines)"
fi

# --------------------------------------------------------------------- result

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
