# `@instafy/sdk`

Shared, provider-neutral types and helpers used to compose Instafy applications.

The package exposes assistant, capability, controller-client, hardware-provider,
project-binding, and trusted build-time feature-module APIs. Feature modules are
statically imported by an application composition root; this package does not load
remote code or discover plugins at runtime.

`@instafy/sdk/conversation-search` exposes the controller message-search and
exact-message context types plus URL builders. Applications supply their existing
authenticated, cancellable transport. Search results contain bounded plain-text
snippets with half-open UTF-16 highlight ranges. Context pages preserve canonical
message payloads and IDs in newest-first order; page in either direction using
the returned boundary ID and deduplicate the repeated anchor. The helpers neither
cache message contents nor request runtime access.
