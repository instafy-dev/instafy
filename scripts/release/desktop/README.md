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
  publishes an existing tag that never ran (for example a tag created before this
  workflow existed on that commit), or one whose tag-push run was cancelled.

Concurrency: runs are grouped per tag, and the publish job has its own global group,
so stable-pointer writes never race. GitHub keeps only one *pending* run or job per
group; if a queued tag run or publish job is ever cancelled that way, re-run it
(or dispatch `dry_run=false` for the tag).

## Jobs

| Job | Runner | Environment | Does |
| --- | --- | --- | --- |
| authorize | ubuntu-24.04 | none | actor/pusher, peeled tag commit, `compare/<sha>...main` is identical or ahead, source version, contract tests, one-shot probes (live `latest.json` older, no GitHub Release, Worker pointer contract) |
| preflight | ubuntu-24.04 | desktop-release | picks `personal-browser` when the optional canary credentials exist with 24 h left, else `launch-smoke` |
| build | macos-15 | desktop-release | credential sanity, isolated keychain, `pnpm --filter @instafy/desktop-app dist` (notarize + staple), signature/staple/DMG checks, release-set and Gitleaks gates, artifact upload |
| launch_smoke | macos-15 | none | safe ZIP extraction, `spctl`, packaged launch through Playwright's Electron driver |
| personal_browser_canary | macos-15 | desktop-release | the production Personal Browser agent-turn canary (opt-in); restores recovery journals only from this workflow's own push/dispatch runs on `main` or `desktop-app-v*` in this repository (`recovery-journals.mjs`) |
| publish | ubuntu-24.04 | desktop-release | `publish-downloads.sh`, `release-receipt.json`, `gh release create` last |

Lane tooling (`scripts/release/desktop/**`) is read from the workflow commit; the product
bytes are built from the tag commit.

The GitHub Release carries the dmg, zip, zip.blockmap, dmg.blockmap (when
electron-builder emits one), latest-mac.yml, latest.json and release-receipt.json. The
`personal-browser-recovery-journals` artifact holds the journal JSON files plus a
`marker.txt` export timestamp.

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

## Tests

```sh
node --test scripts/release/desktop/*.test.mjs
```
