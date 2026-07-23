# Integration onboarding (action-card contract)

Goal: make integration workflows proactively guide setup instead of failing silently.

## Capability preflight

Before claiming success on integration work:
- Identify the provider and requested capability (examples: repo clone, issues read, send message, fetch channel list).
- If auth/scope is missing or uncertain, return an onboarding action first.
- Do not ask users to paste tokens in chat.

## Required action types

Use these actions in the JSON response:

- `request_integration`
  - `provider`: provider id (a short string that identifies the integration)
  - optional `description`, `requiredScopes`, `capabilities`, `authMethods`, `suggestedSecretNames`, `suggestedSecrets`, `agentHandles`
- `request_secret`
  - `name`: env var (UPPER_SNAKE_CASE)
  - optional `description`, `agentHandles`

Use `request_integration` for account connection/scope onboarding.
Use `request_secret` for project runtime tokens/webhooks.

## Keep action cards small

- Treat action-card `description` fields as one-line hints (not documentation).
- Do not put multi-step instructions in action cards.
- Put detailed setup steps (where to click, where to find/generate tokens, required permissions/scopes, verification) in the follow-up `summary` message instead.

### Secret copy

When emitting `request_secret` (or `request_integration.suggestedSecrets[]`), include a short `description` whenever possible:
- What the value is (token/key/webhook URL).
- Optional: a 3-6 word hint about its purpose.

Aim for a short hint (not a sentence). Never ask the user to paste secrets into chat; they should use the secrets form/action card.

## Scope model

Keep these scopes distinct:
- User credential scope: user-owned identity/session used to connect providers.
- Project integration scope: per-project provider connection state + scopes/capabilities.
- Project secret scope: per-project runtime env vars for agent execution.

Do not collapse OAuth credentials into space secrets by default.

## Failure recovery rule

If commands or APIs fail with auth/permission errors (401/403/unauthorized/permission denied/missing token):
- Return the most relevant onboarding action(s) in the same response.
- Ask the user to confirm when done, then retry.

## Follow-up UX

After onboarding completes, suggest one concrete retry prompt so the user can continue immediately.
- Provide exactly one retry phrase. Don’t add an alternate “then reply …” phrase.
- If you include suggestion chips, include exactly one and it must equal the retry phrase (otherwise omit).
