# Package Releases

Instafy uses Changesets as the only supported source of version and changelog changes for public
npm packages. The current publishable packages are `@instafy/cli` and
`@instafy/provider-contract`. Private workspace packages, services, images, migrations, the
frontend, and Desktop releases are deliberately outside this system.

## Contributor flow

Use Node 22.11 LTS, Node 24, or a supported newer even-numbered release for Changesets commands.
Fetch protected `main`, make the package change, and run:

```bash
git fetch origin main
pnpm changeset
pnpm release:status --since=origin/main
```

Select every affected public package and the smallest correct bump. A breaking change below
`1.0.0` is a minor bump; a backward-compatible feature or fix is a patch bump. The summary is
customer-facing release-note text.

Do not manually edit a public package's `version` or `CHANGELOG.md`. The protected-main release
workflow turns pending changesets into one signed version pull request and keeps it updated as
additional changes land. A daily job merges that pull request through the merge queue, which
publishes the packages automatically. Changes
confined to a package's `test/` directory are exempt because that directory is not part of the npm
artifact.

## Version and publication boundary

The release workflow uses four isolated stages:

1. **Select** reevaluates Changesets state on every protected-main commit without credentials, so
   an unrelated commit cannot strand a pending release.
2. **Version** uses the Instafy bot's repository-only credential to open or update the version
   pull request. It has no npm authority.
3. **Pack** builds and tests publishable packages without npm or repository-write credentials and
   uploads immutable tarballs.
4. **Publish** runs automatically once Pack succeeds; there is no manual approval step. It runs in
   the `npm-release` environment, which only protected branches can use, and npm trusted
   publishing accepts OIDC tokens only from this workflow in that environment. Publish rechecks
   that its commit is still current protected `main`, seals package-manager configuration to the
   canonical npm registry, verifies the downloaded pack, and publishes the same tarballs without
   rebuilding them. The final receipt proves both exact registry bytes and that `latest` points at
   the planned version.

Registry readback can lag a successful upload. Post-publication verification waits up to five
minutes per package for the exact integrity and `latest` dist-tag to become visible, using only
read-only registry requests bounded by the remaining deadline. It never retries publication.
Conflicting immutable bytes, malformed responses and registry errors fail immediately; a timeout
does not prove that the upload failed. Inspect the exact published version before recovery and
never republish an immutable version just because its receipt is missing.

Pull-request checks run on hosted runners with read-only repository access and no secrets.
Publishing never runs from `pull_request` or `pull_request_target`. Every external Action is pinned
to an immutable commit.

The independently default-off `CI_PUBLIC_CONTROL_SELF_HOSTED` switch can route
the protected-main push and exact-current-main manual **Select**, **Version** and **Pack**
jobs to authenticated disposable Linux ARM64 runners while the canonical repository
remains private. Other sources and events retain hosted routing. Manual runs require
the defining workflow SHA to match the event SHA and independent current-main
admission; see [protected-main manual CI](Testing.md#protected-main-manual-ci).
Version retains Select's version mode and the existing
repository-only bot credential in its two original steps; it is not credential-free.
Its isolated-runner preflight precedes checkout, and a fresh protected-main and
checkout-SHA check immediately precedes bot authorization. The earlier Select
check alone cannot authorize a Version job delayed in the queue. Publish and
npm OIDC routing are unchanged. Pack still requires Select's publish mode and
exact immutable plan, tests the packages and uploads only verified tarballs; it has no npm OIDC or
repository-write authority. This requires separate exact-job runner admission,
baseline-tool qualification and cold execution/cleanup proof before enabling the switch; see
[Testing](Testing.md). It does not grant npm publication authority or make the
remaining hosted release stages available.

The source repository is currently internal. npm trusted publishing can still replace static npm
tokens, but npm will not generate public provenance attestations until the source repository is
public. Do not claim provenance before that visibility boundary changes.

## Releasing

Releases go out automatically once a day when package changes are pending. No one needs to click
anything.

The Instafy bot opens the version pull request (`chore(release): version npm packages`, branch
`changeset-release/main`) as a draft and refreshes it on every protected-main change while
changesets are pending. Every day at 06:43 UTC the
[npm Daily Release](../.github/workflows/npm-release-daily.yml) workflow finds that pull request,
marks it ready for review and turns on auto-merge, pinned to the head it inspected. The merge
queue then runs every required check and merges it like any other pull request. If no version
pull request is open, or it changes no package version, the run does nothing.

Merging the version pull request into protected `main` is the release. The push that merge makes
runs Select in publish mode, then Pack and Publish, with no further human step. The safeguards are
protected `main` itself (changes land only through pull requests that pass the required checks
and the merge queue), the isolated stages above, the exact-bytes pack verification and the
post-publish registry readback.

To release sooner, run **npm Daily Release** from the Actions tab on `main` (or
`gh workflow run npm-release-daily.yml --ref main`). It does the same thing as the daily run, and
running it again is harmless.

The daily job only touches the open pull request from this repository's
`changeset-release/main` branch that `instafy-bot` authored with the version pull request's
title. It runs only from protected `main`, checks nothing out, approves nothing and bypasses
nothing. It looks the pull request up with the read-only workflow token and uses the existing
repository-only bot credential only to mark it ready and turn on auto-merge. That credential is
needed for two reasons: GitHub starts no workflows for events made with the workflow token, so a
merge armed with it would not run Publish, and only `instafy-bot` is exempt from code-owner
review. It shares npm-release's protected-main lock, so it never races a version refresh or a
publication.

Before a new package's first release, configure its npm trusted publisher with the exact
repository, workflow filename and `npm-release` environment.

## Recovery

To hold a release, add the `release-hold` label to the version pull request and turn off its
auto-merge (or remove it from the merge queue); the daily job leaves a held pull request alone
until the label is removed. The `release-freeze` ruleset pauses it too. Before publication you can
also land a corrected changeset; once the version pull request merges, publication follows. Published npm versions are immutable. If a bad
version reaches npm, move the relevant dist-tag back to the last good version, deprecate the bad
version, and publish a corrected new version. Never reuse or move an immutable release version or
tag. Unpublishing is reserved for a severe exposure and follows npm's restrictions; it is not a
normal rollback mechanism.
