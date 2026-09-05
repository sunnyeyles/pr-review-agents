#!/usr/bin/env bash
#
# Tests for comment-length.sh. Runs against throwaway repos under mktemp -d.
#
#   bash .claude/hooks/comment-length.test.sh

set -uo pipefail

hook_dir=$(cd "${BASH_SOURCE[0]%/*}" && pwd)
hook="$hook_dir/comment-length.sh"
[ -f "$hook" ] || {
  echo "cannot find $hook" >&2
  exit 1
}

t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT

pass=0
fail=0
ok() {
  printf '  ok    %s\n' "$1"
  pass=$((pass + 1))
}
bad() {
  printf '  FAIL  %s  %s\n' "$1" "${2:-}"
  fail=$((fail + 1))
}

# Fresh repo with one committed file, so "added since HEAD" has meaning.
new_repo() {
  local d="$t/$1"
  rm -rf "$d"
  mkdir -p "$d"
  git -C "$d" init -q
  git -C "$d" config user.email test@example.com
  git -C "$d" config user.name test
  printf 'export const seed = 1;\n' >"$d/seed.ts"
  git -C "$d" add -A
  git -C "$d" commit -qm init
  printf '%s' "$d"
}

# Run the hook as Claude Code would: tool JSON on stdin, exit code is the verdict.
run_hook() {
  printf '{"tool_input":{"file_path":"%s"}}' "$1" | bash "$hook" >"$t/out" 2>"$t/err"
  echo $?
}

expect() {
  local desc=$1 want=$2 got=$3
  [ "$want" = "$got" ] && ok "$desc" || bad "$desc" "wanted exit $want, got $got"
}

echo "comment-length.sh"

# --- a long block on added lines is rejected -------------------------------
d=$(new_repo added-long)
cat >"$d/a.ts" <<'EOF'
/**
 * Names too common to identify anything, so searching one returns only
 * noise. A heuristic snapshot of the usual conventions, not a rule — the
 * totalCount in every result is what shows the model how noisy it was.
 */
export const common = ['index'];
EOF
expect "long jsdoc on added lines is rejected" 2 "$(run_hook "$d/a.ts")"
grep -q 'comment block is 3 lines' "$t/err" ||
  bad "rejection names the length" "$(cat "$t/err")"

# --- a run of // lines counts the same -------------------------------------
d=$(new_repo added-slashes)
cat >"$d/a.ts" <<'EOF'
// one
// two
// three
export const x = 1;
EOF
expect "three // lines are rejected" 2 "$(run_hook "$d/a.ts")"

# --- two lines is the cap, not one over ------------------------------------
d=$(new_repo two-lines)
cat >"$d/a.ts" <<'EOF'
/**
 * Matching is POSIX only: the GitHub API always uses forward slashes.
 * The host platform must not change which agents run.
 */
// trailing pair
// is also fine
export const x = 1;
EOF
expect "two-line blocks pass" 0 "$(run_hook "$d/a.ts")"

# --- delimiters are not content --------------------------------------------
d=$(new_repo one-line)
cat >"$d/a.ts" <<'EOF'
/** Compiled separately so negation subtracts. */
export const x = 1;
/**
 * picomatch ORs an array, which would let a negated test file through.
 */
export const y = 2;
EOF
expect "one-line blocks pass" 0 "$(run_hook "$d/a.ts")"

# --- a pre-existing long block does not block an unrelated edit ------------
d=$(new_repo pre-existing)
cat >"$d/a.ts" <<'EOF'
/**
 * one
 * two
 * three
 */
export const x = 1;
EOF
git -C "$d" add -A
git -C "$d" commit -qm "legacy comment"
printf 'export const y = 2;\n' >>"$d/a.ts"
expect "untouched legacy block is ignored" 0 "$(run_hook "$d/a.ts")"

# --- but editing inside that block does flag it ----------------------------
d=$(new_repo edited-legacy)
cat >"$d/a.ts" <<'EOF'
/**
 * one
 * two
 * three
 */
export const x = 1;
EOF
git -C "$d" add -A
git -C "$d" commit -qm "legacy comment"
cat >"$d/a.ts" <<'EOF'
/**
 * one
 * two
 * three, now reworded
 */
export const x = 1;
EOF
expect "editing a legacy block flags it" 2 "$(run_hook "$d/a.ts")"

# --- staging does not launder a long comment -------------------------------
# Diffing the index instead of HEAD would let `git add -A` hide it.
d=$(new_repo staged)
cat >"$d/a.ts" <<'EOF'
/**
 * one
 * two
 * three
 */
export const x = 1;
EOF
git -C "$d" add -A
printf 'export const later = 2;\n' >>"$d/a.ts"
expect "a staged long block is still flagged" 2 "$(run_hook "$d/a.ts")"

# --- a repository with no commits at all -----------------------------------
d="$t/no-commits"
rm -rf "$d"
mkdir -p "$d"
git -C "$d" init -q
cat >"$d/a.ts" <<'EOF'
// one
// two
// three
export const x = 1;
EOF
git -C "$d" add -A
expect "staged with no HEAD is judged whole" 2 "$(run_hook "$d/a.ts")"

# --- an untracked file is judged whole -------------------------------------
d=$(new_repo untracked)
cat >"$d/new.ts" <<'EOF'
// one
// two
// three
export const x = 1;
EOF
expect "untracked file is judged whole" 2 "$(run_hook "$d/new.ts")"

# --- non-code files are none of its business -------------------------------
d=$(new_repo other-types)
cat >"$d/a.md" <<'EOF'
// one
// two
// three
EOF
expect "markdown is ignored" 0 "$(run_hook "$d/a.md")"

# --- escape hatches ---------------------------------------------------------
d=$(new_repo skip)
cat >"$d/a.ts" <<'EOF'
// one
// two
// three
export const x = 1;
EOF
got=$(COMMENT_LINT_SKIP=1 bash -c 'printf "{\"tool_input\":{\"file_path\":\"$1\"}}" | bash "$0"' "$hook" "$d/a.ts" >/dev/null 2>&1; echo $?)
expect "COMMENT_LINT_SKIP=1 disables the hook" 0 "$got"

d=$(new_repo missing-file)
expect "a path that does not exist is ignored" 0 "$(run_hook "$d/gone.ts")"

# --- settings.json wrapper forwards the exit code, not just the output ------
# The other two hooks end in `|| true`; this one must not, or nothing blocks.
settings="$hook_dir/../settings.json"
if [ -f "$settings" ] && command -v node >/dev/null 2>&1; then
  wrapper=$(node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    const h = (s.hooks?.PostToolUse ?? []).flatMap((e) => e.hooks ?? [])
      .find((x) => (x.command ?? "").includes("comment-length.sh"))
    process.stdout.write(h?.command ?? "")
  ' "$settings")
  if [ -n "$wrapper" ]; then
    d=$(new_repo wrapper)
    cat >"$d/a.ts" <<'EOF'
// one
// two
// three
export const x = 1;
EOF
    got=$(printf '{"tool_input":{"file_path":"%s"}}' "$d/a.ts" |
      CLAUDE_PROJECT_DIR="$hook_dir/../.." bash -c "$wrapper" >/dev/null 2>&1
    echo $?)
    expect "settings.json wrapper still exits 2" 2 "$got"
  else
    bad "settings.json registers the hook" "no PostToolUse entry found"
  fi
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
