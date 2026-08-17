# Package changesets

Changesets are the source of truth for versions and release notes of Instafy's public npm
packages. Do not edit a publishable package's `version` or `CHANGELOG.md` by hand.

For every user-visible or package-contract change to `@instafy/cli` or
`@instafy/provider-contract`:

1. Fetch protected `main` so the comparison base is current.
2. Run `pnpm changeset` with a Changesets-supported runtime (Node 22.11 LTS, Node 24, or a
   supported newer even-numbered release).
3. Select every affected public package and the smallest correct SemVer bump.
4. Write a consumer-facing summary. Describe behavior, not implementation mechanics.
5. Commit the generated Markdown file with the code change.

For packages below `1.0.0`, use a minor bump for a breaking change and a patch bump for a
backward-compatible change. Changes confined to a package's `test/` directory do not need a
changeset because that directory is excluded from the npm artifact.

Protected-main automation combines pending changesets into a signed version pull request. That
pull request updates package manifests and changelogs and consumes the changeset files. After the
version pull request is reviewed and merged, the release workflow packs and tests the exact npm
artifacts without credentials, then publishes those same artifacts from the protected
`npm-release` environment.

Changesets do not version Docker images, hosted services, database migrations, the frontend, or
Desktop releases. Those surfaces retain their immutable commit/digest deployment receipts.

See [Package Releases](../docs/Package-Releases.md) for the complete policy and recovery flow.
