# Explicit project preferences

This experimental runtime feature delivers a small set of shared project defaults separately
from conversation history and the broader workspace-memory snapshot. It uses the project
workspace's root `INSTAFY.md`; it does not create a private personal profile.

## Declare or update defaults

Opt in by adding the exact heading `## Project preferences` to `INSTAFY.md`:

```markdown
## Project preferences

- Keep explanations concise unless the current request asks for detail.
- Include the checks actually run when reporting code changes.

## Project facts

Other workspace context belongs outside the preference section.
```

The heading must be unindented and appear outside a fenced code block, HTML comment or
blockquote. The section ends at the next ATX heading (`#` or `##`) outside those constructs,
or at the end of the file. Setext headings (text underlined with `=` or `-`) are not delimiters.
Subheadings may appear within it. Other headings, including an existing “User preferences”
section, and arbitrary legacy preference prose are not interpreted as this explicit section.
Move an intended shared default into this section rather than keeping competing copies.
Existing prose remains ordinary memory on full-context paths; the runtime does not migrate
or reconcile it automatically.

These defaults are shared project content. A current user request can override a default for
that turn. An override does not itself authorize a persistent change: update the section only
through an authorized file edit. Emptying or removing the section withdraws its defaults from
subsequent snapshots. No automatic preference capture is added. The model-driven `/learn`
workflow still decides which authorized edits to make; its learning quality is not validated
by these source-delivery checks.

## Bounds and source state

The complete file is limited to 64 KiB and the preference section to 4 KiB. The runtime reads
within the active project root and rejects filesystem escapes. It distinguishes three states:

| State | Meaning |
| --- | --- |
| Present | One valid explicit section supplies the current project defaults. |
| Absent | The file or section is missing, or the section is empty; earlier snapshots of this section no longer supply defaults. |
| Unavailable | The source cannot be used, for example because it is unreadable, oversized, invalid, outside the project root, or contains duplicate preference sections. This does not establish withdrawal. |

The runtime does not silently apply a truncated preference section. Withdrawal concerns this
project's explicit section; it does not cancel current user instructions or unrelated context.
Oversized, unreadable or unsafe files are also omitted from the broad `INSTAFY.md` projection;
this replaces the former best-effort 12 KiB prefix for such files. Keep project memory small
and move procedures into applicable skills.

## Deterministic memory trimming

After `/learn`, the runtime optimizer preserves the complete current explicit section and
archives only other memory. The section is moved to the beginning of the file, separated from
the generated notice by a real heading. The resulting file, including the notice, is at most
10,000 bytes. Repeating optimization without further edits leaves it unchanged.

The optimizer uses the same bounded reader and parser as prompt delivery. It skips trimming
when the source is unavailable or the proposed result would change the effective defaults.
For example, a maximum-size section at end-of-file without a final newline can be left intact
because adding a separator would exceed its bound. A skip is recorded as `instafySkipReason`
in the `learn/optimizer` artifact; other learned-index maintenance can still proceed.

Overflow must be saved before the source is shortened. Detected source edits or deletion abort
replacement; existing archive contents never restore an old preference. This protects the
section present after the model's edits, not a saved version from before `/learn`. It does not
prove that a model will learn or edit the correct preferences.

## Prompt delivery and responsibility

Each eligible execution prompt receives one scoped snapshot, including restored conversations,
compact worker and lead-continuation prompts, MCP tasks, direct workers and recovery attempts.
The normal workspace-memory projection omits the same section to avoid supplying it twice.
Native Codex execution reloads the authorized project's source before each new model step,
including continuation after compaction and restoration from a persisted rollout. An in-flight
request keeps its captured context. Direct workers that do not use Codex still refresh at prompt
construction. Routing preflight is outside this contract. `/learn apply` uses normal project
execution and receives the same defaults; this does not validate what the learner infers.

Codex delivery uses its supported World State extension. The runtime supplies the typed project
scope and workspace root, removes only its own captured prompt prefix, and renders one native
snapshot at user authority. It suppresses an unchanged snapshot only while its complete scoped
fragment remains visible. The persisted comparison state contains scope, revision and source
status, not a second authoritative copy of the preference text. The workspace remains the source.
Older snapshots can remain in conversation history; the latest scoped update supersedes them,
and an empty update explicitly withdraws only that project's defaults.

Existing controller authorization continues to determine project access and permitted work.
The preference snapshot grants no additional access or execution permission. Skills continue
to define semantic workflows; the runtime owns scoped delivery, source-state handling and size
bounds. See [the memory and learning guide](Learn-Benchmarking.md) for the separate `/learn`
and learned-skill mechanisms.

## Verified lifecycle and limits

Local integration tests run the actual job processor, embedded Codex and Instafy proxy against
an inert provider for both ChatGPT streaming and API-key Responses JSON. A real tool call plus
synthetic high token usage forces native mid-turn compaction. The fixture changes the preference
during compaction, verifies the current revision on the next sampling request, removes the
section, then verifies withdrawal after a fresh job processor and Codex thread manager restore
the saved rollout. The opaque compaction item is retained byte-for-byte, including when it
arrives only as a completed stream item. Initial delivery is not duplicated, and defaults remain
at user authority.

These tests prove transport and source refresh on the pinned Codex integration. The fake provider
does not interpret encrypted context or judge model behavior. They do not prove live-provider
compatibility, semantic learning quality, faster tasks, or reduced human correction effort.
They do not cover private account-wide preferences or automatic follow-up execution.
