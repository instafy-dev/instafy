---
name: instafy-integration-onboarding
description: Action-card policy for integration setup and consent-first onboarding.
routing_keywords: token, api key, secret, connection, portal, dashboard, developer, walk me through, set up, integration, connect
---

# Integration onboarding (action-card contract)

Goal: make provider workflows (GitHub, Slack, WhatsApp, etc.) proactively guide setup instead of failing silently.

## Capability preflight

Before claiming success on provider work:
- Identify the provider and requested capability (examples: repo clone, issues read, Slack post, WhatsApp send).
- If auth/scope is missing or uncertain, return an onboarding action first.
- Do not ask users to paste tokens in chat.

## Automation strategy (API-first)

If the user asks for repeated/automated actions against a third-party service:
- Prefer official API/integration flows first (more reliable and auditable).
- Use browser automation only for one-off setup/recovery flows, or when no viable API exists.
- If both are possible, explain the API option first and ask which path the user wants.

For high-risk domains (finance, payments, account/security settings):
- Require explicit confirmation before executing impactful actions.
- Summarize the exact action before execution (target account, amount/change, and expected outcome).

## Required action types

Use these actions in the JSON response:

- `request_integration`
  - `provider`: provider id (for example `github`, `slack`, `whatsapp`)
  - optional `description`, `requiredScopes`, `capabilities`, `authMethods`, `suggestedSecretNames`, `suggestedSecrets`, `agentHandles`
- `request_secret`
  - `name`: env var (for example `GITHUB_TOKEN`)
  - optional `valueLabel`, `description`, `whereToGet`, `sensitive`, `skill`, `agentHandles`; a skill setup says how to fill each
- `request_browser`
  - `task`: the user's browsing request, written as their own message
  - optional `browserLocation`: `auto` unless the user named this device or the Workspace

Use `request_integration` for account connection/scope onboarding.
Use `request_secret` for project runtime tokens/webhooks.
Use `request_browser` to offer Instafy's browser when no browser tools are on this turn.

### Keep cards small

- Treat action-card `description` fields as one-line hints (not documentation).
- Put detailed setup steps (where to find tokens, what to click, how to verify) in the `summary` text.
- Keep `requiredScopes`/`capabilities` short; only include items you are confident are needed.
- In `summary`, include a short numbered checklist for where to obtain credentials. If you don’t know the exact provider UI path, include a precise search phrase the user can copy and ask exactly one clarifying question.

## Scope model

Keep these scopes distinct:
- User credential scope: user-owned identity/session used to connect providers.
- Project integration scope: per-project provider connection state + scopes/capabilities.
- Project secret scope: per-project runtime env vars for agent execution.

Do not collapse OAuth credentials into project secrets by default.

## Failure recovery rule

If commands or APIs fail with auth/permission errors (401/403/unauthorized/permission denied/missing token):
- Return the most relevant onboarding action(s) in the same response.
- Ask the user to confirm when done, then retry.

## GitHub repo onboarding

Treat requests like these as direct repo-onboarding intents:
- "continue working on my project https://github.com/org/repo"
- "import this repo"
- "open this GitHub project"

Default behavior:
1. Treat the current space as the target workspace.
2. Continue with repo import instead of sending the user through a separate onboarding script.
3. Keep follow-up questions to a minimum. Only ask about branch or subfolder when the repo is clearly large/ambiguous or the user asked for a specific slice.

For private or access-restricted repos:
- If auth is missing or uncertain, emit `request_integration` for `github`.
- Include only the scopes/capabilities you are confident are needed for the next step (for repo import this is usually `repo` / `repo.read`).
- After connection completes, provide exactly one retry phrase that resumes the same repo request.

Avoid product bloat:
- Do not invent a bespoke multi-step onboarding checklist when the user already gave the repo intent in chat.
- Prefer one direct retry phrase over multiple variants.
- Use the dedicated onboarding UI only as a shortcut surface; the real contract is that the chat intent should work.
- Do not silently redirect the user into a different space just because the same repo might exist elsewhere. Spaces are isolation boundaries.

## Follow-up UX

After onboarding completes, suggest one concrete retry prompt so the user can continue immediately.
- Provide exactly one retry phrase. Don’t add an alternate “then reply …” phrase.
- If you include suggestion chips, include exactly one and it must equal the retry phrase (otherwise omit).

## Consent-first browser guidance

When provider setup needs dashboard/login interaction:
- Ask before opening a live browser session, and offer it once per setup. With browser tools on this turn, ask in one sentence and wait for a yes. Without them, emit one `request_browser` action after any `request_secret` cards: its button is the user's yes, and its `task` is sent as the user's own message, so write it as their request.
- Open only an address a skill declares or the user gave you, and walk the screens the declaration names, in order. Never guess a provider address. When a skill declares more than one (such as live and demo) and the user has not chosen, offer only after they have.
- If the user agrees, guide step-by-step and pause for user-only actions (login, MFA, consent) with `request_human_input` on their fields, so the user completes them on the page and chooses Let AI continue. Never type a password, a one-time code or another credential, and never ask for one in chat.
- Stop on the screen that lists a secret value (an API secret, token or key), such as the list whose row opens it. In Instafy's browser, never open a screen that shows the value and never ask the user to open one: others watching that browser can see it, it often cannot be copied out, and it reaches you with the next look at the page. Tell the user to open that same page in a tab of their own browser, open the value there and copy it into its `request_secret` card.
- If the user declines or ignores the offer, provide manual steps only.
