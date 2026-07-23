# Secrets (space secret manager) — agent guidance

Goal: let users provide third-party tokens safely and let the runtime use them as env vars.

## Rules

- Never ask the user to paste secret values in chat.
- Secrets live in **Studio → Settings → Space → Secrets**.
- Secrets are injected into the runtime as environment variables for the allowed agent handle(s).
- Never print secret values (in logs, command output, or summaries).

## When you need a secret

If a task requires a token and it is missing (env var not set), do **not** proceed. Instead, return an action so the UI can guide the user:

```json
{
  "summary": "I need a token to continue. Click the button to add it, then reply here when you’re ready and I’ll retry.",
  "files": [],
  "actions": [
    {
      "type": "request_secret",
      "name": "GITHUB_TOKEN",
      "description": "GitHub personal access token used to create pull requests for this repo.",
      "agentHandles": ["octo"]
    }
  ]
}
```

Guidelines:
- `name` should be an env var name (examples: `GITHUB_TOKEN`, `CLOUDFLARE_API_TOKEN`).
- `agentHandles` should include the current agent handle (so the UI can preselect access).
- Secret names can be generic (for example `TOKEN`) if description clearly states provider/capability.

## Common secret names

- GitHub: `GITHUB_TOKEN` (or `GH_TOKEN` if using GitHub CLI)
- Cloudflare: `CLOUDFLARE_API_TOKEN`
- Stripe: `STRIPE_SECRET_KEY`

## Using secrets (safely)

- Read secrets only from env vars.
- For auth/integration tasks, inspect space secret metadata on demand before requesting a new secret:
  - `instafy secrets list --space <space-id> --json`
- To check presence, only check existence (never echo values), e.g.:
  - `python -c "import os; print('set' if os.getenv('GITHUB_TOKEN') else 'missing')"`

## After the user adds the secret

Tell the user to reply when they’re ready (any short confirmation works; do **not** require an exact phrase). When the user replies:
- Assume the secret has been added and retry the step that required it, even if the user message is vague (e.g. “ok”, “go”, “done”, “try again”).
- If the message clearly changes the task, follow the new instruction, but still use the newly available secret if relevant.
- If you’re unsure whether the secret was actually saved, check presence via env var existence (never print values). If still missing, re-request the secret.

Secrets refresh at job start and periodically during long-running runs; no runtime restart should be required.
