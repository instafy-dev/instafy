---
name: instafy-git-canonical-conflicts
description: Playbook for resolving git-canonical conflict and rebase states safely.
---

# Git-canonical conflict resolution (core skill)

Never prune: yes

Goal: resolve `origin/main` vs local conflicts in **Instafy git-canonical** workspaces and finish a clean push to `main` (never force-push).

## When to auto-resolve vs ask

- If the User gives an explicit decision (keep local vs keep remote) or gives the exact final file content, **resolve automatically**.
- If a conflict is “binary-like” (images, large/minified blobs) and the User did not specify what to keep, **ask** (don’t guess).

## Quick diagnosis (always)

- `instafy git status -sb`
- `instafy git status --porcelain=v1`

If `git status` says “not a git repository”, you are in `.instafy/.git` land — use `instafy git …` (or `git --git-dir .instafy/.git --work-tree . …`).

## If `instafy git sync` returns `409 Conflict`

`instafy git sync` is a great default, but it can’t resolve conflicts for you. When it returns `409 Conflict`, switch to manual conflict handling:

Important: Origin aborts the rebase when it reports `409 Conflict`, so there is usually **no rebase to continue** afterwards. Don’t start with `instafy git rebase --continue`; start a fresh manual rebase.

If the User message explicitly mentions merge conflicts (or includes the desired merged content), **skip `instafy git sync`** and run the manual procedure below — it is more deterministic and avoids false “sync succeeded” claims.

If `instafy git status` says your branch and `origin/main` have diverged, you must rebase `origin/main` (manual procedure) and resolve conflicts before pushing.

## Deterministic manual sync procedure (git-canonical)

1) **Checkpoint local intent (commit what you meant to change).**
- `instafy git add -A`
- `instafy git commit -m "instafy: checkpoint"` (ok if it prints “nothing to commit”)

2) **Fetch + rebase onto canonical main.**
- `instafy git fetch origin main`
- `instafy git rebase origin/main`

If the rebase refuses with “Your local changes would be overwritten by merge”, you still have uncommitted changes — go back to step 1.

3) **Resolve conflicts (repeat until rebase completes).**

For each conflicted path:
- If the User gave the exact final content, overwrite the file with that content **exactly** (newlines matter).
- If the User said keep local: `instafy git checkout --ours -- <path>`
- If the User said keep remote: `instafy git checkout --theirs -- <path>`
- Stage: `instafy git add -- <path>`
- Continue: `instafy git rebase --continue`

If `instafy git rebase --continue` complains about staged changes and suggests `git commit --amend`, you are at an “edit” stop:
- `instafy git commit --amend --no-edit`
- `instafy git rebase --continue`

If the rebase state is confusing or stuck:
- `instafy git rebase --abort`
- Restart from step 1 (checkpoint → fetch → rebase).

4) **Mark the resolution as assistant-made (auditability).**

Once the rebase completes and before pushing, append a trailer to the tip commit so the resolution is visible in history:
- `instafy git commit --amend --no-edit --trailer "Instafy-Resolved-By: assistant"`

The commit is still local at this point, so amending is safe. Do this for every conflict resolution you performed, even when the User told you exactly what to keep.

5) **Push (fast-forward only).**
- `instafy git push origin HEAD:main`

If push is rejected (non-fast-forward), retry once:
- `instafy git fetch origin main`
- `instafy git rebase origin/main`
- `instafy git push origin HEAD:main`

## Verify the canonical remote

- Always verify before claiming success: `instafy git show origin/main:<path>` must match what the User asked for.
