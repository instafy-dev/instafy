# iOS TestFlight internal release lane

Workflow: `.github/workflows/ios-release.yml` (GitHub-hosted `macos-15` for build and
upload, `ubuntu-24.04` for authorization and reconciliation). The tag is the ledger.

## Releasing

1. Bump `CURRENT_PROJECT_VERSION` (and `MARKETING_VERSION` if needed) in
   `packages/frontend/ios/App/App.xcodeproj/project.pbxproj` on `main`. App Store Connect
   rejects a build number it has already seen for the marketing version.
2. As `instafy-bot`, push the tag `ios-v<MARKETING_VERSION>-<CURRENT_PROJECT_VERSION>`
   (for example `ios-v1.0-82`) at a commit contained in `main`.
3. The run authorizes the tag (bot actor, bot triggering actor and pusher, commit on the
   resolved `refs/heads/main` commit, version equal to the
   pbxproj, no GitHub Release yet), builds and signs `Instafy.ipa`, uploads it once with
   `xcrun altool`, waits until App Store Connect reports the build `VALID`,
   `INTERNAL_ONLY`, `IN_BETA_TESTING` and in the internal group, with matching digests, and
   finally creates the GitHub Release with `release-receipt.json` and `Instafy.ipa`.

Receipt: `https://github.com/instafy-dev/instafy/releases/download/<tag>/release-receipt.json`
(`instafy-client-release-receipt-v1`, lane `ios`, secret-free).

## Dry run and recovery

- Dry run: `gh workflow run ios-release.yml --ref main -f tag=ios-v1.0-82 -f dry_run=true`.
  The tag may not exist yet (source = `main` head). Archive, export, signing and IPA checks
  run, App Store Connect is only observed, and the IPA is kept as an Actions artifact for
  7 days. Nothing is published.
- Only `instafy-bot` may start or re-run a release. GitHub keeps `github.actor` on a re-run,
  so every job that touches `ios-release` secrets also requires
  `github.triggering_actor == instafy-bot` (partial re-runs reuse the authorize outputs, so
  the check is repeated in `build`, `publish` and `reconcile_only`). A re-run clicked by a
  person fails before any secret step. Recover as the bot, for example
  `gh run rerun <run-id> --failed` with the bot token.
- Failure before the upload: re-run the failed jobs as the bot (the IPA artifact is
  overwritten on a `build` re-run).
- Queued runs: runs share a concurrency group per kind (`publish` or `dry-run`). GitHub keeps
  only one *pending* run per group and cancels the older pending one. A tag push run that was
  cancelled while queued never published anything; dispatch it again with
  `-f tag=<tag> -f dry_run=false`.
- `altool` can exit 0 on some delivery failures; the lane treats `product-errors` in its XML
  as a failure. In either case check App Store Connect and use `reconcile_only` if the build
  arrived.
- Upload accepted but the run died before the Release: dispatch
  `-f tag=<tag> -f dry_run=false -f reconcile_only=true`. This never uploads; it proves the
  same App Store Connect state and publishes a receipt whose IPA digests come from App
  Store Connect (`digestSource: app-store-connect`). Such a receipt proves only App Store
  Connect state for that build number: nothing binds the App Store Connect build to the tag's
  source, and `ota.trustKeySha256` comes from the current repository variable, not from the
  shipped IPA. While the private `ios-app.yml` lane still exists, never dispatch it by hand
  for the same build number, or a reconciled receipt could certify its upload.
- Anything else that already reached App Store Connect needs a new build number and tag.

## Setup order (security precondition)

Workflow files are read from the tag's own commit. The environment policy trusts any
`ios-v*` tag, so the tag ruleset must exist **before** the environment and its secrets:

1. Tag ruleset for `refs/tags/ios-v*`: restrict creation, update and deletion; bypass only
   `instafy-bot` (mirror the desktop release tag rulesets).
2. Environment `ios-release` with deployment policy "selected branches and tags", exactly
   `ios-v*` (tag) and `main` (branch). Create it explicitly: a job that names a missing
   environment auto-creates it with no policy. Optionally add required reviewers.
3. Secrets and variables below, then a dry run, then a real tag.

## Environment `ios-release`

Deployment policy: selected branches and tags, exactly `ios-v*` (tag) and `main` (branch).

| Secret | Purpose |
| --- | --- |
| `IOS_DEVELOPMENT_TEAM` | 10-character Apple Team ID |
| `IOS_DIST_CERT_P12_BASE64` | base64 PKCS#12 with exactly one Apple Distribution identity |
| `IOS_DIST_CERT_PASSWORD` | PKCS#12 password |
| `APP_STORE_CONNECT_KEY_ID` | App Store Connect API key id |
| `APP_STORE_CONNECT_ISSUER_ID` | App Store Connect issuer UUID |
| `APP_STORE_CONNECT_PRIVATE_KEY` | full `.p8` PEM |

Repository variables: `CAPACITOR_LIVE_UPDATE_PUBLIC_KEY` (RSA SPKI PEM, the OTA trust
anchor), `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (`sb_publishable_` only),
optional `VITE_CONTROLLER_URL`, `IOS_APP_STORE_PROFILE_ID`, `APP_STORE_CONNECT_APP_ID`,
`APP_STORE_CONNECT_INTERNAL_BETA_GROUP_ID`. The OTA signing private key is not used here.

Enter `APP_STORE_CONNECT_PRIVATE_KEY` with real newlines (paste the `.p8` file as-is); the lane
rejects literal `\n` escapes because `altool` reads the staged key byte for byte.

## Public exposure

This is a public repository. The run artifact `ios-ipa-<tag>` (signed IPA, `pre.json`,
`post-build.json` with App Store Connect app and beta group ids, `ota.json`, digests) can be
downloaded by any signed-in user, including from dry runs, and the IPA is also a Release
asset. None of it is secret, but nothing secret may ever be added to it.

## Hosted runner

`macos-15` must ship an `Xcode_26*.app`. If the image drops it, or App Store Connect raises
the SDK minimum past what the image carries, the lane fails in the Xcode selection step before
any signing; switch `runs-on` to `macos-26` (and update the workflow guard).

## Tests

`node --test scripts/release/ios/*.test.mjs` (the workflow guard parses the workflow text
and pins triggers, permissions, environments, runners, actions and publication order).
