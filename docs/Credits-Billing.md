# Credits and Billing

Credits are team-scoped and enforced by the runtime controller. The Credits panel surfaces balance, ledger activity, and Stripe-backed subscription management.

Checkout is initiated from the active project context, but any subscription or refill applies to the owning org's shared ledger rather than only that project.

The important product rule is that Instafy keeps one shared team balance and one ledger. AI prompts, hosted runtimes, and tunnels should all debit the same pool, with category-specific metadata attached to the ledger rows so teams can understand what they paid for without reconciling multiple quota systems.

The current controller still stores that balance as integer billing units. The Credits panel can now render those units directly or approximate them in USD using `BILLING_UNITS_PER_USD`, which keeps the accounting integer-safe while making the UI easier to reason about.

The default managed-AI model is currently `gpt-5.6-sol`, served by OpenAI — the controller pins `CODEX_MODEL_PROVIDER=openai` for managed turns (`secrets.rs`), so the model users see is the model that runs. The pricing envs define the rates users are actually charged; the defaults are still calibrated to the OpenAI `GPT-5 mini` API pricing baseline as published on March 21, 2026:
- input: `$0.25 / 1M`
- cached input: `$0.025 / 1M`
- output: `$2.00 / 1M`

Pre-launch TODO: recalibrate these defaults to the real `gpt-5.6-sol` API rates (or explicitly decide to subsidize and say so in pricing copy) — the charged rates currently track a cheaper model than the one being served, which is a margin decision that should be deliberate, not inherited.

If you point the managed path at a different provider/model, update the pricing envs accordingly.

## Plans
- **starter**: 200 billing units / day (free, approx. `$0.20/day` at the default `BILLING_UNITS_PER_USD=1000`)
- **pro**: 2,000 billing units / day (Stripe)
- **scale**: 10,000 billing units / day (Stripe)

The plan catalog is stored in Postgres (`billing_plans`) and seeded via `supabase/migrations/20260000000022_billing_plans.sql`. Controllers read this table to resolve `planId`, daily credit limits, and default platform limits.

### Platform Limits (today)
- **starter**: 3 active tunnels (default), 5 active Instafy Cloud runtimes
- **pro**: 10 active tunnels (default), 20 active Instafy Cloud runtimes
- **scale**: 25 active tunnels, 50 active Instafy Cloud runtimes

Limits are overrideable per team through a protected server-side administration path. Never expose
service-role credentials to the browser.

### Credits-only tunnels
If the tunnel broker is configured to call the controller ACL hook, you can make tunnel uptime consume credits:
- Set `TUNNEL_BROKER_HOOK_SECRET` + broker config
- Set `TUNNEL_CREDIT_BURN_AMOUNT` and interval envs (`TUNNEL_CREDIT_BURN_INTERVAL_SECONDS`, `TUNNEL_CREDIT_BURN_LEAD_SECONDS`)

Recommended defaults (Starter = 200 credits/day):
- `TUNNEL_CREDIT_BURN_INTERVAL_SECONDS=480` (8 minutes)
- `TUNNEL_CREDIT_BURN_AMOUNT=10` (~75 credits/hour → ~80 tunnel-hours/month)
- `TUNNEL_CREDIT_BURN_LEAD_SECONDS=60`

### Credits-only Instafy Cloud runtimes
Instafy Cloud runtimes (provider `instafy-cloud`) can burn credits while a runtime has an active lease:
- Set `HOSTED_RUNTIME_CREDIT_BURN_AMOUNT` and `HOSTED_RUNTIME_CREDIT_BURN_INTERVAL_SECONDS`
- When a burn fails due to insufficient credits, the controller stops the runtime and releases it via the provider.

Note: the controller defaults `HOSTED_RUNTIME_CREDIT_BURN_AMOUNT=0`, so hosted runtime metering is disabled until you configure these env vars (the Credits panel will show `0 credits/min` and “Not metered”).

You can also override hosted runtime metering per runtime type via
`runtime_providers.metadata.billing` (controller reads `creditBurnAmount` plus
`creditBurnIntervalSeconds`). Restart the local controller after changing it.

Propagation: provider billing config is cached in the running controller. Restart the controller
after updating `runtime_providers.metadata.billing`; hosted deployments may instead use their
protected administration plane.

Recommended defaults (Starter = 200 credits/day, assuming tunnels are also enabled):
- `HOSTED_RUNTIME_CREDIT_BURN_INTERVAL_SECONDS=480` (8 minutes)
- `HOSTED_RUNTIME_CREDIT_BURN_AMOUNT=90` (plus tunnel burn ~= 100 credits/8 minutes total → ~8 runtime-hours/month)

### Credits-only managed AI
Managed Instafy AI can run without a user-provided provider key and burn the shared team balance per prompt:
- Set `MANAGED_AI_ENABLED=true`
- Set `MANAGED_AI_LABEL` to the user-facing product name
- Set `MANAGED_AI_CREDIT_BURN_AMOUNT` to the reserve debit taken before a prompt runs
- Set `MANAGED_AI_DAILY_PROMPT_LIMIT` if you want a daily starter cap
- Set `MANAGED_AI_MODEL_ID` to the upstream model id used for managed turns
- Set `MANAGED_AI_MODEL_LABEL` to the managed model name shown in the UI
- Set `MANAGED_AI_INPUT_USD_MICROS_PER_1K`
- Set `MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K`
- Set `MANAGED_AI_OUTPUT_USD_MICROS_PER_1K`
- Set `BILLING_UNITS_PER_USD` if you want the UI to expose USD equivalents for the shared balance

Managed AI still runs through the proxy. A self-hosted operator may configure a server-owned
provider credential, while BYOC users connect an API key or sanitized `auth.json` through the
credential flow. Neither credential path belongs in a Vite environment or browser bundle.
`MANAGED_AI_STARTUP_CHECK=true` makes the controller fail closed when the managed proxy path is
not ready.

The controller now reserves units at prompt dispatch and then reconciles the final charge after completion from actual input/cached/output token usage. The shared ledger keeps both the usage metadata and any follow-up adjustment row when the final charge differs from the reserve.

Starter guidance with the current defaults:
- 200 units/day is the whole shared free budget
- managed AI has a soft cap of 20 prompts/day by default
- tunnels and hosted runtimes burn from the same pool, so heavy infra usage reduces how much managed AI remains that day
- the balance resets once per day in UTC; there is no carry-over

## Controller Endpoints
- `GET /credits/status` — current team credit balance/limit.
- `GET /credits/ledger` — recent burn/refill events.
- `GET /credits/policy` — refill policy, plan catalog, and configured usage rates for metered services (including managed AI prompt costs).
- `POST /credits` — burn/refill ledger events.
- `POST /billing/checkout` — checkout or portal sessions.
- `POST /billing/webhooks/stripe` — Stripe webhook ingestion.

## Stripe Configuration
Required envs (GitHub secrets/vars or local env):
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID_PRO`
- `STRIPE_PRICE_ID_SCALE`

## Frontend Flow
- Credits panel calls `/credits/status` and `/credits/ledger` via the controller.
- Credits panel now supports `Log` and `Graph` views over the same shared ledger data.
- Checkout/portal actions call `/billing/checkout` with `action=checkout|portal`.
- Low-balance copy should direct users to upgrade/refill via the billing flow.
