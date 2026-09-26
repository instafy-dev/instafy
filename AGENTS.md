# Instafy contributor and agent guide

Instafy is an open-source, self-hostable AI development workspace. This file describes the
rules for changing the public core. Product strategy, hosted operations, live credentials,
release signing and deployment configuration do not belong here.

## Architecture boundaries

- Keep the public packages independently buildable and useful to self-hosters.
- Put reusable contracts, permissions, provider calls, project bindings and UI primitives in
  the public core.
- Keep provider-specific features behind the typed feature-module and provider interfaces.
  Do not hard-code one optional product into the generic frontend, Desktop or mobile shells.
- Prefer trusted, statically imported build-time composition. Do not add remote code loading,
  arbitrary IPC, filesystem plugin discovery or a marketplace without a concrete requirement.
- The controller is the authority for workspace access, credentials, leases and policy.
  Runtimes and browser clients should receive only the minimum scoped data they need.
- All model traffic goes through the configured Instafy proxy. Do not call model providers
  directly from the browser or runtime agent.

## Security invariants

- Never commit live `.env` files, tokens, private keys, credentials, signing material or
  production configuration. Add only documented `.example` templates with inert values.
- Every `VITE_` variable is browser-visible. Never put a service-role key or other privileged
  credential behind a `VITE_` name.
- Browser code uses user authentication and row-level security. Administrative setup belongs
  in server-side tooling and test fixtures.
- Keep credential refresh and source material controller-owned. Renderers and runtime agents
  must not receive refresh tokens or raw credential-storage files.
- Constrain filesystem operations to the active project root, reject traversal and symlink
  escapes, and preserve the existing permission checks.
- Treat public pull requests as untrusted. Public CI must use hosted runners and must not
  receive repository, deployment or production secrets.
- Outside contributions need a trusted code-owner review before merge. A green check,
  workflow-run approval, issue comment or prior contribution is not merge approval. Never
  auto-approve or re-author outsider changes as a bot PR to avoid that review. The existing
  trusted bot's own changes keep their normal protected-check and auto-merge flow; do not
  impose a blanket approval requirement on every PR.
- Protected local credentials may intentionally cover both `instafy-dev/instafy` and
  `instafy-dev/instafy-internal` for explicitly authorized cross-repository release or operations
  work. That cross-repository scope is allowed: target authenticated commands at an explicit
  repository and exact ref, keep credential values out of output and tracked files, and never
  expose them to public CI or untrusted code.
- Database changes require ordered, additive migrations. Never reset or destructively rewrite
  a shared database.

## Working in the repository

1. Read [README.md](README.md), [DEV_SETUP.md](DEV_SETUP.md) and the relevant document under
   [docs/](docs/README.md) before changing a subsystem.
2. Inspect the nearest tests and package manifest. Follow established package boundaries
   instead of reaching across directories with relative imports.
3. Make the smallest coherent change and add a regression test for behavior changes.
4. Run the narrowest relevant checks while iterating, then the package-level checks before
   handing off.
5. Report commands that actually ran, any checks that remain, and any behavior or compatibility
   change. Do not claim a no-op command as validation.

Changesets are mandatory release intent for publishable npm packages. Add a changeset for every
user-visible or contract change to `@instafy/cli` or `@instafy/provider-contract`; do not edit
their versions or changelogs manually. Changes confined to a package's `test/` directory are
exempt because they cannot enter the npm artifact. See [Package Releases](docs/Package-Releases.md).

Useful frontend checks:

```bash
pnpm --filter @instafy/frontend lint
pnpm --filter @instafy/frontend exec tsc --noEmit -p tsconfig.json
pnpm --filter @instafy/frontend test:unit
pnpm --filter @instafy/frontend build
```

For Rust packages, run `cargo fmt --check` and the affected crate's `cargo check --tests` or
targeted tests. For scripts and packaging changes, run their focused Node tests and prove the
generated or packed artifact from a clean temporary directory.

Environment-gated browser, mobile, Desktop, Docker and hardware suites should stay explicit.
Do not silently turn a missing external dependency into a passing test.

## Driving the app as a signed-in user

Everything past `/login` needs a session, so verification usually stops at the login wall and the
Studio goes untested. Mint a throwaway user instead — no human, no mailbox, no real account:

```bash
pnpm exec supabase --workdir supabase start        # if the local stack is not already up
node scripts/mint-test-user.mjs --json
```

That prints the user plus `storageKey` and `localStorageValue`, which are exactly what the
frontend's Supabase client reads. Put them in the browser and reload, and the next page load is
authenticated:

```js
localStorage.setItem(storageKey, localStorageValue);
```

Delete what you created when you are done — `--cleanup-all-test-users` removes every user this
tool has ever minted on the target:

```bash
node scripts/mint-test-user.mjs --cleanup <userId>
node scripts/mint-test-user.mjs --cleanup-all-test-users
```

Two things worth knowing before you reach for it:

**The storage key is derived, not fixed.** supabase-js builds it from the URL's first hostname
label, so a local stack is `sb-127-auth-token` — not the project ref. Read it from the tool's
output rather than hardcoding it.

**It defaults to the local stack and defends that choice.** A production `service_role` key really
does live in `INSTAFY_ENV_DIR/.env.supabase` on developer machines, and the shared resolvers
consult `process.env` before the local CLI, so a shell that has sourced it otherwise yields a
self-consistent production pair. The tool therefore ignores `process.env` for local targets and
checks the admin key's own issuer claim rather than trusting a localhost URL. Writing to a real
project needs two independent opt-ins — `--target remote` **and**
`INSTAFY_MINT_TEST_USER_ALLOW_REMOTE=<project-ref>` naming that exact project. Do not add a way
around this.

## Release automation

The protected-main image workflow in `.github/workflows/continuous-image-publication.yml`
dispatches immutable service and runtime image publishers only after the exact public-main commit
passes Public Build. Each five-minute reconciliation checks once and releases its worker. The push
pass usually finds Build still running and defers; the completion of that exact protected-main push
Build (a guarded `workflow_run`, the only privileged trigger allowed there) starts the pass that
publishes, and the six-hour schedule or an explicit exact-main dispatch reconciles anything left.
Run lookups never use GitHub's event-filtered listings, which are intermittently served stale.
A successful coordinator is not publication proof: consumers still require successful
child publishers and their sealed exact-commit manifests. Fresh manifests must retain at least
14 days of their 90-day retention. A sealed publication with a stale or missing manifest fails
closed rather than attempting to overwrite an immutable release. Mutable tags are not release
authority. Image publication makes an artifact deployable but does not deploy the hosted product.

Hosted rollout authority lives in the private operations repository. Public CI must not receive
its credentials, decide production rollout policy or bypass the exact-commit manifest boundary.

## Code conventions

- Frontend code uses React, TypeScript, Vite and the existing component primitives. Preserve
  responsive behavior, keyboard access and stable `data-testid` selectors.
- Keep files focused. Extract shared logic when it has more than one real consumer, not in
  anticipation of one.
- Preserve backward-compatible controller and event shapes unless a versioned migration is
  part of the change.
- Use the workspace as the source of truth. Do not persist source snapshots or build caches as
  application state.
- Keep integrations optional and capability-driven rather than embedding a single deployment
  pipeline into core conversation or workspace APIs.

## Before submitting

- Confirm `git diff --check` is clean.
- Review the diff for credential material, personal paths and provider-specific implementation
  that belongs outside the generic core.
- Verify new package, workflow, Docker and script references exist in a clean checkout.
- Verify every publishable-package change has the correct Changeset and that package versions
  were not edited outside the generated version pull request.
- Update public documentation when behavior or setup changes.
- Do not publish packages, push release tags, deploy services or change repository visibility as
  part of an ordinary code change. Perform those operations only when the user explicitly
  authorizes the release or operations task and its exact repository and ref are verified.

Contributions are licensed under [AGPL-3.0-only](LICENSE).
