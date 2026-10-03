# Space review

Octo can review recent accessible conversations and start one useful private chat with a grounded
observation and a natural next step. The opener acknowledges existing requests and where to
resume them; it asks a question for a new proposal or a missing decision, rather than repeatedly
asking permission for work already requested. The person continues in that ordinary chat.
Delivering the opener does not dispatch a model run or execute the suggested work.
There is no separate review panel or recommendations inbox.

## Opt in and receive a conversation

Create an explicit `space_review` automation using the existing scheduler; see
[Automations](Automations.md#space-review-mode). It uses the normal runtime and Instafy proxy,
with the usual runtime, model access and credit requirements. The mode is private and quiet, and
there can be one such automation per owner and space. Existing prompt automations keep their
behavior. No review schedule is created or enabled automatically.

Each run reads previous recommendations, samples a bounded set of accessible chats and chooses
zero or one useful topic. A finding arrives as a normal private Octo chat: a short opener with a
natural continuation and validated links to its sources. An empty space or a run without a new finding
creates no chat. Execution history remains available through Automations; the internal review
anchor is excluded from ordinary chat discovery and activity.

Studio reconciles cached review anchors through a separate user-session-only conversation list
(`internalOnly=true`, with `rootsOnly=true`), which retains project and private-chat access checks.
Only its controller-derived top-level `internalPurpose` identifies internal records; older servers
that ignore this flag cannot cause ordinary chats to be hidden. This lookup does not depend on a
recent run, so paused reviews and old anchors stay out of ordinary unread and recent-chat views.
Studio also retires cached descendants by their parent relationships, including when the root
itself is no longer cached, while preserving their history for an explicitly opened audit.
Scoped runtime jobs cannot use this discovery flag.

You can also ask for `$instafy-space-review` in an ordinary chat without creating a schedule.
For a direct request with insufficient context, the skill asks a short starter question in that
chat instead of storing an invented finding.

Delivered topics remain recorded when their chats are archived or deleted. Later reviews must
not raise the same work under a new key or paraphrase. Existing accepted and dismissed outcomes
also remain suppressed. Delivery or acceptance does not imply that work was executed or completed.

## Grounding and authority

- Recommendations belong to the requesting user and project; they are not a space-wide feed.
- Human reads require current project access and access to every source conversation.
- Scoped runtime jobs retain their existing boundary: shared chats and their own private
  conversation tree. Other private chats are outside the review, even when the human can open
  them. The skill must state coverage honestly and treat inaccessible history as unknown.
- Runtime reads also check the recommendation's originating conversation. An unrelated private
  review cannot become accessible through this API. Delivered conversation IDs are redacted from
  scoped jobs; delivery is not a grant to inspect the new private chat.
- Sources are checked on submission and retrieval. Revoked access hides the finding.
- Delivered openers show one source chip per distinct evidence conversation, labeled with its
  accessible chat title at delivery time (or **Source chat** when untitled); labels do not update
  after a rename. Chips open the source chat; all original message-level evidence remains stored.
- The opener must distinguish each deliverable and its stage: a guide draft being ready does not
  establish that a requested follow-up message has been drafted, approved or sent.
- Existing requests retain their original scope and limits. A request for a draft to review
  should be acknowledged as unfinished drafting, without re-asking whether to draft it or
  implying permission to send it. The review itself remains non-executing.
- The skill may submit the opener, but cannot execute its suggestion, send external messages,
  modify the project, create schedules or dispatch follow-up jobs.

The instruction to avoid modifying the project is behavioral guidance for a normal runtime turn.
This feature does not introduce an enforced read-only sandbox or change the existing automation
execution-mode contract. The controller enforces private delivery, evidence access, deduplication
and at most one delivery per active run.

## Controller contract and compatibility

- `GET /projects/:projectId/recommendations` returns accessible recommendations including prior
  outcomes and delivery state. Records add `delivered` and `deliveredConversationId`; the latter
  is `null` for scoped review jobs.
- `POST /projects/:projectId/recommendations` accepts `key`, `title`, `reason`, `prompt`,
  `evidence` (`conversationId` plus optional `messageId`) and optional `message`.
- A nonblank `message` of up to 4,000 characters atomically creates a normal private conversation
  with an assistant opener and validated source links. It does not create a follow-up job or
  alter the recommendation's status. Omitting `message` preserves proposal-only behavior.
- The key is unique within user and project. Accepted, dismissed or delivered keys return their
  existing record unchanged, including after a delivered chat is archived or deleted. Retry an
  uncertain submission using the same key. The one-delivery-per-run limit does not permit a
  fallback new key or proposal without a message.
- Existing human-only outcome and draft-preparation endpoints remain for compatibility:
  `PATCH /projects/:projectId/recommendations/:id`,
  `POST /projects/:projectId/recommendations/review-conversation`, and
  `POST /projects/:projectId/recommendations/:id/prepare-conversation`.

Apply the ordered additive migrations before the controller rollout, including
`20261002120000_space_recommendations.sql` and
`20261002121000_recommendation_conversation_delivery.sql`, followed by
`20261002122000_quiet_space_review_automations.sql` and
`20261002181040_quiet_space_review_conversations.sql`. Automation and conversation changes
commit separately to preserve the migration lock-order boundary. Deploy the matching bundled runtime
skill and CLI for conversation delivery. Existing runtime workspaces upgrade exact recognized
previous bundled review skills, including the prior quiet-review template; customized copies
are preserved and need a deliberate local update.
See [CLI](CLI.md#space-reviews-and-recommendations).
Semantic deduplication and the usefulness of a question still require review; stable-key
idempotency alone does not establish quality.

## Live quality check

The opt-in runtime integration test `space_review_live` runs the actual job processor, bundled
skill and built CLI against a disposable local controller. All model requests pass through a local
Instafy proxy. The proxy owns the upstream access token; the runtime receives only a dummy proxy
key and its scoped controller job token. The probe does not refresh the operator's login.

Prepare a migrated isolated PostgreSQL database and controller, synthetic source conversations,
and an active leased job in the owner's private review anchor. Write a private (`0600`) JSON
manifest outside the runtime workspace with `controllerUrl` (literal
`http://127.0.0.1:<port>`), `runtimeId`, the complete `LeaseJob` as `job`, and expected
`minimumNew`/`maximumNew` and `minimumDelivered`/`maximumDelivered` counts. Defaults are zero
minimum and one maximum. Delivery counts include an existing legacy proposal delivered for the
first time. The signed token must match the user, project, runtime lease, run and active database
job. The fixture owner creates and cleans up this data; the probe never seeds a hosted database
or grants wider access.

Build the exact checkout's CLI, then run the ignored test explicitly in a process with a clean
environment and disposable home directory:

```bash
pnpm --filter @instafy/cli build
RUN_LIVE_SPACE_REVIEW=1 \
SPACE_REVIEW_LIVE_FIXTURE=/absolute/private/fixture.json \
SPACE_REVIEW_LIVE_REPORT=/absolute/private/new-report.json \
SPACE_REVIEW_LIVE_NODE=/absolute/path/to/node \
SPACE_REVIEW_LIVE_PROXY_AUTH_PATH=/absolute/private/proxy-auth.json \
cargo test --manifest-path packages/runtime-agent/Cargo.toml --locked \
  --test space_review_live -- --ignored --nocapture
```

The report is created with mode `0600`; reuse is refused. It includes model output,
recommendations before and after, and a workspace file inventory, with supplied tokens redacted.
The default model is `gpt-5.5`; `SPACE_REVIEW_LIVE_MODEL` selects another supported model.
Code-mode-only models need the matching host described in [Developer setup](../DEV_SETUP.md).

Check an empty space, active unfinished work beside completed distractions, and stale unresolved
decisions. Include the grounding regression: a guide is ready, no pilot follow-up has been sent,
and the person requests a follow-up draft for review. The opener should acknowledge the request
and a natural way to resume it, without re-asking permission or claiming that a follow-up draft
already exists. Repeat a review after delivery,
archive/deletion and legacy accepted/dismissed choices; none should resurface.

The probe requires a completed model turn with positive token usage, checks count bounds, verifies
unchanged delivered and terminal records, rejects exposed private delivery IDs and requires no
suggested-reply chips. It calls the job processor directly and does not exercise the full lease
completion path. A human-session readback or controller integration test must also verify the
actual opener, source links, privacy, absence of follow-up jobs and normal chat reply behavior.
Test a short reply such as “yes” both when the opener includes the task details and when needed
details appear only in its linked source. Confirm that continuation uses those details without
asking the person to repeat the request, and respects the original limits on actions such as
sending a draft. Ordinary replies use observed chat titles and native source links; the shared
runtime response contract keeps raw source UUIDs out of visible prose unless the person requests
technical identifiers. This guidance also reaches existing provider threads on their next turn,
without changing workspace skills. A successful reply using a detailed opener alone does not
prove source lookup.
Manually inspect grounding, semantic duplicates and absence of unrequested actions; counts alone
do not prove quality. Missing prerequisites fail an explicit live run; ordinary tests report it
as ignored.
