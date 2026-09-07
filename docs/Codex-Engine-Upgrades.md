# Embedded Codex engine

The runtime embeds the Instafy Codex fork. Its gitlink must name a published,
fetchable fork commit before an upgrade can be reproduced. This upgrade starts
from upstream `e1eb98461cd42730e7b1a890c3100303d7091bc2` and adapts the three
Instafy integration patches for bounded shutdown, required execution before a
final response, and local MCP transport lifecycle.

## Astra compatibility

The bundled catalog now resolves `gpt-6-astra` under API-key authentication
without relying on a remote catalog refresh. At this upstream target Astra
selects multi-agent v2, code-mode-only tools, unified exec, freeform apply_patch,
and parallel tool calls. Its default reasoning is `low`; `max` is supported.
The catalog has a 272,000 context window and an 872,000 maximum context window;
the maximum is not an unconditional effective session limit.

Astra also selects Responses Lite. Its tool definitions travel in
`input[].additional_tools`; upstream deliberately sets the wire-level
`parallel_tool_calls` field to `false` in this mode. That is distinct from the
catalog's parallel capability. The proxy must preserve the Lite input, reasoning
context and tool controls without injecting a legacy default tool list.

Preserve explicit `CODEX_MODEL=gpt-6-astra` and
`CODEX_RUNTIME_REASONING_EFFORT=max` where configured. A controller-supplied
agent override remains authoritative. Configured effort, the outgoing runtime
request, proxy-forwarded effort, and provider-effective effort are distinct
observations. The submodule change alone cannot fix an older proxy's effort
mapping. Parent and reviewer requests must both continue through the configured
Instafy proxy.

Code-mode helpers that merely print text do not satisfy a turn's required
execution. Actual nested execution is tracked before permitting a final reply.
MCP replacement preserves reused clients, closes removed clients, and retains
all generations for bounded terminal cleanup. Runtime job completion shuts down
every owned thread, including resident reviewers; failed or timed-out cleanup
is not successful completion.

## Native reviewer instructions

The default exposed tools are `collaboration.spawn_agent`,
`collaboration.wait_agent`, `collaboration.list_agents`, and
`collaboration.interrupt_agent`. Use the actual recipient exposed by the
runtime: providers without namespace support expose unqualified names. Do not
invent a `multi_agent_v2` namespace. These tools are called directly, outside
`functions.exec` and its `tools` object, even when other tools use code mode.

Start a unique fresh reviewer with this argument shape:

```json
{
  "task_name": "review_change_head_attempt1",
  "fork_turns": "none",
  "message": "Self-contained review request identifying the repository, full commit, exact diff and permitted test evidence."
}
```

`task_name` and `message` are required. Omitted `fork_turns` copies full
history; the old `fork_context` argument is rejected. Retain the returned
canonical `task_name`, such as `/root/review_change_head_attempt1`, rather than
expecting an `agent_id`. Omit model/effort overrides to inherit the active
configuration, but first reconcile `agents.default_subagent_model`,
`agents.default_subagent_reasoning_effort`, and any configured default role:
those settings may override the parent's values.

Wait using `collaboration.wait_agent({"timeout_ms":60000})`. There is no
`targets` argument. A mailbox wakeup or timeout is not a review result. Require
the actual final answer from the retained reviewer, naming the unchanged full
head and an explicit APPROVE, CHANGES, or BLOCKED decision with reasons. A
changed head invalidates the decision and test/CI evidence.

Inspect the reviewer and descendants using
`collaboration.list_agents({"path_prefix":"/root/review_change_head_attempt1"})`.
There is no v2 `close_agent`. For abandoned or timed-out work, call
`collaboration.interrupt_agent({"target":"/root/review_change_head_attempt1"})`
and verify that the agent is no longer running; its returned previous status
does not establish that. Interruption leaves the helper resident. Full closure
belongs to the runtime's bounded all-thread shutdown. Use a new task for a fresh
re-review.

Native review does not satisfy an independent-account GitHub approval. Keep
exact-head decisions, required CI, code-owner review and protected merge policy
in force. Absent, incomplete, wrong-head or blocked review evidence cannot
authorize a merge.

## Build and rollout

Ship `runtime-agent` and the matching `codex-code-mode-host` sibling executable
together. The host runs upstream's stdio protocol in its own process. Desktop
manifest version 3 verifies both executable hashes, including after signing;
both Docker runtime variants and the binary export include the host. A
prebuilt Desktop input requires the host beside the runtime binary.

The upstream V8 dependency enables pointer compression and the V8 sandbox.
Ordinary upstream release archives do not contain this combination. Use the
checksum-verified Codex-built V8 archive and bindings from the matching version,
or build V8 from source; never disable sandbox features to make the build pass.
Use `node scripts/runtime-cargo.mjs <cargo arguments>` for runtime checks, tests
and builds; for example,
`node scripts/runtime-cargo.mjs build --locked --manifest-path packages/runtime-agent/Cargo.toml --bins`.
The helper verifies the matching archive and bindings before running Cargo.
Select cross-compilation explicitly with `--target` or `CARGO_BUILD_TARGET`;
implicit `build.target` settings and ambiguous config includes are rejected
when the helper cannot establish the matching V8 architecture. Desktop staging
pins the native target and output directory so an inherited Cargo setting cannot
cause an older binary pair to be packaged.

Run the helper and staging regressions with
`INSTAFY_TEST_RUNTIME_CARGO_REAL=1 node --test scripts/runtime-cargo.test.mjs packages/desktop-app/test/stage-runtime-agent.test.mjs`.
That flag includes a dependency-free offline Cargo fixture for target selection.
Both upstream
and the runtime image currently pin Rust 1.95.0.

Stage one coordinated runtime, proxy and reviewer-instruction update. Preserve
active jobs and saved state, drain admission using the deployment owner's
existing procedure, then adopt the tested binaries and prompt bytes together.
Verify parent and fresh-child Astra/max requests through the proxy, real code
execution, final reviewer delivery, interruption, and bounded cleanup before
resuming admission. This source upgrade does not deploy or advance release pins.

The trusted public-boundary policy deliberately rejects a new Codex gitlink
against the old protected-base allowlist. The candidate policy's exact new pin
is for security-maintainer review; updating it in the PR does not bypass the
trusted-base check. Follow the existing protected review procedure.

## Source of the tool contract

All compatibility statements above refer to the exact upstream target:
[catalog](https://github.com/openai/codex/blob/e1eb98461cd42730e7b1a890c3100303d7091bc2/codex-rs/models-manager/models.json),
[v2 schemas](https://github.com/openai/codex/blob/e1eb98461cd42730e7b1a890c3100303d7091bc2/codex-rs/core/src/tools/handlers/multi_agents_spec.rs),
[v2 handlers](https://github.com/openai/codex/tree/e1eb98461cd42730e7b1a890c3100303d7091bc2/codex-rs/core/src/tools/handlers/multi_agents_v2),
[thread lifecycle](https://github.com/openai/codex/blob/e1eb98461cd42730e7b1a890c3100303d7091bc2/codex-rs/core/src/thread_manager.rs),
and [V8 artifact setup](https://github.com/openai/codex/blob/e1eb98461cd42730e7b1a890c3100303d7091bc2/scripts/codex_package/v8.py).
