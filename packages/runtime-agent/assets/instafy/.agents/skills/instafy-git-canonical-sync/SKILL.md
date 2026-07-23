---
name: instafy-git-canonical-sync
description: Operational rules for syncing git-canonical workspaces to main.
---

# Git-canonical sync (core skill)

Never prune: yes

Goal: keep **git-canonical** workspaces safely synced to their **canonical remote** without surprising pushes for user-owned repos or mounted workspaces.

## Policy (important)

- **Default behavior:** assistant file changes auto-sync after apply in git-canonical workspaces.
- Users can disable auto-sync in Profile preferences; in that mode, treat sync as an **agent-driven step** and surface that manual save is required.
- If auto-sync fails, do not drop the workspace edits. Clearly tell the user to open Changes and save/sync manually.
- The goal is high-quality commits and predictable conflict handling: if a sync hits conflicts, resolve them intentionally or ask the user.

## How to run git commands (important)

Instafy-managed git-canonical workspaces store the git dir at **`.instafy/.git`** (not `.git`).

Preferred (if `instafy` CLI is available):
- `instafy git <cmd>` (auto-detects `.instafy/.git` by walking up from `cwd`)

Fallback (only when the `instafy` CLI is unavailable):
- `git --git-dir .instafy/.git --work-tree . <cmd>`
- Raw git skips the safety the `instafy git` wrapper provides (reserved-path filtering, embedded-`.git` handling). With raw git, never `add -A` and never stage whole directories — stage explicit file paths only, and never stage `.instafy/` or any `.git/`.

Model jobs are deliberately read-only at the remote Git boundary:
- Do not configure a credential helper for pushes or ask the controller for a Git write scope; model-facing job tokens cannot mint raw Git write credentials.
- Use ordinary local Git commands for inspection. If remote inspection is essential, mint a short-lived `git.read` token with the scoped `CONTROLLER_ACCESS_TOKEN` and use it only for fetch/read operations.
- Saving is handled automatically by the runtime's controlled post-turn workspace checkpoint. If a separate explicit sync is needed, ask the user to send `/sync` as a top-level message; do not invoke raw sync or push commands from the model shell.

If `.instafy/.git` is missing but `.git` exists, you are likely in a mounted/user-owned repo; use normal `git <cmd>` and **do not push** unless the user explicitly asks.

## Embedded git repos (git-inside-git)

Workspaces can contain **nested git repositories** (a directory that contains its own `.git/`).

When syncing the **Instafy canonical repo**, naive `git add` can accidentally treat the nested repo as an *embedded repo* (submodule-like gitlink), which means the nested repo’s working tree files **won’t** actually be committed to the canonical remote.

Preferred approach:
- Let the runtime's controlled post-turn workspace checkpoint save the working files; it handles embedded `.git/` directories without exposing a raw write credential to the model.
- If a later explicit sync is needed, ask the user to send `/sync` as a top-level message so the runtime-owned path handles it before model execution.

If you must run git directly:
- Avoid staging an embedded repo root as a unit. Prefer staging explicit file paths.
- Do not try to commit `.git/` directories; treat them as runtime-local metadata.

History caveat (important): canonical storage keeps an embedded repo's **working files only** — its `.git/` history is never synced. If an embedded repo has **no remote of its own** (`git -C <repo> remote -v` prints nothing), its history exists only on this machine. Tell the user this before any destructive git operation inside that repo, and suggest adding a remote (e.g. GitHub) if the history matters to them.

## Determine the workspace mode (before any auto-push)

Only auto-sync (commit/push) when the canonical remote is clearly Instafy-managed.

Treat the workspace as **git-canonical** if ANY is true:
- `ORIGIN_GIT_REMOTE_URL` is set (preferred signal), OR
- `git --git-dir .instafy/.git --work-tree . config --get remote.origin.url` starts with `GIT_REMOTE_BASE_URL/` and ends with `/<projectId>.git`, OR
- the remote URL clearly points at an Instafy git service (e.g. `git-edge`, `git.instafy.*`) and the repo name matches the Instafy `projectId`.

Treat the workspace as **mounted / user-owned** if:
- `ORIGIN_GIT_REMOTE_URL` is empty AND `.git` exists AND the remote points to GitHub/GitLab/Bitbucket or another non-Instafy host, OR
- the workspace looks like a bind/sshfs mount of a local checkout where the user controls the repo/remote.

Treat the workspace as **unknown/offline** if:
- git commands are unavailable, OR
- there is no remote configured, OR
- network/auth is failing and you can’t confirm the canonical remote.

Rule: if it’s not clearly git-canonical, do **not** push anywhere without asking the user first.

## Before starting work (read-only preflight, git-canonical only)

Goal: avoid conflicts by inspecting local/remote divergence and letting the controlled `/sync` path own any rebase.

Recommended (fast + consistent):
- If a preflight sync is still needed, ask the user to send `/sync` as a top-level message.

The runtime-owned sync path fetches/rebases/checkpoints without exposing a write credential to the model shell.

1) Inspect local changes:
- `git --git-dir .instafy/.git --work-tree . status --porcelain=v1`
- If dirty, leave the changes for the controlled post-turn checkpoint; do not create a manual canonical commit.

2) Fetch for read-only inspection only when needed:
- Mint a short-lived `git.read` token:
  - Works in base runtimes with only Python:
    `TOKEN="$(python3 - <<'PY'\nimport json, os, urllib.request\nbase=os.environ['CONTROLLER_BASE_URL'].rstrip('/')\nproject=os.environ['PROJECT_ID']\nreq=urllib.request.Request(f\"{base}/projects/{project}/git/access_token\", method=\"POST\")\nreq.add_header(\"authorization\", f\"Bearer {os.environ['CONTROLLER_ACCESS_TOKEN']}\")\nreq.add_header(\"content-type\", \"application/json\")\npayload=json.dumps({\"scopes\":[\"git.read\"],\"ttlSeconds\":600}).encode(\"utf-8\")\nwith urllib.request.urlopen(req, data=payload) as resp:\n  print(json.load(resp)[\"token\"])\nPY\n)"`
- `git --git-dir .instafy/.git --work-tree . -c http.extraHeader="Authorization: Bearer $TOKEN" fetch origin main`
- Inspect divergence with `git --git-dir .instafy/.git --work-tree . rev-list --left-right --count HEAD...origin/main`.

Do not rebase or push from the model shell. The controlled checkpoint or explicit `/sync` path owns mutation and conflict handling.

## When to sync (git-canonical only)

- Before replying that a task is done.
- Before running `/learn`.
- After running tools that modify files (generators, formatters, installs, build steps).
- Whenever `git --git-dir .instafy/.git --work-tree . status --porcelain=v1` shows changes.

## Main-only policy (git-canonical only)

- Sync by rebasing and pushing **to `main` only**.
- Do not create/push branches or open PRs in v0 (unless a future learning says otherwise).
- Never `--force` push to the canonical remote.

## How to sync (git-canonical only)

Recommended (preferred):
- Explain what will be synced, then ask the user to send `/sync` as a top-level message.

The runtime performs the controlled checkpoint and canonical push before model execution. If it reports `409 Conflict`, resolve the workspace files, then ask the user to send `/sync` again.

Before returning the intent, inspect what changed:
- `git --git-dir .instafy/.git --work-tree . status --porcelain=v1`
- Prefer committing **all intentional workspace changes**, including files created/modified by running tools.
- Do not commit runtime internals like `.instafy/` (tunnel state, staging, etc). If you see `.instafy` changes, keep them out of the commit.
- Do not stage, commit, rebase, or push the canonical repo from the model shell. The runtime-owned checkpoint and `/sync` handler perform those write operations with the separate workspace credential.

## Local-only checkpoints (mounted / user-owned)

It can still be useful to save progress as **local commits**, as long as we don’t push.

- Allowed: `git add -A` + `git commit -m "instafy: <short summary>"` (on the current branch).
- Not allowed: pushing to a non-Instafy remote unless the user explicitly asks.
- If you’re unsure the user wants the agent to create commits in their repo, ask once (then follow their preference).

## Conflict handling (git-canonical only)

If rebase reports conflicts:
- Try to resolve by intent (preserve the user’s requested behavior) and keep history linear.
- Leave resolved files in the worktree for the runtime-owned checkpoint; it records an auditable resolution without a model-held Git write credential.
- If it’s unclear or risky, stop and ask the user:
  - What you were trying to save (commit summary)
  - Which files conflict (list them)
  - Offer options: keep local, keep remote, or manual merge guidance
- Never `--force` push to the canonical remote.

If you started a rebase you can’t finish:
- `git rebase --abort` (then ask the user what to do next).

## When you don’t know what to do

Stop and ask the user for a decision. Provide:
- The goal of the commit (1 sentence).
- The conflicting files (list them).
- The 2–3 reasonable options (keep local, keep remote, or guided merge) and which one you recommend.

## Safety

- Never commit secrets. If you notice a secret in git history, remove it, rotate it, and tell the user.
- Never push to non-Instafy remotes without explicit user confirmation.
