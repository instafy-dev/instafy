# Runtime provider isolation

Instafy can launch a fresh runtime in a local container, on a pool of container hosts, through
an external provider service, or on a dedicated cloud machine. These are deployment choices,
not different application APIs.

## Public boundary

The public runtime packages contain:

- the controller-to-provider request contract;
- the provider service and allocator trait;
- Docker, Docker-pool, external-HTTP, no-op, and Hetzner allocator implementations;
- generation-aware lifecycle checks and runtime metadata filtering; and
- local Compose examples suitable for development and self-hosting.

Cloud drivers are public so a self-hoster can inspect and operate the full runtime path.
Instafy's hosted credentials, network identifiers, capacity targets, placement policy,
production topology, release procedures, and monitoring runbooks are not part of this
repository.

## Isolation model

A runtime agent registers and leases work with a controller-issued identity scoped to one
project, runtime, and lease generation. Never reassign an already registered agent to a
different project. Pool warm host capacity and container images instead, then start a fresh
runtime agent for each allocation.

Every provider implementation must preserve these invariants:

- one runtime identity serves one project and one current lease generation;
- release of an old generation cannot destroy its successor;
- workspace paths, environment, processes, and exposed ports are isolated per runtime;
- provider credentials remain in server-side provider configuration and never enter runtime
  metadata or a browser bundle;
- runtime metadata is treated as untrusted input and reduced to the explicit allowlist before
  it reaches Docker, Compose, cloud-init, or a shell; and
- lifecycle endpoints require authenticated controller-to-provider traffic (see
  [Provider service authentication](#provider-service-authentication)).

Containers on one host share a kernel and Docker daemon. Operators needing a stronger
tenant boundary should select a dedicated-machine allocator or add a sandbox appropriate to
their threat model.

## Provider service authentication

The provider service (`runtime-provider-service`) launches, stops, inspects, lists and locates
runtimes for whoever calls it. A launch request for a custom provider can choose the runtime
image and the space whose checkout it mounts, so every route, `/healthz` included, requires a
bearer token:

- Set `PROVIDER_AUTH_TOKEN` to a long random secret (for example `openssl rand -hex 32`) and
  register the same value as the provider's `authToken`. A provider with `CONTROLLER_URL` set
  registers itself, with that token, each time it starts; otherwise register it with
  `POST /providers`. Without `PROVIDER_AUTH_TOKEN` the service refuses to start.
- `CONTROLLER_INTERNAL_TOKEN` and `CONTROLLER_SERVICE_ROLE_KEY` are controller-wide credentials.
  The provider sends them, to register, to ask the controller about spaces and to the runtime
  proxies it starts, but they never stand in for `PROVIDER_AUTH_TOKEN`. The provider never
  registers them as its own token: the controller would store them with the provider and send
  them to its endpoint on every call, while it sends its own credentials to no provider but its
  Instafy Cloud route. The service still accepts them from its caller, for that route.
- A `docker_pool` provider sends `DOCKER_POOL_AUTH_TOKEN` to its hosts. Give each host's
  provider service the same value as its `PROVIDER_AUTH_TOKEN`.
- For local development only, `PROVIDER_ALLOW_UNAUTHENTICATED=1` starts the service without a
  token. It then checks none and listens on `127.0.0.1:9090`, or on the loopback address
  `BIND_ADDR` names, and refuses any other address. With a token set, the flag is ignored and
  `BIND_ADDR` defaults to `0.0.0.0:9090`. `pnpm stack:up` does not need the flag: it gives its
  provider `PROVIDER_AUTH_TOKEN=dev-provider-token`.

### Upgrading a provider that ran without a token

Earlier releases started without `PROVIDER_AUTH_TOKEN`. With no token at all, the service
checked none. With only `CONTROLLER_INTERNAL_TOKEN` or `CONTROLLER_SERVICE_ROLE_KEY`, it checked
that one and registered it as its own token. Such a provider now refuses to start until it has
a token of its own:

1. Generate a token and set it as the service's `PROVIDER_AUTH_TOKEN`.
2. If the provider does not register itself, register the same value as its `authToken` with
   `POST /providers`.
3. Give any health check that calls `/healthz` the token as well, or check the port instead.
4. Start the new release.

The controller refuses to change the credential of a provider whose runtimes are running
(`409`, "provider route is in use"), with one exception: a provider stored without a
credential may get its first one at any time. A provider that ran without a token therefore
stays reachable across the upgrade. One that registered a controller credential keeps it until
its runtimes stop: the controller keeps sending it, the provider still accepts it, and the
provider's own registration retries until it succeeds.

## Host pools

`docker_pool` deterministically forwards lifecycle calls across a fixed ordered host list.
It is useful for small, stable installations, but changing that list changes the mapping and
it is not capacity-aware. A larger installation should persist `runtime_id -> host_id`
placement in a scheduler so ensure, release, health, and recovery calls always reach the same
host.

Do not treat a load balancer alone as durable placement unless its routing key and membership
semantics provide the same guarantee.

## Dedicated machines

The Hetzner allocator creates one machine for a runtime and labels it with the lease
generation. It is a direct allocator, not a warm reassignment pool. A reusable prewarmed
machine needs a separate authenticated assignment protocol; replacing its project token or
cloud-init data ad hoc would break the isolation model.

## Extending providers

Prefer the existing external-HTTP provider boundary for a new scheduler or cloud backend.
Add a concrete allocator to `runtime-provider-core` only when it is generally useful to
self-hosters and can obey the same request, metadata, and generation rules. Product plans,
billing policy, and hosted placement decisions belong above this infrastructure boundary.
