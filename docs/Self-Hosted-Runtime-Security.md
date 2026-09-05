# Self-hosted runtime security

## Current product boundary

Sharing an Instafy project does not share a contributor's computer. The current runtime policy is deliberately asymmetric:

| Runtime or browser surface | Who may discover/use it | Can teammates view/control it? |
| --- | --- | --- |
| Managed `instafy-cloud` runtime | Project members according to their project role | Yes, through Shared Browser's separate view/control grants |
| Ordinary self-hosted runtime | Its controller-attested immutable owner, plus narrowly scoped controller service operations | No |
| Personal Browser runtime | The signed-in owner on the attested Electron device | No, permanently |
| Team runtime | Not implemented | No |

Shared Browser is accepted only on the exact canonical managed `instafy-cloud` route. Studio does not offer a self-hosted or custom runtime as a Shared Browser candidate, and the controller independently rejects those runtimes for browser grants, dispatch, and profile persistence. Prefixes are not authority: a provider named `instafy-cloud-custom` cannot opt itself into this boundary or receive managed-provider credentials.

The durable Shared Browser profile API has the same boundary. Both its token scope and each GET/PUT request require the exact active managed-cloud runtime and current lease. Generic agent tokens, self-hosted runtimes, stopped runtimes, and controller-attested custom self-hosted runtimes cannot read or write the project browser profile.

### Owner-local read-only browser observation

An owner may explicitly add public-page observation to an ordinary private self-hosted Linux runtime running under a non-root account. This does not make the runtime a Shared Browser candidate and does not grant teammates browser view or control. The runtime registers the `localBrowser` capability only when `INSTAFY_LOCAL_BROWSER_ENABLED=1`, the process has empty inherited, permitted, effective, and ambient Linux capability masks, and the configured Playwright package, Chromium executable, and `browser-egress-proxy` executable all resolve to valid absolute paths. The host owner must provision each configured dependency and every ancestor as root-owned and not group- or world-writable. The Playwright package and Chromium directory are also walked recursively and must contain only root-owned, non-writable regular files/directories without symlinks. The MCP child re-enters the already-running runtime image through the literal `/proc/self/exe` magic link, avoiding a second lookup of a replaceable installation pathname. A root runtime, non-Linux host, invalid paths, or incomplete configuration fails closed and exposes no browser MCP tool.

Normal chat turns on that runtime then receive one bounded `instafy_local_browser.observe` tool. Each call uses a fresh credential-free headless context and can return element counts, bounded text, named computed CSS properties, and at most one PNG artifact below `artifacts/browser/`. It cannot click, type, evaluate arbitrary JavaScript, reuse a profile, or open authenticated/private sessions. Chromium's process sandbox is mandatory; there is no unsandboxed fallback.

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

Private preferences and local-workspace registrations are keyed by user as well as project. A project teammate cannot make the owner's machine the project's shared preference. Controller-mediated operations revalidate scoped credentials against the current runtime owner and generation, so a stopped or rotated runtime fails those requests immediately. Direct origin credentials remain stateless until their short expiry (normally about five minutes), and an already-upgraded origin WebSocket is not continuously introspected; it ends on expiry or explicit connection closure. That limitation is one reason Team runtime is not enabled.

`POST /agent/lease` always requires a signed runtime ID and validates the registered runtime
and its current generation, even with `STRICT_MODE=false`. A project-scoped `agent.lease`
token without that identity cannot claim jobs or obtain their prompts and conversation history;
supplying a runtime ID in the request body does not grant that identity. Private runtimes can
lease only work belonging to their attested owner.

`POST /agent/secrets` independently requires the same signed runtime identity and current
generation. The requested job must belong to that exact runtime, remain leased, and have a
future expiry before granted secrets can be decrypted. Missing runtime ownership or expiry
fails closed regardless of `STRICT_MODE`.

Raw runtime routing state is controller-only. Authenticated project members have
no direct database privileges on runtimes, runtime leases/events, tunnel grants,
origins, presence, origin instances, or workspace commit receipts; otherwise a
direct Supabase query could bypass the controller's owner-aware filtering.

Controller service-role operations are the only intentional exception. They remain bounded by the configured service runtime identity and are not exposed as a teammate grant.

Origin registration is part of the same runtime generation. Mutation tokens must carry a runtime ID; managed runtimes may register only their exact preallocated active runtime/lease origin instance, while a private self-hosted runtime must use its controller-issued signed runtime UUID as the origin ID. An unbound private preallocation is bound to that UUID rather than trusting a caller-selected origin. The stable hosted-gateway namespace is therefore unreachable to private registrations, an origin ID can never move between projects, and workspace-origin creation plus instance binding happens in one locked transaction. Presence and commit receipts recheck that same runtime/origin binding.

Private local startup does not call the hosted `/runtime/request` allocator or create an allocator lease. The CLI first mints the owner-bound unleased runtime token, the runtime registers that exact signed identity, and only then the runtime-agent requests `/tunnels/request` with its runtime ID and no lease ID. The controller revalidates the private owner, signed generation, live runtime status, and exact target before issuing the tunnel. Provider-managed agents retain their explicit lease-bound tunnel flow; omitting that lease fails closed for them.

## Workspace path containment

The origin HTTP/apply facade resolves workspace paths relative to an already-open root capability: descriptor-relative `openat` operations on Unix and capability directory handles on Windows. File reads, writes, archive apply, Git layout validation, rename, and delete open every untrusted component with no-follow semantics. Symlinks in the workspace cannot redirect those facade operations outside the canonical root, including through protected `.git` and `.instafy` paths. ZIP extraction is bounded and validates every entry before mutation.

Spawned Git remains a narrower exception. Unix pins the repository root as the child's working directory, while Windows process spawning exposes only a pathname-based `current_dir`; however, Git still resolves descendant metadata such as `.instafy/.git` after the capability-based layout check. A hostile same-user local process could race that descendant between validation and Git's own open. This is a documented local-process limit, not a teammate security boundary, and the product does not claim that Git subprocess execution is fully race-free.

This closes the workspace-only symlink escape, but it is not a general host sandbox. Hard links, bind mounts created by a privileged local owner, and the ordinary runtime agent's unrestricted local shell/filesystem capability are separate boundaries. Because the current self-hosted agent can bypass the origin HTTP facade, the product must not expose a teammate-facing “workspace-only” or Team runtime mode yet.

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

## Focused validation

```bash
cargo test --manifest-path packages/runtime-controller/Cargo.toml --bin runtime-controller self_hosted
cargo test --manifest-path packages/runtime-controller/Cargo.toml --bin runtime-controller \
  private_self_hosted_origin_tokens_are_owner_bound_and_revoked_on_rotation
cargo test --manifest-path packages/origin-http-server/Cargo.toml
pnpm --filter @instafy/frontend test:e2e:desktop:shared-browser-collaboration
```

The last command launches one normal Chromium Studio client and one real Electron Studio client as different users against the same managed Shared Browser runtime. It verifies shared runtime/origin/page identity, named cursors in both directions, driver-only input, request/grant handoff, and the ten-second reconnect grace while both pixel surfaces remain painted.
