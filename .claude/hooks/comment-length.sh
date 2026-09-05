#!/usr/bin/env bash
#
# PostToolUse hook — reject comment blocks longer than 2 lines.
#
# Only judges lines added since HEAD, so pre-existing comments never block an
# unrelated edit. COMMENT_LINT_SKIP=1 disables it.

set -uo pipefail

[ "${COMMENT_LINT_SKIP:-0}" = "1" ] && exit 0

MAX_LINES="${COMMENT_LINT_MAX:-2}"

payload=$(cat)
[ -n "$payload" ] || exit 0

extract_path() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null && return
  fi
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$payload" |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.file_path||"")}catch{}})' 2>/dev/null
  fi
}

file=$(extract_path)
[ -n "$file" ] || exit 0
[ -f "$file" ] || exit 0

case "$file" in
*.ts | *.tsx | *.mts | *.cts | *.js | *.jsx | *.mjs | *.cjs) ;;
*) exit 0 ;;
esac

dir=$(dirname "$file")
command -v git >/dev/null 2>&1 || exit 0
git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Against HEAD, not the index: a staged long comment must still be judged added.
added=$(
  if git -C "$dir" rev-parse --verify HEAD >/dev/null 2>&1 &&
    git -C "$dir" ls-files --error-unmatch "$file" >/dev/null 2>&1; then
    git -C "$dir" diff -U0 HEAD -- "$file" 2>/dev/null |
      awk '/^@@/ {
        spec = $3
        sub(/^\+/, "", spec)
        n = split(spec, p, ",")
        start = p[1] + 0
        count = (n > 1) ? p[2] + 0 : 1
        for (i = 0; i < count; i++) print start + i
      }'
  else
    awk '{ print NR }' "$file"
  fi
)

report=$(printf '%s\n' "$added" | awk \
  -v fname="$file" \
  -v max="$MAX_LINES" '
function body(t) {
  gsub(/^[ \t]+/, "", t)
  sub(/\*\/[ \t]*$/, "", t)
  sub(/^\/\*\*?/, "", t)
  sub(/^\*+/, "", t)
  gsub(/^[ \t]+|[ \t]+$/, "", t)
  return t
}
function report(start, end, content, touched,   i) {
  if (content <= max || !touched) return
  printf "%s:%d  comment block is %d lines (max %d)\n", fname, start, content, max
  for (i = start; i <= end; i++) printf "    %s\n", lines[i]
  printf "\n"
  bad = 1
}
NR == FNR { if ($1 != "") added[$1 + 0] = 1; next }
{ lines[FNR] = $0; n = FNR }
END {
  i = 1
  while (i <= n) {
    s = lines[i]
    gsub(/^[ \t]+/, "", s)
    if (s ~ /^\/\*/) {
      start = i; content = 0; touched = 0
      while (i <= n) {
        if (i in added) touched = 1
        if (body(lines[i]) != "") content++
        if (lines[i] ~ /\*\//) break
        i++
      }
      end = (i <= n) ? i : n
      report(start, end, content, touched)
      i = end + 1
      continue
    }
    if (s ~ /^\/\//) {
      start = i; content = 0; touched = 0
      while (i <= n) {
        t = lines[i]
        gsub(/^[ \t]+/, "", t)
        if (t !~ /^\/\//) break
        if (i in added) touched = 1
        sub(/^\/\/+/, "", t)
        gsub(/^[ \t]+|[ \t]+$/, "", t)
        if (t != "") content++
        i++
      }
      report(start, i - 1, content, touched)
      continue
    }
    i++
  }
  exit bad ? 1 : 0
}
' - "$file")

[ -z "$report" ] && exit 0

{
  printf 'Comment too long. This repo caps comments at %s lines — see .claude/rules/comments.md.\n\n' "$MAX_LINES"
  printf '%s\n\n' "$report"
  printf 'Cut each block to the one non-obvious fact, or delete it. Do not restate the code.\n'
} >&2

exit 2
