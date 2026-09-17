# iOS TestFlight internal release lane

Workflow: `.github/workflows/ios-release.yml` (GitHub-hosted `macos-15` for build and
upload, `ubuntu-24.04` for authorization and reconciliation). The tag is the ledger.

## Releasing

1. Bump `CURRENT_PROJECT_VERSION` (and `MARKETING_VERSION` if needed) in
   `packages/frontend/ios/App/App.xcodeproj/project.pbxproj` on `main`. App Store Connect
   rejects a build number it has already seen for the marketing version.
2. As `instafy-bot`, push the tag `ios-v<MARKETING_VERSION>-<CURRENT_PROJECT_VERSION>`
   (for example `ios-v1.0-82`) at a commit contained in `main`.
3. The run authorizes the tag (bot actor and pusher, commit on `main`, version equal to the
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
- Failure before the upload: use "Re-run failed jobs" on the same run.
- Upload accepted but the run died before the Release: dispatch
  `-f tag=<tag> -f dry_run=false -f reconcile_only=true`. This never uploads; it proves the
  same App Store Connect state and publishes a receipt whose IPA digests come from App
  Store Connect (`digestSource: app-store-connect`).
- Anything else that already reached App Store Connect needs a new build number and tag.

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

## Tests

`node --test scripts/release/ios/*.test.mjs` (the workflow guard parses the workflow text
and pins triggers, permissions, environments, runners, actions and publication order).
