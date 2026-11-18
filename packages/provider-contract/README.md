# @instafy/provider-contract

Small neutral contract package for local or external providers.

It intentionally contains only:

- provider discovery metadata
- built-in first-party provider family metadata
- shared registries for built-in provider families and extension-capable families
- tool/resource envelope types
- neutral provider-manifest declarations for bounded host surfaces
- shared runtime, execution, event, and artifact envelope types
- tiny provider summary normalization and lookup helpers

It must stay independent from Instafy frontend, project policy, assistant definitions, and arbitrary provider-owned UI code.

This package is intended to be published independently so external provider
repositories can validate against the host-facing contract without depending on
a local sibling Instafy checkout.

It is not a callback framework. The intended generalization is:

- provider runtime context
- execution context
- provider manifest and host-surface declarations
- typed provider events
- artifact references

That lets external providers and host apps share one neutral event/artifact loop
without coupling Instafy UI or provider-specific lifecycle code into the package.

Host-surface declarations are intentionally bounded. They are meant to let a host
like Instafy know that a provider can contribute something like an extension tile,
status card, or settings card. They are not a license for providers to ship
arbitrary full-screen frontend takeovers through this package.
