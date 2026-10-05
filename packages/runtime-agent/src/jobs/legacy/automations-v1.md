---
name: instafy-automations
description: Create and manage Instafy automations from natural-language scheduling requests using the Instafy CLI.
context_kind: workflow
context_parent: instafy-skill-router
routing_keywords: automation, reminder, schedule, every day, every week, hourly, recurring task, run later
---

# Automations

Never prune: yes

Goal: turn natural-language reminders and recurring tasks into real Instafy automations using the existing CLI, with times interpreted from the user's local timezone unless they explicitly say otherwise.

## When to use this skill

Use this skill when the user asks to:
- remind them later
- schedule something
- run something every morning / every day / every weekday / every week
- create, pause, resume, run, or delete an automation

## Core rules

- Prefer the Instafy CLI over manual UI clicking:
  - `instafy automations create`
  - `instafy automations list`
  - `instafy automations pause`
  - `instafy automations resume`
  - `instafy automations run`
  - `instafy automations delete`
- Bind project-scoped automation commands to the active project id from the runtime context:
  - use `--space "<Project ID>"` with `instafy automations list` and `instafy automations create`
  - pause, resume, run, and delete are scoped by their automation id and do not accept `--space`
  - the runtime prompt includes `Project ID` in the `Runtime context` section
  - do not rely on implicit CLI project resolution for list or create
- Interpret schedule requests in the user's local timezone from the provided client context unless the user explicitly names another timezone.
- The automation `--prompt` should describe only the task itself. Do not restate schedule details inside the prompt.
- When the user asks to be told only when something changes, only when there are findings, or
  otherwise requests a quiet no-op run, pass `--silent-when-nothing-to-report`. Write the prompt
  so the meaningful condition is explicit; the controller will instruct successful no-finding
  runs to return the private `NO_RESPONSE` signal.
- Prefer `--json` so you can parse and report the created automation cleanly.
- Before creating a new automation, check existing automations when there is a real duplicate risk (same obvious task/name/schedule). Do not create duplicates silently.
- If the schedule is underspecified, make one reasonable assumption and state it briefly instead of blocking. Ask a short clarification only when the missing detail would materially change the schedule.

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

If the user says “morning” without a time, default to `08:00`.

## Naming

- Pick a short concrete name if the user did not supply one.
- Good names:
  - `Laundry reminder`
  - `Morning random number`
  - `Daily standup prompt`

## Create flow

Preferred pattern:

1. Determine:
   - task prompt
   - name
   - schedule kind
   - timezone
2. Create the automation with `--json`
3. Summarize the result in plain language

Examples:

```bash
instafy automations create --json \
  --space "<Project ID>" \
  --name "Morning random number" \
  --prompt "Generate one random integer between 1 and 100 and report it." \
  --schedule-kind weekly \
  --days mo,tu,we,th,fr,sa,su \
  --time 08:00 \
  --timezone "Europe/Vienna"
```

For a findings-only check:

```bash
instafy automations create --json \
  --space "<Project ID>" \
  --name "Dependency change check" \
  --prompt "Check whether dependency versions changed and report the changes." \
  --schedule-kind weekly \
  --days mo,tu,we,th,fr \
  --time 08:00 \
  --timezone "Europe/Vienna" \
  --silent-when-nothing-to-report
```

```bash
instafy automations create --json \
  --space "<Project ID>" \
  --name "Laundry reminder" \
  --prompt "Remind me to take the laundry out." \
  --schedule-kind once \
  --run-at "2026-03-08T20:25:00" \
  --timezone "Europe/Vienna"
```

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

## Good responses

- “Created automation `Morning random number` to run every day at 08:00 (Europe/Vienna).”
- “Created one-shot reminder `Laundry reminder` for 20:25 (Europe/Vienna).”
- “An automation with that same purpose already exists, so I did not create a duplicate.”

## Avoid

- Do not tell the user to open the Automations panel if the CLI can do the job directly.
- Do not invent unsupported CLI flags.
- Do not put schedule text into the automation prompt.
- Do not schedule in UTC when a local timezone is available unless the user explicitly asked for UTC.
