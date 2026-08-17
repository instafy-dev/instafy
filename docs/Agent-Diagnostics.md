# AI-driven diagnostics

Instafy uses a CLI-first diagnostics workflow for Codex, Claude Code, and other local coding
agents. The agent reads authorized, persisted evidence, explains it, and submits a customer
support report only with explicit user consent.

## Surfaces

The public customer CLI provides the only commands used by this workflow:

```bash
instafy diagnostics run-result <runId>
instafy diagnostics runtime-events --space <spaceId> --limit 50
instafy support report "<summary>" --space <spaceId> --run-id <runId> --preview
instafy support list --json
instafy support show <reportId> --json
```

Diagnostics commands return the `instafy-diagnostics-v1` success envelope. The controller
authorizes the signed-in user and preserves project, private-conversation, and private-runtime
visibility rules. Runtime events come from the bounded sanitized event store. A top-level run
result status of `ready` means the persisted payload exists; the nested result still determines
whether execution succeeded.

These commands intentionally reject service-role and scoped runtime credentials. A local agent
uses the human's `instafy login` session. Hosted runtime jobs do not gain customer diagnostic or
support authority through this skill.

## Managed agent workflow

New and existing managed workspaces receive:

- `.agents/skills/instafy-diagnostics/SKILL.md`, the canonical diagnosis and consent workflow;
- `.agents/skills/instafy-diagnostics/agents/openai.yaml`, Codex-facing skill metadata;
- `CLAUDE.md`, a small Claude Code bridge that imports `AGENTS.md` and its instructions for
  loading the canonical `.agents` skills.

Both agents therefore follow one source of truth. The workflow reads the run result first, uses a
small runtime-event window only when needed, distinguishes observations from inference, and
summarizes relevant evidence instead of reproducing entire payloads.

## Consent and data minimization

Diagnostic reads never create or enrich a support report. When the user asks to file a report,
the agent must:

1. run `instafy support report ... --preview`;
2. show which identifiers and attachment categories would be sent;
3. obtain explicit confirmation;
4. submit once, without automatic retry.

Logs, metadata, screenshots, token files, environment files, and full diagnostic JSON are never
attached automatically. Optional attachment files must be explicitly selected by the user and
remain within the active workspace.
