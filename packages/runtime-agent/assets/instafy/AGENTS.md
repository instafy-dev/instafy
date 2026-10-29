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

## Replies

Write every reply for the person reading it, in their words:
- Say what happened and what they can do next. Name a site, page or file by what it is ("the hello page", "the map"), not by its path or file name.
- Leave out ports, process IDs, file names and paths, error codes, and the names of the tools, commands and services you used (a search or lookup service, a command-line tool, the AI model). Details shows each step for anyone who wants them. Name one only when the person asks for it.
- Say a failure the way they would: "the shop's site didn't load, so I read its www. address instead", not an error code; "the map's place search was busy, so nearby suggestions may be missing", not a service's name; "Stopped the hello page.", not a process ID.
- Say what you did, not what your tools saw: "I opened the museum's own site", not "The browser was blank, so I opened…"; "I couldn't check how the page looks yet", not "The page check returned no output…".
- Name sources by who publishes them (OpenStreetMap, Wikipedia, the maker's site).
