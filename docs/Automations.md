# Automations

Automations run project prompts in the background on a schedule. Each automation belongs to one
user and project. The default `prompt` mode writes visible results to its automation conversation.
The explicitly opted-in `space_review` mode starts a normal private Octo chat only when it finds a
useful new topic; see [Space review](Space-Review.md).

## Space review mode

Create a review schedule explicitly; no schedule is enabled automatically:

```bash
instafy automations create \
  --space "<Project ID>" \
  --name "Octo check-in" \
  --mode space_review \
  --schedule-kind hourly \
  --interval-hours 24
```

The controller uses fixed instructions for the bundled review skill, with private results and
quiet runs. The CLI rejects a custom `--prompt` or team visibility in this mode. The API ignores
a custom create prompt in favor of the fixed instructions. `mode` is returned in the record and
cannot change after creation; omitting it creates a normal `prompt` automation as before.

There can be one review automation per owner and project. It supports the existing once, hourly
and weekly schedules, pause/resume and manual run. A manual run returns a conflict while a review
is already pending. Schedule, name and runtime settings can be updated, but the managed prompt,
private visibility and quiet setting cannot be changed. Deleting and recreating the schedule
reuses its private execution anchor so prior delivery memory remains accessible.

The private execution anchor is internal audit history and is excluded from ordinary chat lists,
search, unread activity and result notifications. A useful finding is delivered separately as one
normal private Octo chat with a grounded opener, source links and a natural next step. This does
not dispatch suggested work; the person can reply normally. A successful run with no new finding
creates no chat. Delivered topics and legacy accepted/dismissed choices are retained to prevent
repetition, including when a delivered chat is archived or deleted. Runs and errors remain
observable in Automations. This mode does not widen the runtime's private conversation access.

Apply the ordered migration `20261002122000_quiet_space_review_automations.sql` together with the
preceding recommendation delivery migration before deploying the matching controller, runtime
skill and CLI. Existing prompt automations retain their mode and defaults.

## Schedules and threads

The controller supports three schedule kinds:

- `once` runs at one future `runAt` time.
- `hourly` runs every configured number of hours.
- `weekly` runs on selected weekdays at a local hour and minute in an IANA timezone.

Creating a prompt automation also creates its result conversation and adds the owner as a participant.
Later runs reuse that thread, so results stay together without appearing in an unrelated chat.
Pausing an automation stops scheduled runs without deleting its configuration or thread.

The owner can update an automation in place through the same controller route that pauses and
resumes it (`PATCH /automations/{id}`) or with `instafy automations update`. In prompt mode, any
subset of the name, prompt, schedule (kind, `runAt`, `intervalHours`, `byDay`, `byHour`, `byMinute`,
`timezone`), runtime mode and provider, and quiet-run setting can change; validation matches
creation. The automation keeps its id and conversation thread, so run history stays attached. The
controller recomputes `nextRunAt` only when the effective schedule or the status changes; editing
the prompt or runtime settings does not move a pending run. A request without any field is
rejected.

## Reviewing scheduled work in Studio

Automations is a primary space navigation item. Each row separates its schedule state, next run,
last launch attempt and launch error from the latest attributable turn. **View thread** opens
and activates the result chat, updating browser history so Back returns to Automations.

The panel loads one shared page of up to 100 recent runs per account and space. Live updates
only enrich runs returned by that authorized query. If access is denied, history is unavailable,
or the relevant turn is outside that page, the UI says details are unavailable and offers the
thread. Missing history does not prove that an automation never ran.

**Turn completed** describes execution status, not whether a bug was fixed or a change deployed.
The latest update remains visible for context, including when it reports a blocker. Existing
private result conversations remain private.

## Share results with your team

For prompt mode, an automation's result conversation is private to its owner by default. Other
members can see the automation record (status, next run, last error) but not the result threads. An automation can opt
in to sharing so its result conversation becomes visible to anyone with access to the space.

The choice is stored as `resultVisibility` in the controller API, backed by the
`automations.result_visibility` column. It is an enum:

- `private` (default) keeps the result conversation owner-only.
- `team` makes the result conversation team-visible.

Internally `team` maps onto the conversation `public` visibility. The conversation list gate shows
any non-private thread to members with project access, so a shared automation's results appear for
teammates while the automation stays owner-managed. "Team" means visible to anyone with access to
the space; it is not world-readable, because listing is still gated by project access.

`resultVisibility` is accepted on automation create and update, validated to `private` or `team`,
and returned on the automation record. Updating it also updates the existing result conversation's
visibility so past and future runs follow the current setting. The CLI exposes this through
`instafy automations create --share-results` and
`instafy automations update <id> --share-results | --no-share-results | --result-visibility <private|team>`
(see [CLI](CLI.md#share-results-with-your-team)).

## Quiet runs

For prompt mode, quiet runs are opt-in through `silentWhenNothingToReport` in the controller API, backed by the
`automations.silent_when_nothing_to_report` column. The option defaults to `false`, including for
automations created before the option existed.

In Studio, enable **Only notify me when there’s something to report** in the automation editor.
The CLI exposes the same setting at creation time (and later through
`instafy automations update <automation-id> --silent-when-nothing-to-report` or
`--no-silent-when-nothing-to-report`):

```bash
instafy automations create \
  --space "<Project ID>" \
  --name "Dependency change check" \
  --prompt "Check whether dependency versions changed and report the changes." \
  --schedule-kind weekly \
  --days mo,tu,we,th,fr \
  --time 08:00 \
  --timezone "Europe/Vienna" \
  --silent-when-nothing-to-report
```

When the option is enabled, a run is silent only when it succeeds and the agent explicitly emits
exactly `NO_RESPONSE` as its decline signal. The controller does not persist that sentinel, so the
conversation receives no completion result message and no result push notification is sent for
it. The scheduled prompt and any execution telemetry remain observable. The sentinel contract is
shared with [group conversation participation](Group-Conversation-Participation.md), but silence
remains scoped to the opted-in automation.

Silence never applies to these cases:

- The agent produces a real summary or other visible output.
- The run fails or returns an error.
- The agent produces empty or absent output without the explicit sentinel; the controller keeps
  the normal completion placeholder so unexpected breakage remains visible.
- The automation has the option disabled; existing behavior is preserved.

## Auditability

Quiet affects conversation delivery, not execution records. The automation still records its last
attempt and error state, and the associated run and job still reach their normal terminal status.
The explicit decline bookkeeping is also retained. Operators can therefore distinguish a
successful run with nothing to report from a run that failed, even though the successful decline
created no completion chat message.
