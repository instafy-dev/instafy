# Self-hosted runtime security

## Current product boundary

Sharing an Instafy project does not share a contributor's computer. The current runtime policy is deliberately asymmetric:

| Runtime or browser surface | Who may discover/use it | Can teammates view/control it? |
| --- | --- | --- |
| Managed `instafy-cloud` runtime | Project members according to their project role | Yes, through Shared Browser's separate view/control grants |
| Ordinary self-hosted runtime | Its controller-attested immutable owner while they can write the space, plus narrowly scoped controller service operations | No |
| Personal Browser runtime | The signed-in owner on the attested Electron device | No runtime access; explicit local tab sharing is a separate surface grant |
| Team runtime | Not implemented | No |

An Electron owner can explicitly [share a local tab](Local-Browser-Sharing.md) with
selected space members. That separate human-user channel relays tab pixels and
owner-approved input or Explore pages; it does not grant runtime discovery, agent
control, job submission, shell access or profile export. Project membership alone
never starts sharing or grants control.

Shared Browser is accepted only on the exact canonical managed `instafy-cloud` route. Studio does not offer a self-hosted or custom runtime as a Shared Browser candidate, and the controller independently rejects those runtimes for browser grants, dispatch, and profile persistence. Prefixes are not authority: a provider named `instafy-cloud-custom` cannot opt itself into this boundary or receive managed-provider credentials.

The durable Shared Browser profile API has the same boundary. Both its token scope and each GET/PUT request require the exact active managed-cloud runtime and current lease. Generic agent tokens, self-hosted runtimes, stopped runtimes, and controller-attested custom self-hosted runtimes cannot read or write the project browser profile.

### Owner-local read-only browser observation

An owner may explicitly add public-page observation to an ordinary private self-hosted Linux runtime running under a non-root account. This does not make the runtime a Shared Browser candidate and does not grant teammates browser view or control. The runtime registers the `localBrowser` capability only when `INSTAFY_LOCAL_BROWSER_ENABLED=1`, the process has empty inherited, permitted, effective, and ambient Linux capability masks, and the configured Playwright package, Chromium executable, and `browser-egress-proxy` executable all resolve to valid absolute paths. The host owner must provision each configured dependency and every ancestor as root-owned and not group- or world-writable. The Playwright package and Chromium directory are also walked recursively and must contain only root-owned, non-writable regular files/directories without symlinks. The MCP child re-enters the already-running runtime image through the literal `/proc/self/exe` magic link, avoiding a second lookup of a replaceable installation pathname. A root runtime, non-Linux host, invalid paths, or incomplete configuration fails closed and exposes no browser MCP tool.

Normal chat turns on that runtime then receive one bounded `instafy_local_browser.observe` tool. Each call uses a fresh credential-free headless context and can return element counts, bounded text, named computed CSS properties, and at most one PNG artifact below `artifacts/browser/`. It cannot click, type, evaluate arbitrary JavaScript, reuse a profile, or open authenticated/private sessions. Chromium's process sandbox is mandatory; there is no unsandboxed fallback. A failed observation answers with the first line of what failed, as a Shared Browser step does: never Playwright's stack or its call log, which names the page's markup, and a wait Playwright gave up on says that the page did not answer in time.

Chromium is forced through the repository's hardened loopback `browser-egress-proxy`, with the implicit loopback bypass removed, QUIC disabled, and non-proxied WebRTC UDP disabled. The proxy resolves and validates every destination, pins validated public addresses to each connection, allows only ports 80 and 443, and rejects local, private, link-local, metadata, mixed-DNS, and reserved targets across navigations, redirects, and subresources. The runtime launches and reaps the proxy with the observation. Screenshot writes use the same descriptor-relative, no-follow workspace containment described below.

The ownership, capability-mask, and re-exec checks prevent direct replacement by an ordinary unprivileged process and keep untrusted page traffic on the public-only route. They are defense in depth, not an adversarial boundary against the self-hosted owner or model process when that account can elevate through passwordless sudo, a Docker or other root-equivalent service socket, setuid/file-capability acquisition, or another host escape. Self-hosted execution continues to trust that local operator and is not a general host sandbox, as described under workspace path containment below.

## Immutable private ownership

Every ordinary human self-hosted or Personal Browser start receives a fresh controller-chosen runtime UUID in its signed runtime token. Personal Browser's separately attested Electron profile/device identity remains independent of that process ID. The controller never accepts a caller-selected unused runtime UUID; an explicit ID is valid only when rotating an existing runtime already owned by the same authenticated user. At registration the controller writes the protected `_instafySelfHostedAccess` capability with `mode=private` and the authenticated `ownerUserId`. Client/provider metadata cannot set, replace, or clear that owner, and token rotation preserves it. An unattested self-hosted runtime fails closed. A runtime whose provider was removed or is unknown is also quarantined rather than being reclassified as managed; only the exact trusted `instafy-cloud` route or a currently configured managed provider may fail open as managed.

The owner check is repeated at every authority boundary, rather than treated as a UI preference:

- runtime status, logs, selection, preference, ensure, stop, remove, and activity;
- job dispatch, leasing, reconnect, automation, and agent runtime preferences;
- local-workspace discovery and project event delivery;
- workspace leases and origin selection;
- tunnel mint, list, connection, and revocation;
- runtime, active-job, origin, Git, and browser-profile credentials.

The owner must also still be able to write the space. Registration, which renews the runtime token, and every runtime machine capability (origin registration and presence, applies and commit receipts, workspace lease reads, and Git token mints) check it again and refuse with 403 and code `runtime_owner_access_revoked` when they cannot. The controller's own service runtime identity is no member of any space and is not checked.

Private preferences and local-workspace registrations are keyed by user as well as project. A project teammate cannot make the owner's machine the project's shared preference. Controller-mediated operations revalidate scoped credentials against the current runtime owner and generation. Registration renews a runtime token for the same owner and generation, never with a scope the presented token lacked, so renewal alone never ends it before its machine lifetime (below) does; a new generation does. The controller writes one when the runtime is removed, when its owner stops it with their own sign-in (not the agent's own stop), and when a member or team change made through the controller leaves its owner unable to write the space. Every route that checks the generation (registration, the agent's lease, heartbeat and job routes, tunnels, and the machine capabilities above) then refuses the old generation's runtime, agent and job tokens with 401 `runtime token generation is no longer current`, which is what a person removed from a space and its team, or made a viewer, meets on their machines there. Telemetry writes do not check the generation and end when their token expires. Only a fresh mint by a person who can write the space names the new generation, so a removed or stopped runtime cannot register itself ready again.

An admission and a removal never miss each other. The runtime token mint, `/agent/login` and registration hold a per-person lock, shared, while they admit that person's machine, and a member or team change holds it exclusively while it rotates that person's runtimes, so a machine admitted while its owner loses access is either rotated by the change or refused by the owner check: the 403 above is what a first registration that raced a removal gets. The change also rotates a runtime of theirs that terminal cleanup marked `removed` while a token issued for it may still be alive, because registration takes such a runtime back. A runtime token minted for a new machine names no runtime the controller has stored until its first registration, so the mint records it as a pending mint of its person under that shared lock, and the first registration takes it. A change that leaves the person unable to write the space ends their pending mints too: that machine's first registration is then refused with the 401 above, even once they can write the space again, and the owner check refuses it with the 403 while they cannot. A runtime token minted before pending mints existed has none; it registers if its person can write the space again before it expires, at most an hour after the mint. The controller prunes pending mints five minutes after their token expires. Idle, heartbeat and terminal-cleanup sweeps never rotate: a machine that slept comes back on the tokens it holds, and a status of `removed` proves no removal, since terminal cleanup sets it too.

A membership edited in the database outside the controller rotates nothing. The owner check then refuses the next registration and machine capability call with the 403, but the agent's lease, heartbeat and job routes and tunnels check only the generation, so they keep working until the tokens already issued expire: an agent token after `AGENT_TOKEN_TTL_SECONDS`, a renewed runtime token after at most the longer of that and an hour. The runtime agent does not yet treat any of these refusals as final and keeps retrying registration until it is stopped; the one refusal it does treat as final is an ended machine lifetime, below. Direct origin credentials, and Git tokens already minted from a runtime token, remain stateless until their short expiry (normally about five minutes for origin credentials), and an already-upgraded origin WebSocket is not continuously introspected; it ends on expiry or explicit connection closure. That limitation is one reason Team runtime is not enabled.

`POST /agent/lease` always requires a signed runtime ID and validates the registered runtime
and its current generation, even with `STRICT_MODE=false`. A project-scoped `agent.lease`
token without that identity cannot claim jobs or obtain their prompts and conversation history;
supplying a runtime ID in the request body does not grant that identity. Private runtimes can
lease only work belonging to their attested owner, and never a platform AI job (an AI job whose
target has no credential): Instafy AI runs only on Instafy-hosted runtimes. Own-key jobs and
terminal commands still run there. The rule holds with `MANAGED_AI_ENABLED=false` too: a
credential-less job is then served by a proxy's own static key (see
[Model traffic goes through the Instafy proxy](#model-traffic-goes-through-the-instafy-proxy) for
when a proxy uses one), the private runtime calls the proxy the controller names unless its owner
overrides `PROXY_BASE_URL`, and that key belongs to
the deployment. Dispatch refuses such a job when only private runtimes could run it (pinned to
one, or a spread plan worker whose plan runtimes are all private), and one already queued that
way is failed by the controller's idle sweep (see [Credits and billing](Credits-Billing.md)).
A job pinned to the dispatch's chosen runtime while that runtime is not dispatch-ready (a
stopped desktop, say) is not refused: dispatch unpins it, as from any runtime that is not ready,
and a hosted runtime takes it. The private runtime never receives it.

A local-engine job is not a platform AI job, though it holds no credential: only a private
runtime its person owns in its space, with the attested `claudeCode` capability ready, leases it,
once, and it gets no proxy token, model-facing controller token or project secrets
([Local-engine turns](Local-Engine-Turns.md)).

Only the runtime that leased a job can complete it or post its messages and steps, for every job
and whatever `STRICT_MODE` says. `POST /agent/complete` and `POST /agent/message` require a signed
runtime ID: a scoped token that names no runtime, which any write member can mint by asking
`POST /projects/:id/runtime/token` for fewer scopes than a machine's, is refused with 401. They
take a job only while it is `leased` by the token's own runtime. Another runtime of the space,
including another computer of the same person, is answered as for a job it cannot find (404, or
403 with `STRICT_MODE` on), and so is every runtime for a job in the queue, whether no runtime
has leased it yet or a stop, an idle lease release or a rate-limit retry put it back. A refused
call writes nothing. A queued job is ended only by the runtime that leases it next, by a person's
cancel or stop, or by the controller itself (its sweeps and runtime stops). There is no
lease-expiry check: a runtime whose job lease lapsed still ends the job as long as nothing
requeued it, and so do a plan worker whose renewal was refused for want of a worker slot and a
draining runtime. The one result this loses is a turn that ends after the idle release requeued
its job under its still-running private runtime, which the release never stops: that late
completion gets 404 and the job runs again. The controller logs each completion that matched no
job its runtime holds, with the job's status.

`POST /agent/secrets` independently requires the same signed runtime identity and current
generation. The requested job must belong to that exact runtime, remain leased, and have a
future expiry before granted secrets can be decrypted. Missing runtime ownership or expiry
fails closed regardless of `STRICT_MODE`. It never delivers a project secret stored under
one of the proxy route's names (`runtime_contracts::proxy_route`). Those variables tell the
turn's engine, its worker lanes and its commands where to send the turn's model requests with
its proxy grant, so a secret of that name could send them to an address a project member
chose. Saving a value under one of those names is refused, and a runtime never sets one from
a job's secrets (see [Settings UI](Settings-UI.md), Secrets).

Conversation-authorized viewers still receive basic run lifecycle status when work runs on
another participant's private runtime. If a lifecycle event contains private runtime details,
the controller sends only the run identity, current database status, numeric progress and
update timestamp after rechecking project and conversation access. Runtime identifiers,
lease metrics, messages, metadata, previews and routing fields remain omitted; the runtime
owner receives the original event. This keeps shared chats up to date without granting
runtime discovery or control.

Raw runtime routing state is controller-only. Authenticated project members have
no direct database privileges on runtimes, runtime leases/events, tunnel grants,
origins, presence, origin instances, or workspace commit receipts; otherwise a
direct Supabase query could bypass the controller's owner-aware filtering.

Controller service-role operations are the only intentional exception. They remain bounded by the configured service runtime identity and are not exposed as a teammate grant.

Origin registration is part of the same runtime generation. Mutation tokens must carry a runtime ID; managed runtimes may register only their exact preallocated active runtime/lease origin instance, while a private self-hosted runtime must use its controller-issued signed runtime UUID as the origin ID. An unbound private preallocation is bound to that UUID rather than trusting a caller-selected origin. The stable hosted-gateway namespace is therefore unreachable to private registrations, an origin ID can never move between projects, and workspace-origin creation plus instance binding happens in one locked transaction. Presence and commit receipts recheck that same runtime/origin binding.

Private local startup does not call the hosted `/runtime/request` allocator or create an allocator lease. The CLI first mints the owner-bound unleased runtime token, the runtime registers that exact signed identity, and only then the runtime-agent requests `/tunnels/request` with its runtime ID and no lease ID. The controller revalidates the private owner, signed generation, live runtime status, and exact target before issuing the tunnel. Provider-managed agents retain their explicit lease-bound tunnel flow; omitting that lease fails closed for them.

### Machine lifetime

A person's private self-hosted machine keeps renewing its credentials only for a limited time after its runtime token was minted: its machine lifetime, seven days unless `SELF_HOSTED_MACHINE_LIFETIME_SECONDS` sets another (see the controller README). The mint signs the machine's expiry into the runtime token, and each renewal carries the same expiry on and never runs past it, so a stolen machine token works at most that long, whoever renews it. Registration renews only while a renewed token (max(`AGENT_TOKEN_TTL_SECONDS`, an hour)) would end by then. After that it answers 401 with code `runtime_machine_lifetime_ended`, checked after the deleted-space, generation and owner refusals, so a machine told to mint again is one none of those refuses. Only a new mint by a person who can write the space starts a new lifetime. A runtime token minted before lifetimes existed starts its lifetime at its next renewal. A lease-bound hosted runtime and the controller's service identity have none.

The runtime agent treats that refusal as final: it takes no new job, stops at its next idle point and exits with status 4. Desktop then starts it again with the session the Studio window shows, when that session is the person the runtime was started for. Otherwise it tells them to start it from the space. It never does this for a Personal Browser runtime, whose control ended with its process, or for a runtime whose lifetime ended again within ten minutes of such a start. A foreground `instafy runtime start` mints a new token from the person's sign-in for the same runtime and starts the agent again, at most once in ten minutes. With a runtime token it was given, or under `--detach`, the runtime stays stopped. Tokens already issued work until they expire, so an agent token minted shortly before the end can outlive it by up to `AGENT_TOKEN_TTL_SECONDS`.

A person's runtime token mint never outlives the session that asked for it either: the token ends when the session does, a `ttlSeconds` past the session's end is refused with 403, and a session with under a minute left gets 401 to refresh first. `instafy runtime start` refreshes a saved login that ends within 15 minutes before it mints, so a slow start such as an image pull does not outlast the first token. The first registration renews the token from there.

## Model traffic goes through the Instafy proxy

Every model call of a leased job goes through the configured Instafy proxy, on a grant the
controller signs for that job and lease with `PROXY_SIGNING_SECRET` (or a secret derived from
`CONTROLLER_INTERNAL_TOKEN`). The grant names the job, its lease attempt, its run and its
credential. The proxy checks the signature and serves the call on that credential, which it
leases from the controller, or on the managed lane. Runtimes and browsers never hold a provider
credential, and nothing falls back to one when a grant is missing:

- **The controller** refuses to start without `PROXY_SIGNING_SECRET` or
  `CONTROLLER_INTERNAL_TOKEN`, in `DEV_MODE` too. It could sign no grant, so every model job it
  leased would fail.
- **A runtime** refuses a job that can reach a model and came without a grant of its own. The job
  fails before heartbeats, secrets or its folder with "This turn didn't start: it came without the
  controller's grant for the Instafy proxy, which every model call needs." The session envelope a
  runtime gets when it registers is not a job's grant. No model lane falls back to a key in the
  runtime's environment (`OPENAI_API_KEY`, `CODEX_API_KEY`) or to a login in its Codex home: the
  grant replaces both for every model request. Two kinds of job run without a grant: a terminal
  command, which runs no model, and a local-engine turn, which reaches its person's own Claude
  Code and never the proxy ([Local-engine turns](Local-Engine-Turns.md)).
- **The proxy's own static credentials** (`OPENAI_API_KEY` or `auth.json`) serve managed runs on a
  proxy with controller integration only as `PROXY_STATIC_PLATFORM_CREDENTIALS` allows. In this
  release, unset keeps today's behaviour: the proxy serves them and logs a warning at startup and
  for every managed run they serve. `1` keeps them without the warnings. `0` never reads them, and
  managed runs lease the controller's managed credential (`MANAGED_AI_OPENAI_API_KEY` on the
  controller). **The next release treats unset as `0`.** A proxy without controller integration
  has no managed runs, and its static credentials serve every request whatever the setting says.

Upgrading:

1. Set `PROXY_SIGNING_SECRET` or `CONTROLLER_INTERNAL_TOKEN` on the controller before you upgrade
   it or its runtimes. Without either, the controller refuses to start, and a runtime fails every
   model job leased to it, since none comes with a grant. `scripts/run-e2e-dev.mjs` already sets
   both.
2. Before the next release, decide for every proxy with controller integration that serves
   managed runs from its own key: set `PROXY_STATIC_PLATFORM_CREDENTIALS=1` to keep that key, or
   set `MANAGED_AI_OPENAI_API_KEY` on the controller and `PROXY_STATIC_PLATFORM_CREDENTIALS=0` to
   lease it now. The proxy's `/healthz` reports the result as `platformLane.servedBy`: `static`
   or `controller_lease`.

## Workspace path containment

The origin HTTP/apply facade resolves workspace paths relative to an already-open root capability: descriptor-relative `openat` operations on Unix and capability directory handles on Windows. File reads, writes, archive apply, Git layout validation, rename, and delete open every untrusted component with no-follow semantics. Symlinks in the workspace cannot redirect those facade operations outside the canonical root, including through protected `.git` and `.instafy` paths. ZIP extraction is bounded and validates every entry before mutation.

Spawned Git remains a narrower exception. Unix pins the repository root as the child's working directory, while Windows process spawning exposes only a pathname-based `current_dir`; however, Git still resolves descendant metadata such as `.instafy/.git` after the capability-based layout check. A hostile same-user local process could race that descendant between validation and Git's own open. This is a documented local-process limit, not a teammate security boundary, and the product does not claim that Git subprocess execution is fully race-free. Spawned Git and other child processes do not inherit the runtime's launch credentials, which the agent clears from its environment once its configuration has them (see [Container hardening](Runtime-Machines.md#container-hardening)).

This closes the workspace-only symlink escape, but it is not a general host sandbox. Hard links, bind mounts created by a privileged local owner, and the ordinary runtime agent's unrestricted local shell/filesystem capability are separate boundaries. Because the current self-hosted agent can bypass the origin HTTP facade, the product must not expose a teammate-facing “workspace-only” or Team runtime mode yet.

The canonical repository does not trust a runtime's commits either. The git shard checks every object a runtime pushes: a tree with a `..` or `.git` entry, or an unsafe `.gitmodules`, refuses the push before any ref moves. The shard's update hook then applies the path and size policy to the net change between the old and new tip, merges included, and no push can change a ref in the reserved salvage namespace, whatever the letter case of the name. A runtime machine token can mint only `git.read`; a runtime gets `git.write` only through an active workspace lease. See [Repository policy](Git-Service.md#repository-policy).

History carries no account identity. With `INSTAFY_AUTHOR_PSEUDONYM_KEYS` set on the controller, a person's workspace-write token carries a per-space pseudonym under `@users.noreply.instafy.dev` and their display name, and the origin authors that person's saves with them; jobs, and every save while the keyring is unset, are authored by the origin's own git identity. The token subject, user ids and email addresses never reach a commit (see the controller's [`INSTAFY_AUTHOR_PSEUDONYM_KEYS`](../packages/runtime-controller/README.md)).

The hosted workspace gateway keeps no working copy. A save is a commit on canonical `main` before the gateway answers, so saves never depend on the gateway's node, and its mirror cache is disposable.

## Why Team runtime is not a flag

A future Team runtime is a new trust product, not a renamed private runtime. It must use an explicit dedicated-server/workstation enrollment flow and independent grants for:

- browser viewing;
- browser control;
- workspace read;
- workspace write;
- shell/process execution;
- outbound network access;
- camera, microphone, USB, GPU, and other hardware.

Before such a mode can ship, the local owner must approve each session or policy on the host itself. The host must show who is viewing or controlling, enforce short expirations, provide an immediate local kill switch, write tamper-resistant audit events, and add stateful token/JTI revocation plus active connection closure. The execution worker also needs an OS sandbox that cannot bypass the workspace facade. Until all of those controls exist, there is no Team runtime capability or compatibility fallback.

## Rollout and reconciliation

This boundary is fail-closed for existing unattested self-hosted rows. Before the first production cutover:

1. Inventory non-managed runtimes and stop/remove legacy or ambiguous rows.
2. Re-register each intended private runtime from its owner's authenticated device so it receives a fresh runtime UUID, owner attestation, and generation.
3. Release old runtime/workspace leases, revoke tunnels and origin grants, and requeue or fail jobs pinned to a legacy or cross-owner runtime.
4. Deploy controller, frontend, origin server, and runtime-agent changes at one pinned SHA; do not deploy only the multiplayer UI first.
5. Run owner/teammate negative canaries before enabling collaborative Shared Browser in production.

No schema reset is required. The attestation lives in the existing protected runtime capabilities, while the controller's live authorization paths quarantine anything without a valid owner. Additive migration `20260000000057` removes project-member reads from raw runtime/origin operational tables so those checks cannot be bypassed through Supabase.

Machine lifetimes need only the additive `runtime_pending_machine_mints` table (`20261118155620`). A machine running when its controller is upgraded holds a runtime token without a machine expiry, so its lifetime starts at its first renewal by an upgraded node. While a rolling deploy runs both versions, an older node renews without the expiry and the next upgraded node starts the lifetime again, so every lifetime counts from the end of the rollout at the latest. Only an upgraded node records pending mints, so a machine minted by an older node during the rollout registers as before.

Published runtime images are scanned before they are pushed, separately for each architecture: the production release scans its amd64 images, and the arm64 lane scans its arm64 images and re-scans the reused amd64 images before it creates a multi-arch tag. See [GHCR publication](../packages/runtime-agent/README.md#ghcr-publication) for which tags exist for a commit.

## Focused validation

```bash
cargo test --manifest-path packages/runtime-controller/Cargo.toml --bin runtime-controller self_hosted
cargo test --manifest-path packages/runtime-controller/Cargo.toml --bin runtime-controller \
  private_self_hosted_origin_tokens_are_owner_bound_and_revoked_on_rotation
cargo test --manifest-path packages/runtime-controller/Cargo.toml --bin runtime-controller runtime::revocation
cargo test --manifest-path packages/origin-http-server/Cargo.toml
cargo test --manifest-path packages/runtime-controller/Cargo.toml --test startup \
  startup_refuses_a_controller_that_cannot_sign_proxy_grants
cargo test --manifest-path packages/runtime-agent/Cargo.toml --lib -- \
  a_model_job_without_its_proxy_grant_fails_before_it_starts job_proxy_auth
cargo test --manifest-path packages/openai-proxy-server/Cargo.toml \
  --test proxy_static_platform_credentials
pnpm --filter @instafy/frontend test:e2e:desktop:shared-browser-collaboration
```

The last command launches one normal Chromium Studio client and one real Electron Studio client as different users against the same managed Shared Browser runtime. It verifies shared runtime/origin/page identity, named cursors in both directions, driver-only input, request/grant handoff, and the ten-second reconnect grace while both pixel surfaces remain painted.
