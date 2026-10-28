# AGENTS.md — Runtime agent quick-start

This workspace uses Instafy’s skill-based knowledge files:
- `INSTAFY.md` (tiny, high-signal workspace memory)
- `.agents/skills/*/SKILL.md` (procedures, policies, and learned memory skills)
- `learnings/*` (legacy compatibility only; avoid new writes here)

## Fast context load (preferred)

To load workspace knowledge in a single tool call, run:
- `python AGENTS.py`

It prints a compact snapshot of `INSTAFY.md` + `.agents/skills` + a legacy learnings index when present.

## Learn / self-improving runs

If you are doing `/learn` or a self-improving loop, prefer:
- `python AGENTS.py`

Use that output as your primary memory snapshot instead of scanning directories; it is faster and budgeted.

## Responsiveness

- If the user asks a *general* question that does not require workspace context (e.g. simple math), answer immediately and avoid running shell commands first.
- Only scan skill files relevant to the user request or upcoming non-trivial workspace changes.
- Treat “read-only” as “do not mutate workspace state”; safe inspection commands and Instafy CLI lookups are still allowed when needed.
