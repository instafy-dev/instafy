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
Updates and removals are read at prompt-construction boundaries; this is not a promise of
immediate refresh during an active model turn.
Routing preflight and learning prompts are outside this delivery contract.

Existing controller authorization continues to determine project access and permitted work.
The preference snapshot grants no additional access or execution permission. Skills continue
to define semantic workflows; the runtime owns scoped delivery, source-state handling and size
bounds. See [the memory and learning guide](Learn-Benchmarking.md) for the separate `/learn`
and learned-skill mechanisms.

This first slice does not validate preference retention through native provider compaction and
cold resume. Prompt-delivery checks also do not establish better model behavior, faster tasks,
or reduced human correction effort.
