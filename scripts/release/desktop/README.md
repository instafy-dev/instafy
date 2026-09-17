# Desktop release lane

`.github/workflows/desktop-release.yml` publishes the signed macOS arm64 Desktop app
from this public repository on free GitHub-hosted runners. The immutable tag is the
ledger: there are no deployment ledgers, journals or merge freezes.

## Trigger

- `desktop-app-v<MAJOR.MINOR.PATCH>` pushed by `instafy-bot` at a commit on protected
  `main` whose `packages/desktop-app/package.json` version equals the tag version.
- `gh workflow run desktop-release.yml --ref main -f tag=<tag> -f dry_run=true|false`
  as `instafy-bot`. `dry_run=true` (default) builds, signs, notarizes and smoke-tests
  but publishes nothing; the signed artifact is kept for 7 days. `dry_run=false`
  publishes an existing tag that never ran (for example a tag created before this
  workflow existed on that commit).

## Jobs

| Job | Runner | Environment | Does |
| --- | --- | --- | --- |
| authorize | ubuntu-24.04 | none | actor/pusher, peeled tag commit, `compare/<sha>...main` is identical or ahead, source version, contract tests, one-shot probes (live `latest.json` older, no GitHub Release, Worker pointer contract) |
| preflight | ubuntu-24.04 | desktop-release | picks `personal-browser` when the optional canary credentials exist with 24 h left, else `launch-smoke` |
| build | macos-15 | desktop-release | credential sanity, isolated keychain, `pnpm --filter @instafy/desktop-app dist` (notarize + staple), signature/staple/DMG checks, release-set and Gitleaks gates, artifact upload |
| launch_smoke | macos-15 | none | safe ZIP extraction, `spctl`, packaged launch through Playwright's Electron driver |
| personal_browser_canary | macos-15 | desktop-release | the production Personal Browser agent-turn canary (opt-in) |
| publish | ubuntu-24.04 | desktop-release | `publish-downloads.sh`, `release-receipt.json`, `gh release create` last |

Lane tooling (`scripts/release/desktop/**`) is read from the workflow commit; the product
bytes are built from the tag commit.

## Recovery

Use **Re-run failed jobs** on the same run. The build artifact is reused, so
byte-identical immutable R2 objects are accepted and a pointer that already names the
tag is not rewritten. A fresh dispatch of a partially published tag fails closed at
the immutable-object guard; ship the fix as a new version and tag.

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
`main` (branch, for dispatch). Repository variables: `DOWNLOADS_BASE_URL`,
`DOWNLOADS_BUCKET`, `DESKTOP_DOWNLOADS_PREFIX`, and for the optional canary
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (publishable key only).

## Tests

```sh
node --test scripts/release/desktop/*.test.mjs
```
