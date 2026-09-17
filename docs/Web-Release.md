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

## The secret boundary

The Cloudflare Pages token sits in the `web-release` environment. **The
workflow's own checks are not what keeps it safe.** A run executes the workflow
file at the ref it runs on, so anyone who can create a ref the environment
accepts can push a copy of `web-release.yml` without the `authorize` job and
receive the token. The actor, pusher and compare-to-main checks catch mistakes
and misuse of the bot's own token; they do not stop a malicious writer.

The boundary is three repository settings:

1. **Tag rulesets on `refs/tags/web-v*`.** Only instafy-bot may create these
   tags, and nobody, including the bot, may update or delete them.
2. **The environment deployment policy.** It accepts only tag `web-v*` and
   branch `main`.
3. **Protected `main`.** Workflow changes need a reviewed pull request.

## One-time setup (in this order)

Do not enter any secret until steps 1 and 2 are done and read back.

1. **Add `refs/tags/web-v*` to the tag rulesets first.** Either extend the
   existing client release rulesets or create a dedicated pair:
   - `client-release-tags` (or `web-release-tags`): target tag, include
     `refs/tags/web-v*`, rule *Restrict creations*, bypass list = the
     `instafy-bot` user only.
   - `client-release-tags-immutable` (or `web-release-tags-immutable`): target
     tag, include `refs/tags/web-v*`, rules *Restrict updates* and *Restrict
     deletions*, empty bypass list.
2. **Read them back.** Run `gh api repos/instafy-dev/instafy/rulesets` and
   `gh api repos/instafy-dev/instafy/rulesets/<id>` for each, and check that both
   are `active`, include `refs/tags/web-v*`, and that only the creation ruleset
   has a bypass actor (instafy-bot).
3. **Create the `web-release` environment.** Deployment branches and tags:
   *Selected branches and tags*, tag `web-v*` and branch `main`. Nothing else.
4. **Enter the secrets:** `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PAGES_API_TOKEN`.
5. **Set the environment variables:** `CLOUDFLARE_PAGES_PROJECT`,
   `PUBLIC_APP_URL`, `HOSTED_FRONTEND_PUBLISH_ENABLED` (must be exactly `true`
   to publish; set it to `false` to stop publication without touching anything
   else), and, for the cutover only, `HOSTED_WEB_ADOPTED_DEPLOYMENT_ID` (below).
6. **Dispatch a dry run** from `main` (see Triggers) before the first release tag.

Browser configuration comes from repository variables `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY` (publishable key only), `VITE_CONTROLLER_URL`, and the
optional `VITE_REQUIRE_AUTH`, `VITE_USE_WEBCONTAINER` and
`VITE_INSTAFY_ENABLE_GOOGLE_AUTH` (kill switch, default `1`).

## Stale, duplicate and failed publications

- A tag whose commit is behind (or diverged from) the commit of the current
  production deployment is refused before any mutation.
- A production deployment whose commit is not a commit of this repository, or
  that carries no commit hash, was published by something other than this lane.
  Its age cannot be proved from here, so it is replaced only when
  `HOSTED_WEB_ADOPTED_DEPLOYMENT_ID` names exactly that deployment id. For the
  cutover, read the current production deployment id from Cloudflare, confirm it
  serves the release the release train last recorded, and set the variable to
  it. The variable is inert once this lane has published, and it never matches a
  later deployment from another publisher, so a late or re-run tag cannot
  overwrite one. Delete the variable after the first publication.
- A release production already serves is proved again but not redeployed.
- If the proof fails after the deploy started, the job restores the previous
  production deployment. The next attempt uses a new `-r<N>` tag.

## Moving publication back to the release train

GitHub concurrency groups do not span repositories, so this lane and any other
publisher of the same Pages project are not serialized against each other.
Before another publisher deploys, set `HOSTED_FRONTEND_PUBLISH_ENABLED=false` in
`web-release`; that stops runs already queued here as well as tags already
pushed. Even without it, a run that starts after the other publisher's
deployment refuses (that deployment is not adopted); only a run already past its
publication decision can still land, which the variable closes.
