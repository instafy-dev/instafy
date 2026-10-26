# Skill packs

A skill pack is a skill with its own scripts, references and templates, published from its own
repository as a release archive. The runtime installs the packs pinned in
[`packages/runtime-agent/skill-packs.json`](../packages/runtime-agent/skill-packs.json) once, and every
space gets them without carrying their files in its history.

## Pinning

Each entry names the pack's repository, version and tag, the commit the archive was made from, the
archive's URL and sha256, and the pack's content hash (`tree_sha256`):

```json
{"schema": 1, "packs": [{"name": "...", "repo": "instafy-dev/...", "version": "0.1.0", "tag": "v0.1.0",
  "commit": "<40 hex>", "path": "skills/<name>", "url": "https://github.com/instafy-dev/.../releases/download/v0.1.0/...",
  "sha256": "<64 hex>", "tree_sha256": "<64 hex>", "license": "..."}]}
```

To move to a new pack release, change the version, tag, commit, URL, sha256 and tree hash together
from the pack's release page and its `.instafy-pack.json`.

## Installation

`scripts/install-skill-packs.mjs` (`pnpm skill-packs:install`) downloads each archive over https,
checks its sha256 before reading it, reads the tar itself (regular files and folders only, nothing
outside the pack folder, at most 16 MB unpacked), checks that the archive's pax header names the pinned
commit, checks the pack's `.instafy-pack.json` and content hash, and moves the pack into place in one
rename. A pack already installed with the pinned content is left alone.

- Runtime images: the `skill-packs` stage of `docker/runtime/Dockerfile` runs the installer with
  `--require-pinned`; both runtime images copy the result to `/opt/instafy/skill-packs` and set
  `INSTAFY_SKILL_PACKS_DIR`. Any mismatch fails the build.
- Desktop: `stage-runtime-agent.mjs` installs the packs beside the bundled `runtime-agent`
  (`skill-packs/`), the packaged manifest records each pack's name, version and content hash, and
  `verify-packaged-runtime-agent.mjs` refuses a release whose packs differ from the pin.
- Local development: `pnpm skill-packs:install` installs into `packages/runtime-agent/assets/skill-packs`
  (ignored by git and by the Docker build), where a debug `runtime-agent` looks last.
  `pnpm dev:desktop` runs it. Pack authors can try a local checkout with
  `node scripts/install-skill-packs.mjs --from <pack folder>`; the installed pack is recorded as not pinned.

At startup `runtime-agent` finds the packs (`INSTAFY_SKILL_PACKS_DIR`, `/opt/instafy/skill-packs`,
`skill-packs/` beside the binary, `../share/instafy/skill-packs`, then the checkout's folder in debug
builds only), exports `INSTAFY_SKILL_PACKS_DIR` for model shells and logs each pack.

## What a space gets

Before every turn the runtime writes, for each pack:

- `.agents/skills/<pack>/SKILL.md`: the pack's skill with a short note on where its other files are;
- for a pack with a command, a launcher at the path its manifest names. The launcher runs the pack's
  command from `INSTAFY_SKILL_PACKS_DIR` or `/opt/instafy/skill-packs` only; `--pack-dir` prints the
  pack's folder.

These files are the runtime's and are never committed: they are listed in a managed block of the
checkout's `info/exclude` (`.instafy/.git/info/exclude` in a hosted checkout) before they are written,
with the sha256 of each. The runtime rewrites a file only while it is unchanged since it wrote it (or a
launcher still carries its marker); a file someone edited, or a path the repository tracks, is left
alone and saved like other work. Each `SKILL.md` also carries a marker line with the sha256 of the rest
of the file, so an unchanged copy is upgraded with its pack in a folder without git too. A pack whose scripts need a newer Node.js than the one on the
runtime's PATH is skipped.

Importing a pack in full with `/skills import <url>` writes over the runtime's unchanged copy without
`--overwrite`, and the imported files are saved and then kept by the space.
