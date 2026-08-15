# Automations

Automations run project prompts in the background on a schedule. Each automation belongs to one
user and project and writes its visible results to a private automation conversation.

## Schedules and threads

The controller supports three schedule kinds:

- `once` runs at one future `runAt` time.
- `hourly` runs every configured number of hours.
- `weekly` runs on selected weekdays at a local hour and minute in an IANA timezone.

Creating an automation also creates its private conversation and adds the owner as a participant.
Later runs reuse that thread, so results stay together without appearing in an unrelated chat.
Pausing an automation stops scheduled runs without deleting its configuration or thread.

## Quiet runs

Quiet runs are opt-in through `silentWhenNothingToReport` in the controller API, backed by the
`automations.silent_when_nothing_to_report` column. The option defaults to `false`, including for
automations created before the option existed.

In Studio, enable **Only notify me when there’s something to report** in the automation editor.
The CLI exposes the same setting at creation time:

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
