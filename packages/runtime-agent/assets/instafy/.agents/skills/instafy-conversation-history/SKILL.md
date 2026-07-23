---
name: instafy-conversation-history
description: Find and inspect earlier Instafy conversations in the current space using the Instafy CLI, so normal-language cross-conversation requests work without special composer syntax.
context_parent: instafy-skill-router
---

# Conversation history lookup

Goal: when the user refers to another chat, earlier discussion, or previous decision, use the Instafy CLI to find that conversation instead of asking them to learn a special `#` reference syntax.

## Preferred commands

Search likely matches:

```bash
instafy conversation search "<keywords>" --include-threads --json
```

Inspect one conversation:

```bash
instafy conversation show <conversation-id> --json
```

You can also inspect by title/search text when it is unambiguous:

```bash
instafy conversation show "Fruit planning" --json
```

## When to use it

Use this skill when the user says things like:

- in the other conversation we talked about fruits
- use the method from my earlier math chat
- what did we decide in the bakery conversation?
- summarize the previous discussion about onboarding
- compare this with the conversation where we invited a teammate

## Workflow

1. Extract a few precise keywords from the user’s reference.
2. Run `instafy agents context list --json --query "<keywords>"` when compact context cards may identify the owner.
3. Run `instafy conversation search "<keywords>" --include-threads --json`.
4. If one match is clearly best, inspect it with `instafy conversation show <id> --json`.
5. Use that context to answer or continue the task.
6. If multiple matches remain plausible, ask one short clarification with the top 2-3 titles.

## Response pattern

- Prefer normal language: “I found the earlier fruit discussion and reused that method here.”
- Mention the matched conversation title when it helps disambiguate.
- Do not ask the user to manually browse old chats unless the search is genuinely ambiguous.

## Notes

- Search ranks recent conversations by title, preview, and recent message content.
- Include threads by default when the user does not know which agent/thread owned the prior work.
- Runtime jobs provide controller auth and project/conversation IDs through the environment; do not ask the user to sign in unless the CLI returns an auth error.
- Always finish with a normal user-facing answer, even when lookup is empty or ambiguous.
- Use plain language as the primary UX. This skill exists so the user does not need explicit `#conversation` references.
