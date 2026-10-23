---
---

A team plan written under the strict plan output schema no longer has every lane stopped at once with "Write-scope coordination required" (invalid_write_scope). That schema makes each optional field required and nullable, so the model writes null for each one it leaves out, such as a lane's `readOnlyPaths`, `ownedPathGlobs` or `rationale`; the runtime passed those nulls on, and the controller rightly refuses a null where it expects a list of paths. The runtime now reads a null field in a plan as the field being left out, at every depth (write scopes, `runtimeRouting`, `presentation`, `handoffPaths`), before it sends the plan. A null entry inside a list is kept, and the controller still refuses it. The controller is unchanged. No package changes.
