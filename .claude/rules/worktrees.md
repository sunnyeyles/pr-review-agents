# Worktree policy

Never do implementation work in the main checkout while it is on the default
branch (`main`). If a session starts there, call the **EnterWorktree** tool to
create and switch into a fresh worktree before the first file edit, build, or
commit. Use a short kebab-case `name` describing the task. This standing
instruction authorises EnterWorktree without asking the user first.

Read-only work — answering questions, reading code, inspecting git history —
does not need a worktree.

Worktrees are created under `.claude/worktrees/` (gitignored). The gitignored
files listed in `.worktreeinclude` — `.env.local` — are copied in by the
worktree copier, so a new worktree is runnable immediately. Existing files are
never overwritten.
