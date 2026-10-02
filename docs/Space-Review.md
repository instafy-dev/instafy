# Space review

Space review is an on-demand skill that suggests useful next steps from recent accessible
conversations. It uses the normal chat/runtime/proxy path. It does not create a recurring
automation or start recommended work automatically.

## Studio flow

Open the chat composer's **+ → Space review** action. **Prepare review** stages an editable
request in your private **Space review** chat. Send that request to run it with the usual AI,
runtime, and credit checks. Preparing the draft itself does not dispatch model work.

The controller reuses one owner-only review conversation per person and space. This keeps the
review's own context and prior recommendation outcomes reachable without widening a runtime
job's private-chat permissions. Preparing another review restores an archived or hidden review
chat to active. An unrelated unsent draft in that conversation is preserved.
If the review chat has been shared, the preparation endpoint refuses to reuse it; restore its
private, owner-only access before preparing another review.

The skill reads prior choices, samples recent accessible chats, and saves up to three grounded
recommendations. Each has a title, a reason, an editable action prompt, and one or more source
conversation/message references. Zero findings is a valid result. A new space can receive a
starting question in the chat without a fabricated persisted finding.

Reopen **Space review** after the run to see its proposals. Open a source to inspect the evidence.
**Add to new chat** prepares a separate private draft and remembers the choice as accepted;
send that draft when ready to start. Accepted means chosen, not executed or completed. A failed
outcome save can be retried without preparing another draft, including after closing and reopening
the panel. The controller retains the prepared chat's identity; edited local drafts are preserved.
**Dismiss** remembers that the
proposal should not be shown again. Existing chat drafts are left intact.

## Visibility and authority

- Recommendations belong to the requesting user and project; they are not a space-wide feed.
- Human reads require current project access and access to every source conversation.
- Scoped runtime jobs retain their existing boundary: shared chats and their own private
  conversation tree. Other private chats are outside the review, even when the human can open
  them. The skill must state coverage honestly and treat inaccessible history as unknown.
- Runtime reads also check the recommendation's originating conversation. A result from an
  unrelated private review cannot become accessible through the recommendation API.
- Sources are checked on submission and again on retrieval. Revoked access hides the finding.
- Creating proposals requires project write access. Accepting or dismissing requires a human
  session with write access; a skill cannot accept its own recommendation.
- Preparation creates or reuses a private review conversation without dispatching a run.
  Recommended actions and archive suggestions remain proposals until the human chooses work.

The skill's instruction to review without modifying the project is behavioral guidance for a
normal user-requested chat turn. This feature does not introduce a new read-only runtime sandbox
or change the existing automation execution-mode contract.

## Contract

The controller exposes:

- `GET /projects/:projectId/recommendations`: accessible recommendations, including accepted
  and dismissed outcomes for the next review.
- `POST /projects/:projectId/recommendations`: upsert one proposal with `key`, `title`, `reason`,
  `prompt`, and `evidence` (`conversationId` plus optional `messageId`).
- `PATCH /projects/:projectId/recommendations/:id`: human outcome `accepted` or `dismissed`,
  with optional `acceptedConversationId` for a prepared follow-up.
- `POST /projects/:projectId/recommendations/review-conversation`: get or create the caller's
  dedicated private review chat; returns `conversationId`.
- `POST /projects/:projectId/recommendations/:id/prepare-conversation`: get or create the
  caller's private draft chat for a proposed recommendation. This human-only operation remembers
  the draft identity without changing the recommendation's status or dispatching a run.

The stable key is unique within user and project scope. Upserting an accepted or dismissed key
does not reopen it or replace its content. The reviewer must reuse keys for the same proposed
work, recognize completed work from current evidence, and avoid inventing a new key merely to
resurface a declined suggestion. Deduplication by key is enforced; semantic quality remains the
skill's responsibility.

The additive migration is `20261002120000_space_recommendations.sql`. Apply it to the target
environment before deploying the controller. The frontend, bundled runtime skill, and CLI commands
also need this version for the complete flow. The migration does not rewrite existing conversation
or automation records.

See [CLI](CLI.md) for `instafy recommendations list` and `submit`, and
[Automations](Automations.md) for existing scheduling. Adaptive triggers, automatic archival,
shared team recommendations, and explicit grants for cross-private-chat review are outside this
first version.
