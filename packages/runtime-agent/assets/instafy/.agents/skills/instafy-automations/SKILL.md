---
name: instafy-automations
description: Save reminder preferences for Octo suggestions, including dismissals and postponements, and create or update Instafy schedules from natural-language requests.
context_kind: workflow
context_parent: instafy-skill-router
routing_keywords: automation, reminder, remind, reminded, stop reminding, don't remind, do not remind, tonight, weekend, postpone, later, less often, check-ins, cadence, schedule, every day, every week, hourly, recurring task, run later
---

# Automations

Never prune: yes

Goal: persist the person's reminder and scheduling choices through the CLI, with times interpreted in their local timezone. A conversational acknowledgement alone does not save a preference.

## Replies to Octo suggestions

When the person refers to the proactive suggestion in this chat, read its saved preference first:

```bash
instafy recommendations current --json
```

These commands default to the active runtime conversation. `--conversation <UUID>` is available for a signed-in caller, but a scoped runtime job can act only in its current delivered chat. Use the existing credential; do not read the private review anchor or try a different account.

- **“Don't remind me about this again” / “I don't want this suggestion”**: run `instafy recommendations dismiss --json`. This suppresses the current topic and cancels its pending reminder; other topics and the space's review cadence stay unchanged.
- **“Remind me tonight” / “Let's do that this weekend” / “Later instead”**: resolve a future date and time, then run `instafy recommendations remind --at "<datetime>" --timezone "<IANA timezone>" --json`. This replaces the topic's pending reminder. The controller posts a reminder in this same chat at that time; it does not execute the suggested task or create another chat.
- **“Stop these check-ins altogether” / “Check in less often” / “Only on Fridays”**: use the space review schedule flow below. Do not turn a change to the overall cadence into a dismissal of just this topic.

Inspect the returned `status`, `remindAt` and `timezone` before confirming. If a result is uncertain, read `current` again before retrying. Never claim a reminder or dismissal is saved when the command failed. A `404` on `current` can mean an ordinary chat without a delivered recommendation: use the normal automation flow for the requested reminder or existing schedule. Do not invent a recommendation, dismiss another topic, or fall back to a new automation after a denied/failed preference change.

Keep the reply natural: “I won't bring up this task again,” or “I'll remind you here on Saturday, 10 October at 10:00 (Europe/Vienna).” State the exact saved local date/time for a postponement and mention any assumed time briefly. Don't do the task now or schedule it to run automatically unless the person explicitly requested automatic execution.

## Change the space review cadence

List `instafy automations list --space "<Project ID>" --json` and locate the existing `mode: "space_review"` automation for this space. Preserve its prompt, private visibility and mode. Change that record instead of creating another review.

- Stop check-ins: `instafy automations pause <automation-id> --json`.
- Every Friday at 10:00: `instafy automations update <automation-id> --schedule-kind weekly --days fr --time 10:00 --timezone "<IANA timezone>" --json`.
- Every two days: `instafy automations update <automation-id> --schedule-kind hourly --interval-hours 48 --json`.

Updating cadence preserves paused status. Resume only when the request asks to start check-ins again. If there is no matching schedule, say so rather than silently enabling one. For “less often,” inspect the existing cadence and choose a reasonable reduction; state it after successful persistence. Ask only when multiple schedules or unclear intent prevent identifying the requested change.

## Ordinary reminders and scheduled work

Use the existing CLI and prefer `--json`. For `automations list` and `create`, pass `--space "<Project ID>"` from the runtime context. `update`, `pause`, `resume`, `run` and `delete` take the observed automation ID and no `--space`.

Interpret dates in the timezone supplied by client context or explicitly chosen by the user. Ask if no reliable timezone is available; never substitute the server timezone or infer it from a language. Before creating a schedule, list existing automations when the same task may already have one. Update the matching record instead of creating duplicates.

Keep an automation's `--prompt` about its task, with timing in schedule flags. For a reminder, the prompt should tell the person to revisit the task, not perform it. Only schedule automatic execution when explicitly requested. For a check that should stay quiet without new findings, pass `--silent-when-nothing-to-report` and describe the meaningful reporting condition in the prompt.

## Schedule mapping

- **In X minutes / later today / tomorrow at 9**:
  - use `--schedule-kind once`
  - compute `--run-at` as a local datetime in the chosen timezone
- **Every N hours**:
  - use `--schedule-kind hourly --interval-hours N`
- **Every morning at 8 / every day at 8**:
  - use `--schedule-kind weekly --days mo,tu,we,th,fr,sa,su --time 08:00`
- **Every weekday at 8**:
  - use `--schedule-kind weekly --days mo,tu,we,th,fr --time 08:00`
- **Every weekend at 9**:
  - use `--schedule-kind weekly --days sa,su --time 09:00`

Reasonable defaults, stated in the confirmation: “morning” is `08:00`, “tonight” is `20:00` today, and “this weekend” is Saturday at `10:00`, in the chosen timezone. Compute against the current local date rather than copying example dates. If that candidate is already past, or the phrase could mean different weekends, ask a short clarification instead of silently rolling it forward. For an ambiguous or nonexistent local time around a daylight-saving change, clarify a valid time or explicit UTC offset; don't silently choose an occurrence. Confirm the controller's saved time, including any normalization, rather than echoing the input as proof.

## Create and verify

Choose a short concrete name, the task or reminder text, a schedule, and the user's timezone. For example, an ordinary reminder can be created with:

```bash
instafy automations create --json \
  --space "<Project ID>" \
  --name "Laundry reminder" \
  --prompt "Remind me to take the laundry out." \
  --schedule-kind once \
  --run-at "<future local datetime>" \
  --timezone "<IANA timezone>"
```

Read the saved result before confirming. Describe the actual schedule in plain language, including the local date/time and timezone for one-shot reminders. Report a failed save accurately instead of claiming success or asking the person to use the UI when the CLI can complete the request.

## Relative time helper

For relative one-shot reminders, compute the local run time first, then pass it to `--run-at`.

Example:

```bash
python - <<'PY'
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

tz = ZoneInfo("Europe/Vienna")
run_at = datetime.now(tz) + timedelta(minutes=10)
print(run_at.strftime("%Y-%m-%dT%H:%M:%S"))
PY
```
