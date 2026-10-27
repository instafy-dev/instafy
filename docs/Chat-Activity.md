# Chat activity line

A turn in chat shows Octo's reply and one plain-language line that says what the turn did:

```
Looked up 14 places, read 6 pages, built the map   Details ›
```

While the turn runs, the line names the current step ("Looking up places…", "Reading pages…") and
says "Thinking…" between steps. Details holds everything else: each command and its output, tool
calls, Octo's notes and plan updates. This page describes where the words come from and why they
can be trusted.

## Where labels come from

Every step a runtime streams (a command, a tool call, a web search, a file edit, a status the
runtime writes itself) may carry an `activity` in its message metadata. The runtime attaches it
from trusted data only, in this order:

1. **A skill pack installed with the runtime.** A pack declares its commands in `bin` and labels
   their subcommands in `activity` ([Skill packs](Skill-Packs.md#activity-labels)). The pack is
   pinned by its release sha256 in `packages/runtime-agent/skill-packs.json`, which is the trust
   root. A pack a space imports itself never supplies labels.
2. **Instafy's own CLI**, from a table in `runtime-agent` (`jobs/activity_labels.rs`):
   `instafy web read <url>…` is "Reading pages" and counts its URL arguments; `instafy preview
   open` and `instafy preview check` are quiet (the preview card already says it);
   `instafy bind init|serve`, `instafy tunnel start` and `instafy conversation search|grep|show`
   have their own words; `instafy secrets …` and `instafy agents context …` are quiet.
3. **A few common tools**: package installs (`pnpm`/`npm`/`yarn` `install|i|add`), test runners
   (`pnpm test`, `npm run test`, `cargo test`, `pytest`, `vitest`), builds (`pnpm build`,
   `npm run build`, `cargo build`) and `git clone`. Web searches, file edits, browser tool calls
   ("used the browser") and other tool calls ("used a tool") have fixed labels too, as do the
   runtime's own statuses: saving the turn's changes and retrying a request.
4. **Anything else gets no label.** Studio counts those steps instead ("Ran 3 commands").

A label is never built from command output, page text, a page title or text the model wrote. The
only values that fill one are a count (`{n}`) and, for a browser step, a host name the runtime
checked (`{host}`). Octo's own status notes and reasoning titles never feed the line: they are
free text written after reading pages, so they stay in Details.

## Matching a command

`runtime-agent` reads only a command's argv (`command_argv`), or its command line when there is no
argv. A `bash -lc '<script>'` script is parsed with tree-sitter-bash, the parser Codex's own command
checks use. A script over 16 KiB, or one that does not parse cleanly, gets no label.

- The script is split into simple commands. `NAME=value`, `env`, `command`, `exec`, `time`,
  `nohup` and `timeout <duration>` in front of a program are skipped, and redirections are
  ignored.
- The program is resolved in order: a shell function the script defines that only runs a pack
  command with its own arguments (`uw() { node <pack>/scripts/uw.mjs "$@"; }`); a command a pack
  declares in `bin`; `node <path>` where the path ends in `<pack>/<entry>` of an installed pack or
  in the space launcher `.agents/skills/<pack>/<path>`; Instafy's CLI; the common tools. A function
  that runs anything else hides a command of the same name.
- A pack command's subcommand is its first argument that is not an option. Its label is
  `activity[<command>][<subcommand>]`, else `activity[<command>]["*"]`.
- Command and process substitutions, words built from variables, here-document bodies, function
  bodies that are never called and `case` bodies are never looked inside.
- The step's `activity` is its first labelled command. Up to 3 further distinct labels go in
  `also`. `count` is how many simple commands matched; a match inside a loop counts as an unknown
  number (`null`), and the line then says "looked up places".

Exit status reaches Studio through the step's own `status` and `exitCode`; a label with
`when: "success"` counts only for a command that exited 0.

## The `activity` object

```json
{ "v": 1, "key": "pack/interactive-map/uw/add-point", "role": "content",
  "live": "Looking up places",
  "done": { "one": "looked up a place", "other": "looked up {n} places", "some": "looked up places" },
  "count": 1, "also": [] }
```

- `role` is `content` (what the turn did; the two biggest are named), `outcome` (what it made;
  the latest is named last) or `quiet` (shown only while it runs and in Details).
- `done` is one form for any count, or `one`, `other` (with `{n}`) and `some` (count unknown).
- `when: "success"` counts the step only when it exits 0.
- Browser steps may also carry `host`, `pageKey` (16 hex characters, never the URL), `step` and
  `approval`.

## The label rules

The runtime, the controller and Studio check every label with the same rules
(`packages/runtime-contracts/src/chat_activity.rs`, pinned by `chat_activity_fixtures.json`, which
Studio's and the pack installer's copies are tested against):

- a `live` label starts with an upper-case letter and is at most 40 characters;
- a `done` form starts with a lower-case letter and is at most 48 characters once `{n}` is 999;
  `{n}` is the only count placeholder and appears exactly once in `other`, never elsewhere;
  `some` is required with `other`;
- plain words only: letters, digits, single spaces and `' , . - – · : ; ( ) & ! ?`; no control or
  bidi characters, no `www`, no dot inside a word, no `@`, `/`, `<`, `>`, `[`, `]`, `{` or `}`
  (apart from the placeholders);
- an `activity` with an unknown field, a bad count or more than 3 further labels is dropped as a
  whole.

## Trust

The line is exactly as trusted as Octo's reply, because the same runtime writes both. What this
design guarantees is that third-party content (command output, web pages, Octo's notes written
after reading them) never becomes label text, and that even a misbehaving runtime can only show a
short plain phrase.

The controller is the only way a label reaches a message. `POST /agent/message` (a runtime agent
token with `agent.message`, for a job its runtime leased) wraps the runtime's metadata under
`details`; the controller checks `details.activity` and lifts a valid one to the message's
top-level `metadata.activity`, removing it from `details` either way. Every other write path (a
recorded message, a dispatch) drops `activity` wherever it appears. Studio reads `activity` only
at the top level of an assistant message whose `source` is `agent` and that belongs to the turn's
job, and checks it again.
