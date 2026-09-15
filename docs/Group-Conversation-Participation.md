# Group Conversation Participation

This document defines how Octo participates when a conversation contains more than one human. Octo is presented as a peer participant, but it should contribute selectively so a shared chat still feels like a human conversation.

There is one participation behavior: **the dispatched agent decides**. Every ambient multi-human turn dispatches to every ambient-active agent — the default agent and/or any active custom agents — as an evaluation: each agent runs the pinned participation skill (`.agents/skills/instafy-group-participation/SKILL.md`) as its first act and either answers or declines silently. The controller keeps only a small deterministic gate for the contracts that must never depend on model judgment: explicit addressing, single-human conversations, and the mechanical arithmetic answer-race machinery.

## Mental model

- In a one-human conversation with Octo, an ordinary message is normally directed to Octo.
- In a group conversation, the current turn is evaluated by the dispatched agent itself, with the shared conversation as context, to decide whether Octo is the useful responder.
- `@octo`, a reply to Octo, or an explicit **Ask Octo** action always directs the turn to Octo.
- Selective participation is not a hierarchy. Human and Octo messages use the same participant-level layout, identity, ordering, and reply model.
- Human labels are resolved from the conversation-scoped participant list. A project guest may see the display names of people in that conversation, but this must not grant access to or depend on the broader organization directory.
- A newly arrived participant in a known multi-human conversation with AI disabled should land directly in the human transcript and composer, without the large **Choose your AI** first-run card. Single-user and AI-enabled entry points keep the two deliberate AI choices when that user has no settled personal AI connection; `@octo` remains the explicit route into credential setup.
- All clients in one conversation must observe the same routing outcome for each submitted turn. **Chat without AI** is an explicit sender-only override because routing preferences are stored per user: it prevents that sender's ordinary turn from invoking Octo, but it does not disable Octo conversation-wide or change another participant's routing preference. The recorded turn and any resulting Octo response still sync consistently to every participant.

## The agent-evaluated contract

There is no pre-dispatch participation judgment for ambient turns. The controller dispatches every ambient multi-human turn to every ambient-active agent (default and/or custom), stamping server-authored marker metadata `groupParticipation = {decision: "agent_evaluation", reason: "skill_mode_ambient", enforcedBy: "runtime-controller"}` on each evaluation job so downstream consumers (billing, UI, sentinel handling) can recognize the run. Each dispatched agent reads the pinned participation skill before any tool use or drafting and either:

- answers (or claims/corrects) normally — from the first visible output onward the run bills and presents exactly like any other Octo turn; or
- declines by emitting exactly `NO_RESPONSE` as its entire reply. The controller swallows the sentinel: the message is never persisted, never rendered on any client, and the job records as a normal success. No credit is burned, no prompt is counted, and no Octo activity was ever shown.

The sentinel is only honored as the agent's first and only conversational output — both the streamed-message path and the completion-summary path swallow it. Once the agent has produced visible output it is committed to a real answer, and a direct address (`@octo`, reply to Octo, **Ask Octo**) is never eligible for the sentinel. Deciding is required to be cheap: the skill forbids opening files or running tools just to decide whether to speak.

**Multiple AI participants behave as selective peers.** When more than one agent is active in the conversation, every ambient turn dispatches one evaluation job per agent, each with the same server-stamped marker. Each agent's delivered turn addresses it by its own identity and lists the other AI participants (handle plus description when available), so an agent whose turn is clearly better suited to a listed peer declines and lets that peer take it — a multi-AI room does not answer in chorus. An explicit mention of one agent (`@octo` or a verified `@custom-agent`) stays a direct dispatch to that agent only, with no evaluation marker, and a custom agent's `NO_RESPONSE` decline is swallowed and recorded exactly like the default agent's.

**Billing is free-until-spoken.** For ambient evaluations, managed-AI prompt counting and credit burn are deferred until the first visible assistant message lands, so a declined turn debits nothing. The deferral applies to managed-AI evaluation jobs; a custom agent evaluating on its own connected credential (BYOC) has no flat platform burn to defer — its upstream usage is inherently the user's own. Direct addresses and single-human conversations bill exactly as before.

**Presence is silent-until-speaking.** No thinking/typing indicator and no agent-owned activity row appears for a run that may end in a swallowed `NO_RESPONSE` — for any viewer, including the sender. Full lifecycle presentation begins when the turn was direct or once the run starts streaming visible content.

Historic conversations may still carry classifier-era `groupParticipation` decisions (including controller-enforced `silent` markers) recorded before the pre-dispatch classifier was removed. The controller keeps reading those markers so idempotent retries of historic messages continue to resolve as the human-only result they originally produced; the skill treats them as conversation history, not instructions.

## The deterministic controller gate

The controller decides only what must stay mechanical:

- **Explicit addressing.** `@octo` mention parsing, the explicit **Ask Octo** flag, and reply-target resolution (reply to Octo vs. reply to a human) are resolved deterministically. An explicit Octo address dispatches immediately with full presence and normal billing; it never routes through ambient evaluation.
- **Single-human conversations.** Participant counting is deterministic, and every turn in a single-human conversation dispatches normally.
- **The arithmetic answer-race.** Simple arithmetic equality and follow-up verification are mechanical, so the human-answer coverage machinery lives in the controller: a verifiably incorrect arithmetic answer dispatches a correction with decision `correct`, and a correct human answer suppresses or cancels a redundant pending Octo answer.

The answer-race guarantee in detail: if one human asks `1+1?` and another answers `1+1=2` while Octo is queued or working, the controller cancels that exact default-Octo job only when no correct Octo answer has already been persisted. The cancellation path locks the same job row used by `/agent/message`, then rechecks controller-authored delivered answers, so a message-first/job-still-leased race cannot cancel an answer that is already visible and a human-authored assistant-shaped row cannot count as Octo coverage. `1+1=3` is recorded while the already-active Octo answer is allowed to correct it. Before suppressing a replacement correction, the controller locks and revalidates the original job: queued/leased still waits, completed is reused only when persisted controller-authored assistant output mechanically verifies as correct, and failed, canceled, expired, or completed-without-a-correct-answer dispatches one correction. A retry with the same client message id returns the controller-enforced human-only result directly only for the same authenticated author, role, and content; collisions return conflict, and untrusted record-only writes cannot forge the marker. The controller does not pretend it can verify arbitrary factual prose without a model call, so verification stays scoped to simple arithmetic.

If the client-side participation preflight request fails or times out, the normal message endpoint remains the authoritative backstop: the turn defers to controller dispatch, keeps the normal server send-queue ordering when Octo is busy, and the server applies the same gate. Only a correlated human-answer coverage action bypasses that queue, because it must atomically cancel or defer to the exact active Octo job, or reuse the exact answer when that job completed at the boundary.

Reserved metadata is stripped on both the record and dispatch endpoints: a project writer cannot forge controller-enforced `groupParticipation`, runtime, or custom-agent metadata, including through nested metadata. Record-then-dispatch with the same client message id reuses the recorded row instead of duplicating it.

## Authorization and delivery guarantees

Participation controls who speaks, not what is authorized. Project permissions, provider access, credit checks, confirmation requirements, and destructive or external-action safeguards remain enforced in code. Ambient participation may answer or inspect, but ambiguous, destructive, security-sensitive, billing, deployment, or externally visible mutations still require clear human intent.

Chat must never fail to deliver. Recording the human message never blocks on AI gates, and the ambient evaluation itself is free, so a collaborator without AI credentials or usable AI balance can always send an ordinary group turn. When a turn would need managed AI but managed AI is hard-disabled and the sender has no credential, the message is recorded and delivered without dispatch (the record-only fallback). Explicit `@octo`, replies to Octo, browser commands, and custom-agent targets keep their normal synchronous credential and credit gates.

## Default policy

The policy below is what the participation skill implements; the deterministic gate enforces only the explicit-address, single-human, and arithmetic rows. "Stay silent" means a dispatched agent whose entire reply is the swallowed `NO_RESPONSE` sentinel — the humans see nothing from Octo and nothing is billed.

| Turn | Octo behavior |
| --- | --- |
| `@octo`, reply to Octo, or **Ask Octo** | Respond immediately. |
| Open factual question | Respond immediately; do not add an artificial waiting period. |
| Open technical question | Respond immediately. |
| Clearly open technical investigation or task | Claim or begin the bounded work immediately, subject to normal permissions and confirmation rules. |
| Product preference, approval, prioritization, or interpersonal discussion | Stay silent unless invited. |
| Message addressed to a named human | Stay silent. |
| Human provides a correct and sufficient answer | Stay out; the controller additionally suppresses or cancels a redundant pending Octo answer when correctness is mechanically verifiable. |
| Human provides a materially wrong factual or technical answer | Correct it briefly only when confident and useful; the controller dispatches the correction mechanically when the arithmetic is verifiable. |
| Joke, rhetorical statement, or uncertain disagreement | Stay silent rather than policing the conversation. |
| Imminent destructive, security, privacy, or safety mistake | A short warning is allowed; taking action still requires authorization. |

Ambiguous turns stay silent; a human can always remove the ambiguity with `@octo`.

## Runtime and presentation contract

The verified selected agent owns its entire lifecycle presentation; this is normally Octo:

1. The human message appears with the human sender's identity.
2. If the agent participates and a runtime is needed, one agent-owned activity row appears, for example **Octo · Starting its workspace…**. A ready runtime waiting behind another turn instead says **Octo · Waiting for its turn…**; a brief indeterminate handoff may say **Octo · Getting ready…**.
3. The activity transitions in place to thinking/working and then to the agent's answer.
4. If startup or execution genuinely fails, the same agent-owned area becomes a compact actionable failure.

Ambient runs are silent-until-speaking: the lifecycle presentation above begins only when the turn was direct (`@octo`, reply to Octo, **Ask Octo**) or once the run has started streaming visible content.

Command status shows an agent handle when needed to identify who is acting. It omits a duplicate handle when the same agent is already named by the current row's visible header, and keeps it for a different actor or a row without a visible author. When a workflow's author header appears only on mobile, the matching command handle remains visible on desktop.

Normal provisioning must not create a standalone controller-style **Runtime** pseudo-message between the human turn and Octo's avatar. Do not show both a runtime warning and a separate **Starting…** row for the same state. A queued request that will continue automatically must not tell the user to “try again,” because resubmission can create duplicate work.

A terminal failure may offer actions such as **Try again** or **Open Runtime & AI**, but its ownership must remain visually attached to the verified selected agent. A custom-agent failure must never be labeled Octo, and a legacy controller notice without verified agent metadata remains neutral. Controller notices are reserved provenance: human-authored record-only messages cannot claim controller runtime/cancellation metadata or custom-agent ownership, including through nested metadata. Electron, browser, Android, and iPhone clients must render the same lifecycle in the same transcript order.

## Scenario matrix

The matrix asserts user-observable outcomes. For "stays silent" rows the invariant is: no visible Octo output, no thinking indicator, and no AI debit — the turn dispatches an evaluation run whose swallowed `NO_RESPONSE` never renders and never bills.

| Scenario | Expected outcome | Observable checks |
| --- | --- | --- |
| One human asks `What is 1+1?` | Octo answers `2` immediately. | One dispatch and one Octo answer. |
| Two humans; one asks `What is 1+1?` | Octo answers immediately. | Both humans see the same single answer. |
| Two humans; one asks an open factual or technical question (`Who won the match?`, `Why is the login redirect looping?`) | Octo answers or claims immediately. | One dispatch, one visible answer, no artificial delay. |
| Two humans; one addresses the other (`Taylor, why is the build failing?`, `Did Sarah approve the release?`) | Octo stays silent. | No visible Octo output, no typing indicator, no debit. |
| Two humans discuss `Should the button be blue or green?` | Octo stays silent unless explicitly invited. | No visible Octo output. |
| A message includes `@octo` while ambient turns are otherwise declined | Octo responds. | Explicit address dispatches immediately with full presence. |
| An owner or invitee opens an empty human-only shared conversation before the peer has opened it | The human chat stays primary. | No **Choose your AI** card, including while participants, project peers, or an authorized org directory load; direct-project guests do not enumerate that directory; `@octo` still invokes setup if AI is not connected. |
| A project-only guest starts in Personal space | The shared project remains discoverable. | The space switcher lists the permission-filtered project without requiring organization or member-directory enumeration. |
| A fresh collaborator without AI credentials sends an ordinary human-directed group turn while Octo is the default | The human message records; Octo produces no visible output. | Send is usable and no AI setup/credit blocker or debit appears — the ambient evaluation is free. |
| Human A selects **Chat without AI** while Human B keeps Octo enabled | Routing remains per sender. | A factual turn from A records without dispatch; the equivalent turn from B invokes Octo once. |
| Human A asks `What is 1+1?` and Human B supplies `1+1=2` first | Octo avoids a redundant final response. | One useful answer total; no stale Octo activity. |
| Human A asks `What is 1+1?` and Human B answers `1+1=3` while the original Octo job is active or crosses a terminal boundary | An active original answer supplies the correction; completed is reused only with verified correct controller output; failed/canceled/expired or incomplete completion dispatches a replacement. | One useful correct Octo answer is visible on every client; no stale active read suppresses the replacement. |
| A qualifying technical turn arrives while the runtime is cold | The turn queues and continues automatically. | One Octo-owned startup state; no standalone Runtime card or duplicate request prompt. |
| Participation preflight is unavailable while Octo is busy | Preserve normal same-agent ordering. | The turn defers to controller dispatch through the server queue; no overlapping Octo job is leased. |
| Runtime startup reaches a terminal failure | The verified selected agent shows an actionable failure. | Failure replaces Starting; custom-agent identity is preserved, unverified legacy notices stay neutral, and the visible **Runtime** button by the composer opens the **Runtime & AI** menu directly onto a usable repair control. |
| A project writer forges controller/runtime/custom-agent metadata in a record-only message | The content remains an ordinary untrusted assistant entry. | Reserved fields are stripped recursively; it cannot render a controller warning/cancellation card or claim a selected-agent identity. |
| Electron, Android, and iPhone show the same group conversation | Routing and ordering agree across clients. | One copy of each message, stable participant identity, usable scrolling, keyboard avoidance, and safe-area padding. |

## Test strategy

Use complementary layers:

1. Table-driven skill/contract tests cover every transcript in the scenario matrix deterministically.
2. Controller tests cover the deterministic gate (explicit addressing, reply targets, single-human dispatch), exact job/run correlation, sentinel swallowing, and the guarded state transition used to cancel or reuse an arithmetic answer. The database-backed `group_participation_job_lock_fences_human_octo_answer_races` regression proves human-first cancellation, Octo-first delivery winning the same job-row lock, and terminal revalidation. A completed job is reused only with a correct controller-authored answer; completed-without-answer, completed-with-wrong-or-human-authored output, failed, canceled, and expired jobs release the turn for one replacement correction. Live cross-client timing across the active/completed boundary remains a release check because the database test does not exercise transport or rendering.
3. Two-user Playwright tests verify the shared transcript, participant identity, typing state, and one-copy delivery.
4. A real-model smoke verifies one open factual turn, one open technical turn, one human-directed silent turn, and one explicit `@octo` turn.
5. Physical-device sign-off verifies Electron, Android, and iPhone layout, keyboard, scrolling, safe areas, and Octo-owned runtime lifecycle. Native evidence is valid only after proving the client loaded the current embedded/test bundle rather than a retained production OTA bundle.

Live-model tests are useful integration evidence, but they are not the only policy gate: the mechanical contracts (explicit address, reply targets, arithmetic coverage) must also have deterministic fixtures.

## Existing footholds

- `packages/frontend/tests/playwright/orgs/org-invite-link-conversation-tabs-ai.spec.ts` already puts an owner and a distinct guest in one public chat and verifies an unmentioned factual question plus shared Octo reply.
- `packages/frontend/tests/playwright/orgs/org-multi-user-chat.spec.ts` verifies two real users can continue one AI conversation.
- `packages/frontend/tests/playwright/orgs/org-multi-user-typing-indicator.spec.ts` verifies human typing presence.
- `packages/frontend/tests/playwright/smoke/chat-assistant-toggle.spec.ts` distinguishes human-only recording from assistant dispatch and verifies `@octo` override.
- `packages/runtime-controller/src/tests.rs` includes `group_participation_job_lock_fences_human_octo_answer_races`, which holds the exact Octo job lock while competing cancellation, delivery, and terminal revalidation paths cross it.
- Single-account cross-client smoke coverage verifies browser/Electron transport only; it is not proof of multi-human participation.
- `packages/frontend/scripts/tri-client-local-camera-smoke.mjs` provides Electron and Android WebView control plus device screenshots. Its physical iPhone lane is currently Camera/XCTest-oriented, so the full three-client group-chat check remains a manual release step.

See `docs/Testing.md` for the cross-client operator procedure and `docs/Multi-Agent-Evaluation.md` for routing after Octo has been selected to participate.
