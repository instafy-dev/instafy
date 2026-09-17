# Android Release (Google Play internal)

`.github/workflows/android-release.yml` publishes the Capacitor Android app
(`dev.instafy.studio`) to the Google Play **internal** track from this repository on hosted
`ubuntu-24.04` runners. The bot-pushed immutable tag `android-v<versionName>-<versionCode>` is the
ledger. The GitHub Release that carries `release-receipt.json` is created last and is the one-shot
marker.

## The secret boundary

The Play upload keystore and the Play service account sit in the `android-release` environment.
**The workflow's own checks are not what keeps those secrets safe.** A run executes the workflow
file at the ref it runs on. Anyone who can create a ref the environment accepts can write a
workflow there with no `authorize` job and read every secret. The actor, pusher,
compare-to-main and version checks inside the workflow catch mistakes and misuse of the bot's
own token. They do not stop a malicious writer.

The boundary is made of three repository settings:

1. **Tag rulesets on `refs/tags/android-v*`.** Only the bot may create these tags, and nobody may
   update or delete them. This matches `desktop-app-v*` today.
2. **The environment deployment policy.** It accepts only tag `android-v*` and branch `main`.
3. **Protected `main`.** Workflow changes need a reviewed pull request.

## One-time setup (in this order)

Do not enter any secret until steps 1 and 2 are done and read back.

1. **Create the tag rulesets first.**
   - `android-release-tags`: target tag, include `refs/tags/android-v*`, rule *Restrict
     creations*, bypass list = the `instafy-bot` user only.
   - `android-release-tags-immutable`: target tag, include `refs/tags/android-v*`, rules
     *Restrict updates* and *Restrict deletions*, empty bypass list.
2. **Read them back.** Run `gh api repos/instafy-dev/instafy/rulesets` and check that both rulesets
   are `active` and include exactly `refs/tags/android-v*`.
3. **Create the `android-release` environment.** Under deployment branches and tags, choose
   *Selected branches and tags*: tag `android-v*` and branch `main`. Nothing else.
4. **Enter the six environment secrets:** `ANDROID_UPLOAD_KEYSTORE_B64`,
   `ANDROID_UPLOAD_KEYSTORE_TYPE`, `ANDROID_UPLOAD_KEYSTORE_PASSWORD`, `ANDROID_UPLOAD_KEY_ALIAS`,
   `ANDROID_UPLOAD_KEY_PASSWORD` and `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
5. **Set the repository variables:** `CAPACITOR_LIVE_UPDATE_PUBLIC_KEY`, `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY` (must be `sb_publishable_*`), and optionally `VITE_CONTROLLER_URL`.

### OTA trust key format

`CAPACITOR_LIVE_UPDATE_PUBLIC_KEY` must be the **canonical SPKI PEM**. That is the exact output
of `createPublicKey(key).export({ type: "spki", format: "pem" }).toString().trim()`: LF line
endings, 64-column base64 and a `BEGIN PUBLIC KEY` block. The OTA authority computes its
fingerprint over that form. `scripts/release/android/trust-key.mjs` refuses every other byte form
of the same key, so the receipt's `destination.ota.trustKeySha256` always matches the OTA lane.
The refused forms include CRLF, other line wrapping and PKCS#1 `RSA PUBLIC KEY` blocks.
`inspect-aab.py` also refuses a non-canonical embedded key. To produce the value, run
`OTA_SIGNING_PRIVATE_KEY=... node scripts/resolve-live-update-public-key.mjs --print`.

## Running

- **Release:** the bot pushes `android-v<versionName>-<versionCode>` at a commit on `main`. The
  tag must equal `versionName`/`versionCode` in `packages/frontend/android/app/build.gradle` at
  that commit.
- **Dry run:** `workflow_dispatch` from `main` with `tag=<intended tag>` and `dry_run=true`. It
  builds, signs and verifies the AAB and runs a real Play observe, but publishes nothing.
- **Only the bot can start or re-run a run.** The workflow requires both `GITHUB_ACTOR` and
  `GITHUB_TRIGGERING_ACTOR` to be `instafy-bot`, checked in `authorize`, `build` and `publish`.
  A person clicking *Run workflow* or *Re-run* in the UI fails at that check. Use the bot token
  instead, with `gh workflow run android-release.yml --ref main -f tag=... -f dry_run=true` or
  `gh run rerun <id> --failed`. This is a guard against accidents, not the secret boundary
  (see above).
- **Concurrency:** dry runs and releases use separate groups, so a dry run never displaces a
  pending release. Within a group GitHub keeps only one pending run. Push tags one at a time and
  wait for each run to finish.

## Recovery

- **Transient failure:** re-run the failed jobs with the bot token. The same run reuses the
  same AAB. If Play already shows this exact release with identical bytes, `publish` skips the
  upload and only reconciles.
- **Play review conflict:** a commit rejected by `ERROR_IF_IN_REVIEW` leaves Play unchanged.
  Re-run after the unrelated review clears.
- **Interrupted `gh release create`:** this can leave a draft release, and a draft is invisible
  to `releases/tags/<tag>`. `release-refs.sh recheck` lists drafts and fails closed while one
  exists. Delete the draft, then re-run.
- **Anything after a successful publication** needs a new `versionCode` and a new tag.

## Contract notes for the private train

- Key verification on `destination.aab.sha256` and `version`. `destination.play.stateSha256` is
  the post-publish observation, not the build preflight baseline.
- `publicationGate` is stricter than the private provider. It is `attention` when an internal
  track release references a `versionCode` that is not in `edits.bundles.list`. That list covers
  AABs only, so an old APK-based internal release would block preflight and reconcile. This fails
  closed. `dev.instafy.studio` publishes only AABs.
- `inspect-aab.py` checks every `.js`/`.mjs` under `base/assets/public/`. The set of OTA channel
  markers must be exactly `{internal}`, and some script must contain the source commit. The
  private inspector followed only the scripts reachable from `index.html`, and required the marker
  exactly once.
- The release-artifact Gitleaks scan (`gitleaks-release-artifact.mjs`) derives a release-only
  config from `scripts/public-boundary-gitleaks.toml`. In that config, the bare GitHub token prefix
  rule is replaced by the full-token regex. The bare prefix matches random bytes inside compressed
  binaries.
- `jarsigner` proves that the AAB has a valid JAR signature. It does not compare the signer
  certificate with the keystore; the private lane did not either. Play rejects an AAB signed by
  any key other than the registered upload key.

## Public visibility

Any signed-in user can download workflow artifacts in a public repository. A dry run therefore
exposes a signed AAB of `main` source for 7 days. A release attaches the AAB to the public GitHub
Release anyway.
