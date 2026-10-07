---
name: instafy-space-review
description: Review accessible recent chats and start at most one useful private Octo conversation with grounded context and a natural next step. Use for an opted-in space review automation or “review this space”; it never carries out the suggested work.
---

# Review this space

Find one useful reason to start a private conversation with the person who requested this review. Read bounded context and submit a grounded opener through the recommendations CLI. The controller delivers it as a normal Octo chat; the person can reply there. The review itself never carries out the work. Preserve any earlier request and its limits when describing how to continue in that ordinary chat.

If the person is replying to an existing suggestion with “don't remind me,” “remind me tonight,” “let's do this weekend,” or a change to check-in frequency, use `instafy-automations` to save that preference instead of starting another review. Explicit conversational feedback is different from inferring a choice during a background review.

For a direct request to start recurring space reviews, use `instafy-automations`. If they also ask to review now, create or update the schedule and trigger its managed run through that skill; do not conduct a second review in the setup chat. The restrictions below apply while executing a review, not to a separate explicit scheduling request.

For a general getting-started question with no stated goal and no request to inspect existing work, ask one short question about what the person wants to build or solve in the current chat. Do not audit chat history just to ask that question or claim the space is empty without evidence. An explicit request to review existing work still follows the grounded review below.

## Read a bounded slice

Use the existing scoped CLI session; do not request credentials or try another account to expand access.

1. Read prior decisions first:
   `instafy recommendations list --limit 200 --json`
2. Read this chat:
   `instafy conversation show --limit 20 --transcript --json`
3. If the request needs wider context, list at most 12 accessible chats:
   `instafy conversation list --limit 12 --include-threads --json`
   Inspect at most three relevant chats with `instafy conversation show <conversation-id> --limit 20 --transcript --json`. Optional context cards can guide selection with `instafy agents context list --limit 10 --json`; verify their claims in the original chat before recommending work.

Use the transcript view for source evidence; raw runtime events and tool metadata can hide the actual messages in a truncated response. If an older CLI explicitly rejects `--transcript` as unknown, retry without that flag and treat any truncated output as incomplete evidence.

These commands default to the current space. Keep any explicit `--space` equal to that space. The controller decides which conversations and recommendations this runtime job can access: shared space chats and its own private conversation tree, not unrelated private chats even if the person can open them. Describe the review accordingly; never claim full private-chat coverage. A denied or missing chat is not evidence that no work exists. Do not use user-only `conversation grep` or `context` from a scoped runtime job, inspect other spaces, or scan an entire workspace to compensate for missing access. Read a small relevant local file only when the request or accessible discussion points to it.

If listing prior recommendations fails, explain the limitation and stop before submitting: you cannot reliably respect earlier choices. Otherwise, distinguish what you saw from what you inferred, and say the review covers accessible recent context rather than claiming an exhaustive audit.

## Choose zero or one useful conversation

- Prefer unfinished work with a specific useful outcome, an unresolved decision, or a blocker that the person can move forward now. Skip generic maintenance, imagined bugs and work already completed in the evidence.
- Choose the strongest finding, not a batch of reminders. Read `delivered` and the `accepted` and `dismissed` statuses first. Do not submit that work again under a new key or paraphrase. A dismissed topic stays dismissed; a postponed topic is handled by its saved reminder, not a new review finding. Delivery remains recorded if its chat is archived or deleted; neither absence nor an unreadable private follow-up means the work should be raised again. A chosen action may still be an unsent draft: do not infer execution or completion.
- Apply previous choices to every human-facing message too. Do not invite reconsideration of declined work or offer already-raised work again unless the person explicitly asks to revisit that specific item. Another review does not reopen earlier choices.
- A recommendation needs at least one accessible conversation reference that actually supports it. Prefer an exact message ID when returned by the CLI. Never invent identifiers or use the review request itself as evidence for a supposed project problem.
- Keep the identity and stage of each deliverable separate. A guide draft being ready does not mean a follow-up message draft exists. If the source says the guide is ready and asks to prepare a follow-up for review, acknowledge that request and point to drafting the follow-up next; do not claim an existing follow-up is ready to review or send. Likewise, requested, drafted, reviewed, approved and sent are different states. Resolve pronouns against their actual source and preserve uncertainty when the evidence does not establish a state.
- Zero findings is a valid result. For a quiet automation, missing context means no new chat. When a person directly asks in an ordinary chat and the space is empty, ask one short starter question there instead of persisting a fabricated finding.

## Write the opener and submit once

Write a short title and a concise `message`: one concrete observation grounded in the sources, followed by a natural next step. If the person already asked for the work, acknowledge that request and describe where to pick it up; do not ask them to authorize the same task again as though it were a new suggestion. For example, say “You asked for a follow-up draft. We can pick that up here,” rather than “Would you like me to draft a follow-up?” Ask one useful question when there is a genuinely new proposal or a missing decision needed to continue. Do not force a question onto an existing request.

Keep the review quiet and non-executing: describe the continuation without claiming you are doing it or have finished it. Preserve the original scope and limits, such as preparing a draft for review without sending it. The person can continue in the delivered ordinary chat; do not send them through another approval flow. Address them naturally, explain timeliness only when supported, and keep review mechanics and internal status labels out of the opener. The controller appends validated source links, so do not add raw IDs or invented links.

The required `reason` records the grounding, and `prompt` describes the suggested work without executing it. Neither replaces `message`. Pass one JSON object through stdin so the review does not edit workspace files. Use a quoted heredoc to preserve the proposal as data, including literal shell characters:

```bash
instafy recommendations submit --file - --json <<'RECOMMENDATION_JSON'
{
  "key": "draft-pilot-follow-up",
  "title": "Pilot follow-up",
  "reason": "The guide draft is ready, and the user asked for a follow-up draft to review before sending. The sources do not establish that the follow-up has been drafted.",
  "prompt": "Draft a short pilot follow-up pointing to the revised onboarding guide and leave it for my review without sending it.",
  "message": "You asked for a pilot follow-up to review before sending. The guide draft is ready, and we can pick up that follow-up here.",
  "evidence": [
    { "conversationId": "<actual conversation UUID>", "messageId": "<actual message UUID>" }
  ]
}
RECOMMENDATION_JSON
```

Replace the example with observed evidence. `messageId` is optional; `conversationId` is required. Use 1–8 references, a lowercase key of at most 120 characters using letters, digits, hyphens or underscores, a title up to 160 characters, reason up to 2,000, and prompt/message each up to 4,000. Prefer a much shorter opener. Include `message` for delivery; omitting it only stores a legacy proposal. Submit at most one finding per review. Store references and concise reasoning, not transcripts or secrets.

Inspect the response. `delivered: true` records delivery and does not prove the person has replied or the work has started. A legacy terminal status preserves an earlier choice. A scoped review may receive `deliveredConversationId: null` for privacy; do not try to bypass that boundary. On an uncertain submission result, list again and match the stable key before retrying once. A delivery-limit response means stop, not invent another key or omit `message` to work around it.

During a review, do not infer or record choices for the person, call chat creation or send commands, dispatch a follow-up job, create an automation, change settings, install tools, edit project files, contact others or execute the proposed action. The only permitted review delivery is the controller's private opener produced by this submission.

For an opted-in quiet space review automation, finish with exactly `NO_RESPONSE` after successful review, whether or not you delivered an opener. Its execution anchor is private internal audit history; the useful message belongs in the delivered chat. Report actual failures instead of hiding them with this sentinel. For a direct request in an ordinary chat, briefly describe the outcome or ask the empty-space starter question. Omit unrelated workspace or Git diagnostics. Do not emit suggested replies; the person can answer Octo in the ordinary conversation.
