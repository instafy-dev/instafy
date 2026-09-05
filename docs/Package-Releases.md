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
additional changes land. Changes confined to a package's `test/` directory are exempt because
that directory is not part of the npm artifact.

## Version and publication boundary

The release workflow uses four isolated stages:

1. **Select** reevaluates Changesets state on every protected-main commit without credentials, so
   an unrelated commit cannot strand a release waiting for approval.
2. **Version** uses the Instafy bot's repository-only credential to open or update the version
   pull request. It has no npm authority.
3. **Pack** builds and tests publishable packages without npm or repository-write credentials and
   uploads immutable tarballs.
4. **Publish** runs only after the protected `npm-release` environment is approved. It receives
   npm OIDC authority, seals package-manager configuration to the canonical npm registry, verifies
   the downloaded pack, and publishes the same tarballs without rebuilding them. The final receipt
   proves both exact registry bytes and that `latest` points at the planned version.

Registry readback can lag a successful upload. Post-publication verification waits up to five
minutes per package for the exact integrity and `latest` dist-tag to become visible, using only
read-only registry requests bounded by the remaining deadline. It never retries publication.
Conflicting immutable bytes, malformed responses and registry errors fail immediately; a timeout
does not prove that the upload failed. Inspect the exact published version before recovery and
never republish an immutable version just because its receipt is missing.

Pull-request checks run on hosted runners with read-only repository access and no secrets.
Publishing never runs from `pull_request` or `pull_request_target`. Every external Action is pinned
to an immutable commit.

The source repository is currently internal. npm trusted publishing can still replace static npm
tokens, but npm will not generate public provenance attestations until the source repository is
public. Do not claim provenance before that visibility boundary changes.

## Bootstrap and release approval

The Changesets bootstrap resets package manifests to their last published registry versions and
records all already-landed unpublished work as explicit changesets. This guarantees that the first
automated action is a reviewable version pull request instead of an immediate publication.

Before merging a version pull request, verify that npm trusted publishers are configured for each
package with the exact repository, workflow filename, and `npm-release` environment. Auto-merge is
not publication authority: it may be enabled for ordinary reviewed changes, but a version pull
request stays unarmed until the release approver has verified the generated versions and release
notes.

## Recovery

Before publication, close or revise the version pull request or reject the protected-environment
approval. Published npm versions are immutable. If a bad version reaches npm, move the relevant
dist-tag back to the last good version, deprecate the bad version, and publish a corrected new
version. Never reuse or move an immutable release version or tag. Unpublishing is reserved for a
severe exposure and follows npm's restrictions; it is not a normal rollback mechanism.
