# Desktop release lane

`.github/workflows/desktop-release.yml` publishes the signed macOS arm64 Desktop app
from this public repository on free GitHub-hosted runners. The immutable tag is the
ledger: there are no deployment ledgers, journals or merge freezes.

## Trigger

- `desktop-app-v<MAJOR.MINOR.PATCH>` pushed by `instafy-bot` at a commit on protected
  `main` whose `packages/desktop-app/package.json` version equals the tag version.
- `gh workflow run desktop-release.yml --ref main -f tag=<tag> -f dry_run=true|false`
  as `instafy-bot`. `dry_run=true` (default) builds, signs, notarizes and smoke-tests
  but publishes nothing; the signed artifact is kept for 30 days. `dry_run=false`
  publishes an existing tag that never ran. A dispatch builds exactly the `main` head
  it runs from (`github.sha`): authorize refuses it unless the named tag, when it
  exists, resolves to that same commit. A tag at an older commit is published only by
  its own tag-push run; recover a cancelled tag-push run with **Re-run all jobs** on
  that run, not with a dispatch.

Concurrency: runs are grouped per tag, and the publish job has its own global group,
so stable-pointer writes never race. GitHub keeps only one *pending* run or job per
group: if three publishes queue at once, the older pending one is cancelled. The
`publish_cancelled` job turns that into a failed run with an error annotation; use
**Re-run failed jobs** on it. If a newer version became stable meanwhile, the pointer
guard refuses the older tag and nothing more is needed. A cancelled queued tag run
(before publish) is recovered by re-running that run, or with `dry_run=false` only
while the tag still points at the `main` head.

## Jobs

| Job | Runner | Environment | Does |
| --- | --- | --- | --- |
| authorize | ubuntu-24.04 | none | actor/pusher, peeled tag commit, `compare/<sha>...main` is identical or ahead, source version, contract tests, one-shot probes (live `latest.json` older, no GitHub Release, Worker pointer contract) |
| preflight | ubuntu-24.04 | desktop-release | picks `personal-browser` when the optional canary credentials exist with 24 h left, else `launch-smoke` |
| build | macos-15 | desktop-release | credential sanity, isolated keychain, `pnpm --filter @instafy/desktop-app dist` (notarize + staple), signature/staple/DMG checks, release-set and Gitleaks gates, artifact upload |
| launch_smoke | macos-15 | none | safe ZIP extraction, `spctl`, packaged launch through Playwright's Electron driver |
| personal_browser_canary | macos-15 | desktop-release | the production Personal Browser agent-turn canary (opt-in); restores recovery journals only from this workflow's own push/dispatch runs on `main` or `desktop-app-v*` in this repository (`recovery-journals.mjs`), enumerated through this workflow's run list of the last 31 days rather than the repository-wide artifact list, so untrusted uploads cannot crowd them out |
| publish | ubuntu-24.04 | desktop-release | `publish-downloads.sh`, `release-receipt.json`, `gh release create` last |
| publish_cancelled | ubuntu-24.04 | none | fails the run with recovery instructions when publish was cancelled |

Lane tooling (`scripts/release/desktop/**`) is read from the workflow commit; the product
bytes are built from the tag commit.

Every job checks out `github.sha` (or `github.workflow_sha` for the tooling), never a
ref computed from inputs or job outputs, and re-asserts it equals the authorized
`source_sha`. Authorize requires the release tag to resolve to `github.sha` for tag
pushes and dispatches alike, which keeps the exact-source binding while giving static
analysis (CodeQL `actions/cache-poisoning`) no untrusted checkout. No job restores or
saves an Actions cache (no `setup-node` cache, `rust-cache` or `actions/cache`): a
signed release is built from a cold dependency install, and its runs can neither
consume nor seed caches shared with other workflows on `main`.

The GitHub Release carries the dmg, zip, zip.blockmap, dmg.blockmap (when
electron-builder emits one), latest-mac.yml, latest.json and release-receipt.json. The
`personal-browser-recovery-journals` artifact holds the journal JSON files plus a
`marker.txt` export timestamp.

The release-set gate rejects `.env` and `.env.*` files at any depth in the signed
output, except the value-free templates `.env.example`, `.env.sample`, `.env.template`
and `.env.dist` that bundled dependencies sometimes ship; the Gitleaks gate still
scans their content.

The Gitleaks release gate derives its config from `scripts/public-boundary-gitleaks.toml`
but replaces the frozen bare GitHub-token-prefix rule with the token shape: four bytes
of compressed noise match the bare prefix by chance in large DMGs.

## Recovery

Use **Re-run failed jobs** on the same run, within the 30-day artifact retention. The
build artifact is reused, so byte-identical immutable R2 objects are accepted and a
pointer that already names the tag is not rewritten; a draft Release left by an
interrupted upload is removed before the Release is created. A fresh dispatch of a
partially published tag fails closed at the immutable-object guard (rebuilt DMG/ZIP
bytes differ), and so does a re-run after the artifact expired; ship the fix as a new
version and tag.

## Launch smoke limits

- The smoke requires exit code 0 after `app.close()`. If the packaged main process ever
  blocks quit (for example in `before-quit`), the smoke fails after its timeout.
- Playwright's Electron driver injects `--inspect=0` and `--remote-debugging-port=0`.
  This works because `packages/desktop-app` sets no Electron fuses today; turning off
  the `EnableNodeCliInspectArguments` fuse (or similar hardening) would break the
  smoke, which would then need a different launch driver.

## Secrets (environment `desktop-release`)

| Name | Purpose |
| --- | --- |
| `CSC_LINK` | base64 Developer ID Application `.p12` |
| `CSC_KEY_PASSWORD` | password of the `.p12` |
| `APPLE_ID` | notarytool Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | notarytool app-specific password |
| `APPLE_TEAM_ID` | notarytool team id; must equal the certificate OU |
| `CLOUDFLARE_ACCOUNT_ID` | wrangler account for R2 |
| `CLOUDFLARE_R2_API_TOKEN` | R2 read/write token for `instafy-downloads` (exported as `CLOUDFLARE_API_TOKEN`) |
| `CODEX_MACHINE_AUTH` (optional) | dedicated login bundle for the Personal Browser canary |
| `SUPABASE_SERVICE_ROLE_KEY` (optional) | provisions the disposable canary user; only with `CODEX_MACHINE_AUTH` |

Environment policy: selected branches and tags, exactly `desktop-app-v*` (tag) and
`main` (branch, for dispatch). Create the `desktop-release` environment with this policy
**before** merging this workflow or entering any secret: GitHub auto-creates a missing
environment with no branch/tag policy the first time a job references it. With the
`main` branch rule, secret isolation also relies on the actor check in authorize and on
review of every workflow merged to `main`. Repository variables: `DOWNLOADS_BASE_URL`,
`DOWNLOADS_BUCKET`, `DESKTOP_DOWNLOADS_PREFIX`, and for the optional canary
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (publishable key only).

## Cutover dry run (first real proof)

The offline tests cannot prove these; check them on the first
`gh workflow run desktop-release.yml --ref main -f tag=<next tag> -f dry_run=true`
before any `dry_run=false` or tag push:

- build: Gitleaks 8.30.1 parses the derived release config (check the step log
  shows the scan ran with it) and reports no findings on the signed output.
- build: the throwaway keychain import yields the Developer ID Application identity,
  `notarytool history` succeeds, and notarize + staple complete on `macos-15`.
- launch_smoke: `spctl --assess` accepts the extracted app and Playwright's Electron
  driver launches and closes it with exit code 0.
- personal_browser_canary (only when its optional secrets are set): the run-list
  journal lookup works with the job's `actions: read` token.
- publish (first `dry_run=false` only): the `gh api --paginate ... --jq` draft filter
  prints nothing when no draft exists, and the Release and receipt are created.

These are one-time checks by a maintainer watching the run, not settings to change.

## Tests

```sh
node --test scripts/release/desktop/*.test.mjs
```
