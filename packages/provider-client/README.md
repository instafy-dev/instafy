# @instafy/provider-client

Generic provider-host client helpers shared by Instafy surfaces.

This package intentionally stays narrow:

- provider host HTTP request helpers
- typed provider envelopes and summaries
- a small `createProviderHostClient` factory
- optional, sanitized project initialization context for a single resource read
  or tool call

It does not include:

- project policy logic
- assistant bindings
- frontend UI
- provider implementation code

That split keeps the package reusable for the frontend, diagnostics flows, and future CLI tooling without coupling external providers to Instafy product internals.

Providers that need project access receive the context as the second argument
to their `readResource` registration or the third argument to `callTool`. The
client and host restrict it to `projectId`, `rootUri`,
`grantedCapabilities`, and `grantedPrefix`; provider-specific binding metadata
is not forwarded, and the context is not mixed into resource identifiers or
tool arguments.

Resource reads use a JSON `POST` body. Project paths and binding metadata are
never placed in the request URL.
