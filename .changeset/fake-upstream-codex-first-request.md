---
---

The development tool `scripts/fake-rate-limit-upstream.mjs` now counts Codex's first request of a turn as one that starts a conversation under `--scope new`. That request carries an `additional_tools` item next to its messages, so before it was always forwarded and a `--scope new` rule never refused anything for a Codex client. A request counts as new while it holds nothing the model made yet: no assistant message, reasoning, tool call or tool result. The proxy README also says how to send runtimes started by the runtime provider through the fake upstream. No package changes.
