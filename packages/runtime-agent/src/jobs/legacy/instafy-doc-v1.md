# INSTAFY.md — Project memory (keep tiny)

This is a **small, self-improving memory** for this workspace. It should work for **any** kind of project (code, content, data, planning, research).

Definitions:
- **User/operator**: the human(s) using this workspace (“User”).
- **Agent**: the AI assistant working in this workspace (“Agent”). If you are an Agent, that is you.

Rules:
- Keep this concise; prefer tables/bullets over prose.
- Hard size budget: keep this file under ~10k bytes. If it grows, move details into learned blocks under `.agents/skills/instafy-learned/blocks/` and keep only a short pointer here.
- Never store secrets (keys, tokens, passwords).
- Store project-specific facts and stable user preferences only (not general knowledge).
- Prefer available skills/tools (CLI/MCP) for procedures; don’t paste long how-tos here.
- For local hardware/IO, use compact agent context cards as soft guidance and verify on the active runtime before claiming access; ask for Desktop/CLI on the attached machine when cloud or Docker cannot reach the device.

Start-of-task ritual (Agent must do this before taking action on the workspace):
1) Load the project-memory snapshot (prefer `python AGENTS.py` if present; otherwise read `INSTAFY.md` + `.agents/skills/*/SKILL.md`).
2) Skim skill files only when relevant to the user request or before making non-trivial workspace changes.
3) For trivial/general questions (e.g. arithmetic) that don’t require workspace context, answer immediately without running shell commands first.

## Snapshot

- Workspace: <1–2 sentences>
- Primary goal now: <short>
- “Done” means: <short>
- Kind: code | content | data | mixed | unknown
- User preferences (optional):
  - Users want AI agents to reply in <Language>.

## Constants (don’t guess)

Stable facts an agent/tool should not infer.

| key | value | notes |
| --- | --- | --- |
| <…> | <…> | <…> |

## Workflows (optional)

Only list the common “user intents” for this workspace and the safest default path.

| intent | default steps | outputs | verify |
| --- | --- | --- | --- |
| <…> | <…> | <…> | <…> |

## Tools (skills + MCP)

Before doing work, first discover what skills/tools are available in this runtime. If a needed capability is missing, prefer adding/enabling a skill or MCP tool over encoding bespoke shell steps here.

Learn:
- `/learn:collect` → scan-only (no model call)
- `/learn` → AI-driven update of workspace memory (skills + `INSTAFY.md`)

## Persistent Context Knowledge

Knowledge can live in persistent context files in `./.agents/skills/<skill-name>/SKILL.md`.
- Keep generic policy and workflow knowledge in skills.
- Keep compact per-agent/per-scope soft facts in controller-backed context cards (`instafy agents context list/put`); relevant project cards may already be included in the prompt as soft hints.
- Use those cards for soft work focus and overlap guidance (current direction, paths/domains, open questions, and the thread to ask next). They are not locks or a first-class ownership ledger.
- `/learn` typically writes learned workflow-memory blocks under `./.agents/skills/instafy-learned/blocks/*/`.
- Legacy `./learnings/` exists for compatibility only; avoid writing new items there.

Keep this file tiny: it should reference skills, not duplicate them.
