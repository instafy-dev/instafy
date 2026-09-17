# Hosted Web Release

`.github/workflows/web-release.yml` builds and publishes the hosted web app
(Cloudflare Pages) from this repository on GitHub-hosted runners.

## What ships

`scripts/release/web/build-hosted-web.mjs` builds `@instafy/frontend` with
`INSTAFY_FRONTEND_FEATURE_MANIFEST` set to
`packages/frontend/hosted/hostedFrontendFeatureManifest.ts`, which composes:

1. the public core feature module;
2. the vendored robot integration slice in `packages/frontend/hosted/robot/`
   (generated, never edited by hand; see its README);
3. the Studio performance bridge in `packages/frontend/hosted/performance/`,
   whose transport is disabled in this lane.

Standalone, OTA and Desktop builds keep the public default manifest. Tailwind
does not scan `packages/frontend/hosted/` (`@source not` in
`src/styles/tailwind.css`), so those builds are byte-for-byte unaffected.

`dist/instafy-build.json` is served publicly as exactly
`{"schemaVersion":2,"releaseId":"<sha256>"}` where
`releaseId = sha256("instafy-hosted-frontend:v3:" + <release commit>)`.

## Triggers

- **Release:** instafy-bot pushes the immutable tag `web-v<first 12 hex>` at a
  protected-main commit (retries use `web-v<first 12 hex>-r2` … `-r99`). Only the
  release train's hand-off creates these tags, after the backend release the
  frontend depends on.
- **Dry run:** `gh workflow run web-release.yml --ref main -f tag=web-v<main head 12 hex>`
  as instafy-bot. It authorizes, builds, verifies and seals the main head and
  publishes nothing.

## Jobs

| Job | Secrets | What it proves |
| --- | --- | --- |
| Authorize the exact web tag | none | bot actor and pusher, tag shape, tag peels to `github.sha`, commit on protected main, lane contract tests |
| Build and seal the exact hosted web frontend | none | publishable browser config, exact release metadata, all three feature modules present, no private strings, pinned Gitleaks, reproducible archive |
| Publish the exact hosted web frontend | `web-release` | archive digest, safe members, per-file hashes, tag still bound, no stale publish, production serves exactly this release, automatic rollback on failure |

## The `web-release` environment

- Deployment policies: branch `main` and tag `web-v*`.
- Secrets: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PAGES_API_TOKEN`.
- Variables: `CLOUDFLARE_PAGES_PROJECT`, `PUBLIC_APP_URL`,
  `HOSTED_FRONTEND_PUBLISH_ENABLED` (must be exactly `true` to publish; set it to
  `false` to stop publication without touching anything else).

Browser configuration comes from repository variables `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY` (publishable key only), `VITE_CONTROLLER_URL`, and the
optional `VITE_REQUIRE_AUTH`, `VITE_USE_WEBCONTAINER` and
`VITE_INSTAFY_ENABLE_GOOGLE_AUTH` (kill switch, default `1`).

## Stale, duplicate and failed publications

- A tag whose commit is behind (or diverged from) the commit of the current
  production deployment is refused before any mutation.
- A release production already serves is proved again but not redeployed.
- If the proof fails after the deploy started, the job restores the previous
  production deployment. The next attempt uses a new `-r<N>` tag.
