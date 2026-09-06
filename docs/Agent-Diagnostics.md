# AI-driven diagnostics

Instafy uses a CLI-first diagnostics workflow for Codex, Claude Code, and other local coding
agents. The agent reads authorized, persisted evidence, explains it, and submits a customer
support report only with explicit user consent.

## Surfaces

Studio exposes personal **Support** from the profile menu. A signed-in user can review reports
across all of their spaces, inspect customer-safe status and attachment metadata, follow up in a
report-specific support conversation, or start another report. Report ownership remains personal;
membership or administration in the affected space does not grant access to somebody else's
report.

Support activity remains visible until the user opens the report and its current conversation has
loaded. An unread count and blue dot appear on the profile control and Support menu item. Studio
checks again on startup, every 20 seconds while active, and when the app regains focus.
Customer-visible support replies and real resolution transitions also create durable entries in
the [notification center](Notifications.md), with account preferences controlling Web Push, iOS
APNs, and local presentation. Updated Studio uses this platform for transient alerts and disables
its legacy resolution-claim toast. The migration reserves the legacy alert claim atomically with
each new durable resolution event, preventing older clients from also showing that resolution
toast. The compatibility endpoint still handles eligible earlier resolutions. A notification's
read state is separate from the support unread badge, which remains until
the user views the report's current timeline. Android registration is disabled; email delivery is
not implemented. Provider configuration and physical-device delivery require separate verification.

The public customer CLI provides the commands used by the managed-agent workflow:

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
2. show that the signed-in support account identity (including its email snapshot), selected
   identifiers, and attachment categories would be sent;
3. obtain explicit confirmation;
4. submit once, without automatic retry.

Logs, metadata, screenshots, token files, environment files, and full diagnostic JSON are never
attached automatically. Optional attachment files must be explicitly selected by the user and
remain within the active workspace.

Studio follows the same boundary. The issue dialog always previews the space/conversation/runtime
context and screenshots that will be sent. App/runtime logs and browser, build, release, and page
metadata are behind an **Include diagnostics** checkbox that is off by default. The signed-in
account identity and email snapshot are attached to the support case for ownership/contact and are
disclosed separately from diagnostics. Page metadata removes URL query parameters and fragments,
and the browser does not duplicate the account email inside the diagnostic payload. Report
creation, inbox listing, and resolution-alert claims carry the account identity observed by Studio;
the controller rejects the request if the authenticated account changed while an asynchronous
request was being prepared.

Support replies are a deliberately published, customer-visible stream. Private investigation
transcripts, runtime access, files, raw logs, and other operator-only evidence are not projected
into the customer conversation.
