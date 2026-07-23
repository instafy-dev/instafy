# `@instafy/sdk`

Shared, provider-neutral types and helpers used to compose Instafy applications.

The package exposes assistant, capability, controller-client, hardware-provider,
project-binding, and trusted build-time feature-module APIs. Feature modules are
statically imported by an application composition root; this package does not load
remote code or discover plugins at runtime.
