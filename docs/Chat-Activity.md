# Chat activity line

A turn in chat shows Octo's reply and one plain-language line that says what the turn did:

```
Looked up 14 places, read 6 pages, built the map   Details ›
```

While the turn runs, the line names the current step ("Looking up places…", "Reading pages…") and
says "Thinking…" between steps. Details holds everything else: each command and its output, tool
calls, Octo's notes, reasoning titles and plan updates. This page describes where the words come from and why they
can be trusted.

## In Studio

The line sits in the turn under Octo's name, above the reply (`TurnActivityLine.tsx`). Its words
come from `turnActivity.ts`, a pure module that reads the turn's steps:

| Turn | Line |
|---|---|
| Queued or starting, before the model has begun | `Starting…` |
| Running a labelled step | its running label, for example `Looking up places…` (the newest running step wins) |
| Running an unlabelled command or tool | `Working…`; a file edit says `Editing files…` |
| A runtime status is the newest thing | `Saving your changes…`, `Retrying…`, until anything newer arrives |
| The model is working, before or between steps | `Thinking…` (never its reasoning titles or notes) |
| A request in the turn waits on the person viewing | `Waiting for you`, only for the person who can answer: a Shared Browser prompt of the turn's run ([Browser prompts](#browser-prompts)) |
| Done | up to two "what it did" groups, biggest first and in the order they happened, then the latest "what it made": `Looked up 14 places, read 6 pages, built the map`; then, after ` · `, what the person answered to the turn's browser prompts |
| Done, nothing labelled | a neutral count: `Ran 5 commands`, `Ran 3 commands, used 2 tools`, `Edited 4 files` |
| Stopped by the person | `Stopped · looked up 9 places`, or `Stopped` |
| No news for 45 seconds while not in flight | `Status unavailable` |

- Once the turn has a step, the whole line is one button that opens Details (`aria-expanded`,
  `aria-controls`); it reads "Details ›", then "Hide details", and opens and closes as often as it
  is pressed. Opening Details never moves the line or changes the turn's chrome. A failed turn has
  one Details, its failure block's, which lists the steps after the error text, and its line is
  plain text.
- Details (`TurnActivityDetails.tsx`) lists the turn in order: each command with its label, the
  command without its shell wrapper (the full line is its title), its state and its output behind
  a chevron, collapsed until opened; tool calls, web searches and file edits; Octo's notes,
  reasoning titles, plan updates and statuses. A failed step reads as what it was doing ("Checking
  the map"), never as what it would have done. It shows the newest 60 rows, with "Show earlier
  steps" above them; pressing that moves focus to the first row it reveals.
- Cards (secrets, connections, action and preview cards, team plans) stay in the turn's default
  view, and the file changes stay under the reply. Run traces keep their full view.
- A command on its own in the conversation is one row: its label (or "Ran a command"), its state
  and a chevron that shows the command and its output.
- The typing row that shows under a newer message while a turn runs (a person wrote in the
  meantime) says the run's phase ("Thinking…", "Retrying…"), never Octo's notes or reasoning
  titles, for the same reason as the line.
- The running line is the turn's one polite live region; it announces a new label at most every
  5 seconds. Reduced motion turns the sweep off. On coarse pointers the line and the rows are at
  least 44 px tall.
- A message without a valid `activity` (an older runtime, history, a label that breaks a rule)
  counts as an unlabelled step, so mixed versions read the same.

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
   runtime's own statuses: saving the turn's changes and retrying a request. A Shared Browser
   step names its site (see [Browser steps](#browser-steps)).
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

## Browser steps

A Shared Browser step says what it did and on which site: "Searching visitlisboa.com…" while it
runs, then "Searched visitlisboa.com, read 2 pages" in the turn's line.

- **The browser reports it.** The Shared Browser controller (`assets/shared-browser-cli.js`)
  adds `activity: {step, url, approval}` to each step's result: the step's kind, the masked
  address of the page the step left the tab on (only on a site the run may read) and how it was
  allowed. It comes from the browser's own state, never from page text. `approval` is `once` when
  the step waited on a prompt (its site's or its own) and the person allowed it, `routine` when
  routine browsing took an acting step without one, `free` for a site's own search
  ([Shared Browser](Shared-Browser.md#human-approval-policy)), and absent when the step needed no
  answer.
- **runtime-agent keeps four facts** (`shared_browser_activity.rs`), when the tool call ends:
  `step` (one of `navigate`, `open_tab`, `snapshot`, `search`, `submit`, `click`, `type`,
  `press`, `scroll`, `tabs`, `status`); `host`, the address's domain in lower case without a
  leading `www.` (an address literal, a name without a dot or one the contract rejects gives
  none); `pageKey`, the first 16 hex characters of the SHA-256 of the address without its
  fragment, never the address; and `approval`, `once`, `routine` or `free` from the controller, or
  `denied` / `expired` from the step's terminal consent code. When the step starts, `navigate`
  and `open_tab` take the host from the address Octo asked for; any other step, and a step
  whose result names no page, uses the last host the turn's browser steps named. A step the
  person said no to, or left unanswered, never reaches the page, so its kind comes from the tool
  call: typing with submit is `submit` (a form), whatever field it was for.
- **The labels** (`jobs/activity_labels.rs`):

  | Step | Running | Done (one / other / some) | Role |
  |---|---|---|---|
  | `navigate`, `open_tab` | Opening {host} | opened {host} / opened {n} pages on {host} / opened pages on {host} | content |
  | `snapshot` | Reading {host} | read a page on {host} / read {n} pages on {host} / read pages on {host} | content |
  | `search` (typing with submit, or Enter, in a search field) | Searching {host} | searched {host} / searched {host} {n} times / searched {host} | content |
  | `submit`, `click`, `type`, `press`, `scroll`, `tabs`, `status` | Browsing {host} | – | quiet |
  | no host known yet | Using the browser | used the browser | content |

- **Studio** groups browser steps by key and host. Pages opened and read count by distinct
  `pageKey`, so reading a page twice is "read a page"; searches count each time. After a group on
  the same site, a group's trailing " on {host}" goes: "Searched visitlisboa.com, read 2 pages".
  A host in punycode shows in Unicode when all its letters are of one script (or one of the CJK
  sets written with Latin, Unicode's "highly restrictive" profile), so "münchen.de" reads as
  itself and a name that mixes scripts stays in punycode (`activityHost.ts`).
- The Personal Browser's steps say "used the browser" until its results carry the same
  `activity`.

## Browser prompts

When a Shared Browser step needs the person's answer, the turn shows it as one row under its
activity line, to the person who started the run only, and the line says `Waiting for you`:

```
🔒 Octo wants to send the form “Search” on visitlisboa.com.   [Deny] [Allow]
```

- **The row** (`BrowserApprovalRow.tsx`) names the step in one sentence: `Octo wants to use
  {host}.` (or `to open {page}.` when the site prompt names the page it loads), `to open {page}.`,
  `to click “{label}” on {host}.`, `to type into “{label}” on {host}.`, `to send the form
  “{label}” on {host}.` (plus `It goes to {site}.` when the form posts to another site), `to press
  Enter on “{label}” on {host}.` and `to press {key} on {host}.` `{label}` is the runtime's
  already-masked name of the control, cut at 40 characters: the page's own words appear only
  here, where the person needs them to decide, never in the line. `Allow site` answers a site
  prompt and `Allow` one step; neither button takes focus. In the prompt's last minute the row
  says `Expires in under a minute`; an error shows after the buttons. The row is a labelled
  group, says `Octo needs your answer: …` once to screen readers, and its buttons are 44 px tall
  on coarse pointers.
- **Where it shows.** ChatPanel provides the prompt of the viewer's running browser job
  (`turnBrowserApproval.tsx`); the turn whose job that run serves claims it and shows it under
  its line, with no avatar of its own. When no turn on screen claims it within 300 ms (the turn
  is not in this view), the chat shows the same row at the end of the transcript, with Octo's
  avatar. The browser view's sheet shares the same approval state, so answering one settles both.
- **Once answered**, or left to expire, the row goes and the turn's done line gains one clause
  after ` · `, and Details an entry with a lock:

  | Outcome | Clause |
  |---|---|
  | allowed | `you allowed a search on visitlisboa.com` |
  | said no | `you said no to a search on visitlisboa.com` |
  | no answer | `skipped a search on visitlisboa.com: no answer in time` |

  The noun comes from the step's own `activity` (`step` and `approval`), so it reads the same
  after a reload: `a search`, `a form`, `a click`, `typing`, `a key press`, `opening {host}`, or
  the site itself (`the site` when the line already names it). The host is left out when the line
  already names it first: `Searched visitlisboa.com, read 2 pages · you allowed a search`.
  Several answers read as the latest one counted: `you allowed 2 steps`. When no step carries an
  answer (an older runtime), the prompts answered in this tab stand in, named by their
  operation.

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
