---
name: instafy-space-review
description: Review the current Instafy space when asked and propose a few grounded next actions from accessible recent chats and prior recommendations. Use for “review this space” or “what should I do next here”; it does not run continuously or carry out the proposed work.
---

# Review this space

Find useful next actions for the person who requested this review. Work inside this normal chat turn. Reading the space and submitting recommendations are the scope of the review; acting on them requires the person to choose one.

## Read a bounded slice

Use the existing scoped CLI session; do not request credentials or try another account to expand access.

1. Read prior decisions first:
   `instafy recommendations list --limit 200 --json`
2. Read this chat:
   `instafy conversation show --limit 20 --json`
3. If the request needs wider context, list at most 12 accessible chats:
   `instafy conversation list --limit 12 --include-threads --json`
   Inspect at most three relevant chats with `instafy conversation show <conversation-id> --limit 20 --json`. Optional context cards can guide selection with `instafy agents context list --limit 10 --json`; verify their claims in the original chat before recommending work.

These commands default to the current space. Keep any explicit `--space` equal to that space. The controller decides which conversations and recommendations this runtime job can access: shared space chats and its own private conversation tree, not unrelated private chats even if the person can open them. Describe the review accordingly; never claim full private-chat coverage. A denied or missing chat is not evidence that no work exists. Do not use user-only `conversation grep` or `context` from a scoped runtime job, inspect other spaces, or scan an entire workspace to compensate for missing access. Read a small relevant local file only when the request or accessible discussion points to it.

If listing prior recommendations fails, explain the limitation and stop before submitting: you cannot reliably respect earlier choices. Otherwise, distinguish what you saw from what you inferred, and say the review covers accessible recent context rather than claiming an exhaustive audit.

## Choose zero to three next actions

- Prefer unfinished work with a specific useful outcome, an unresolved decision, or a blocker that the person can move forward now. Skip generic maintenance, imagined bugs and work already completed in the evidence.
- Read proposed, accepted and dismissed outcomes. Reuse the same stable key for the same action; do not rename or reword accepted or dismissed work to bring it back. Compare meaning as well as keys. An accepted action is already chosen and may still be an unsent draft; do not infer execution or completion and do not submit it again. The controller preserves terminal outcomes on an existing key.
- Apply those earlier choices to the final chat summary and suggested replies too. You may acknowledge an outcome, but do not invite reconsideration of dismissed work or offer accepted work again unless the person explicitly asks to revisit that specific item. A request for another space review does not reopen earlier choices.
- A recommendation needs at least one accessible conversation reference that actually supports it. Prefer an exact message ID when returned by the CLI. Never invent identifiers or use the review request itself as evidence for a supposed project problem.
- Write a short title, explain why the next action matters now, and supply a self-contained prompt the person can choose to send. Preserve the original scope and uncertainty; do not turn a recommendation into authorization for external changes.
- Zero recommendations is a valid result. If the space has no substantive context, put one short, direct starter question in your final chat summary, such as "What would you like to accomplish in this space?" Do not leave that question only in a suggested-reply chip, and do not persist a fabricated finding.

## Submit grounded recommendations

For each selected action, pass one JSON object through stdin so the review does not edit workspace files. Use a quoted heredoc to preserve the proposal as data, including literal shell characters:

```bash
instafy recommendations submit --file - --json <<'RECOMMENDATION_JSON'
{
  "key": "confirm-welcome-copy",
  "title": "Confirm the welcome copy",
  "reason": "The earlier onboarding discussion left the welcome wording undecided.",
  "prompt": "Use our onboarding discussion to propose the final welcome wording and explain the choice.",
  "evidence": [
    { "conversationId": "<actual conversation UUID>", "messageId": "<actual message UUID>" }
  ]
}
RECOMMENDATION_JSON
```

Replace the example with observed evidence. `messageId` is optional; `conversationId` is required. Use 1–8 references, a lowercase key of at most 120 characters using letters, digits, hyphens or underscores, a title up to 160 characters, reason up to 2,000, and prompt up to 4,000. Submit no more than three actions per review. Store references and concise reasoning, not transcripts or secrets.

Inspect each response: an accepted or dismissed result means the earlier decision was kept, not that a new suggestion was created. On an uncertain submission result, list again and match the stable key before retrying once. Report remaining failures plainly. Do not accept/dismiss items on the person's behalf, start another chat or job, create an automation, change settings, install tools, contact others or execute the proposed action as part of this review.

Finish with a concise account of what you found, the recommendations actually saved, and any meaningful limit on the review. Omit unrelated workspace or Git diagnostics. Omit suggested replies when no new action merits one, except for a starter in an empty space. If you include suggested replies, each must be a short user message that makes sense to send as-is and stays under 160 characters; the starter question still belongs in the final chat summary. The person chooses the next action in Studio.
