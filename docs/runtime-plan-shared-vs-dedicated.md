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
- lifecycle endpoints require authenticated controller-to-provider traffic.

Containers on one host share a kernel and Docker daemon. Operators needing a stronger
tenant boundary should select a dedicated-machine allocator or add a sandbox appropriate to
their threat model.

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
