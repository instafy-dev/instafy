---
name: instafy-git-canonical-conflicts
description: How to merge work a save kept aside because a file also changed in the saved version, and what the "Not saved" lines mean.
---

# Merging work a save kept aside (core skill)

Never prune: yes

Goal: when a save could not take some of this workspace's changes, merge them into the saved version (canonical `main`) on purpose, without losing either side.

## How saving works

- After every turn, the runtime saves the files the turn changed by merging them onto the saved version and pushing the result. Nothing is rebased, reset or force-pushed, and you never commit, rebase or push to save.
- Before every turn, the runtime brings the workspace up to the saved version and fetches this space's kept work (`refs/instafy/recovery/*`).
- When a file changed both here and in the saved version since the workspace last caught up, the saved version keeps its own copy. This workspace's copy is kept on a recovery ref, and the save reports:
  - `conflictedPaths`: the files the saved version kept its own copy of;
  - `recoveryRef`: the ref holding this workspace's version of them (`refs/instafy/recovery/<origin>/<name>`, or `refs/instafy/local-recovery/<name>` until it is pushed);
  - `rejectedPaths`: files that are never saved, each with a `reason` (see below).
- The reply then ends with a line like `Not saved: src/app.ts (kept at refs/instafy/recovery/<origin>/<name>)`, and `instafy git sync` prints the same line and exits 1.

## When to merge

- When the User asks you to merge, or asks what happened to a file named on a "Not saved" line.
- If the User says which version wins, or gives the exact final content, do exactly that.
- If a conflicted file is binary-like (images, archives, minified bundles) and the User did not say which to keep, ask. Do not guess.

## Merge procedure

1. Find the ref and the paths. They are on the "Not saved" line. To list all kept work: `instafy git for-each-ref refs/instafy/recovery refs/instafy/local-recovery`.
2. Read the versions:
   - the saved version is the file in the workspace (the workspace follows the saved version), or `instafy git show origin/main:<path>`;
   - this workspace's version: `instafy git show <ref>:<path>`;
   - the version both started from, when it helps: `instafy git show <ref>^:<path>`.
3. Write the merged file into the workspace, keeping what each side meant to change. If the User gave the final content, write it exactly (newlines matter).
4. Check the result as for any change (build, tests).
5. Report the merged files as changed in your final answer. The runtime's checkpoint after the turn saves them like any other change.

Never run `instafy git rebase`, `instafy git rebase --continue`, `instafy git push` or any `--force` command to resolve a conflict, and never delete recovery refs. Kept work stays until someone restores or dismisses it.

## Verify

- After the turn, the reply has no "Not saved" line for the merged files.
- In a later turn: `instafy git show origin/main:<path>` matches what the User asked for.

## Files that are never saved (`rejectedPaths`)

The saved version keeps its earlier copy of these paths (`keptSavedVersion: true` when it has one); the files stay in this workspace only.

- `ignored`: matched by `.gitignore`. Change `.gitignore` only when the User wants the file saved.
- `secret`: `.env*` (except `.env.example`, `.env.sample` and `.env.template`), `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `.npmrc`, `.pypirc`, `.netrc`. Never save these; suggest Instafy secrets instead.
- `excluded`: dependencies, build output, caches and Instafy metadata (`node_modules/`, `.instafy/` and similar).
- `too_large`: files over 20 MiB.
- `attachment`, `policy`, `unsupported`: older chat uploads, paths the repository refuses, and entries git cannot store safely.
