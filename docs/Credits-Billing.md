# Credits and Billing

Credits are team-scoped and enforced by the runtime controller. The Credits panel surfaces balance, ledger activity, and Stripe-backed subscription management.

Checkout is initiated from the active project context, but any subscription or refill applies to the owning org's shared ledger rather than only that project.

The important product rule is that Instafy keeps one shared team balance and one ledger. AI prompts, hosted runtimes, and tunnels should all debit the same pool, with category-specific metadata attached to the ledger rows so teams can understand what they paid for without reconciling multiple quota systems.

The current controller still stores that balance as integer billing units. The Credits panel can now render those units directly or approximate them in USD using `BILLING_UNITS_PER_USD`, which keeps the accounting integer-safe while making the UI easier to reason about.

Ledger posts are idempotent. A burn or refill that carries an idempotency key (the managed-AI reserve, adjustment and refund, a hosted-runtime billing bucket, a tunnel grant, or a keyed `POST /credits`) writes at most one row per org, project and key, and a repeated key never moves the balance. The ledger's insert trigger enforces this under the org balance lock, before it changes the balance, so concurrent retries are covered too: the first post wins, and no later post with that key writes a row or moves the balance. The controller normally reports such a retry as `deduped`. If the balance ran short in between, a burn retry can instead be rejected as insufficient credits. A post without a project or without a key is never deduplicated.

The default managed-AI model is `gpt-6-luna` (label `GPT-6 Luna`), served by OpenAI. The controller pins `CODEX_MODEL_PROVIDER=openai` for managed turns (`secrets.rs`), so the model users see is the model that runs. Managed turns are paid by the operator out of the shared team balance, which is why the cheaper Luna tier is the default there. Bring-your-own ChatGPT logins and OpenAI API keys are paid by the user and keep `gpt-5.6-sol` as their default; that default, and the stale-model floor, are separate from the managed tier and did not move.

The pricing envs define the rates users are actually charged. The defaults match the public `gpt-6-luna` standard-tier API list prices verified on September 22, 2026:
- input: `$0.10 / 1M` (`MANAGED_AI_INPUT_USD_MICROS_PER_1K=100`)
- cached input: `$0.01 / 1M` (`MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K=10`)
- output: `$0.50 / 1M` (`MANAGED_AI_OUTPUT_USD_MICROS_PER_1K=500`)

The previous managed default, `gpt-5.6-luna`, listed at `$0.20 / $0.02 cached / $1.20 per 1M`, so the same turn now costs users roughly half the credits.

For comparison, `gpt-5.6-sol` lists at `$5 / $0.50 cached / $30 per 1M`. If you set `MANAGED_AI_MODEL_ID=gpt-5.6-sol` (or any other model), set the three pricing envs to that model's rates in the same change; the defaults only make sense for Luna.

If you point the managed path at a different provider/model, update the pricing envs accordingly.

## Plans
- **starter**: 200 billing units / day (free, approx. `$0.20/day` at the default `BILLING_UNITS_PER_USD=1000`)
- **pro**: 2,000 billing units / day (Stripe)
- **scale**: 10,000 billing units / day (Stripe)

The plan catalog is stored in Postgres (`billing_plans`) and seeded via `supabase/migrations/20260000000022_billing_plans.sql`. Controllers read this table to resolve `planId`, daily credit limits, and default platform limits.

### Platform Limits (today)
- **starter**: 3 active tunnels (default), 1 active Instafy Cloud runtime
- **pro**: 10 active tunnels (default), 3 active Instafy Cloud runtimes
- **scale**: 25 active tunnels, 8 active Instafy Cloud runtimes

The runtime limits come from `supabase/migrations/20260000000045_fundable_runtime_concurrency.sql`. When a space is refused by the limit, the controller hands it an idle runtime from another space in the same team; see `RUNTIME_LIMIT_RECLAIM_IDLE_SECONDS` in the controller README. A message queued behind the limit is retried in the background and sends once a runtime is free; after 30 minutes on the limit it fails with a reason and its managed-AI reserve is refunded (see [Runtime Machines](Runtime-Machines.md#waiting-on-the-runtime-limit)).

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
- Set `MANAGED_AI_MODEL_ID` to the upstream model id used for managed turns (default `gpt-6-luna`)
- Set `MANAGED_AI_MODEL_LABEL` to the managed model name shown in the UI (default `GPT-6 Luna`)
- Set `MANAGED_AI_INPUT_USD_MICROS_PER_1K` (default `100`, that is `$0.10 / 1M`)
- Set `MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K` (default `10`, that is `$0.01 / 1M`)
- Set `MANAGED_AI_OUTPUT_USD_MICROS_PER_1K` (default `500`, that is `$0.50 / 1M`)
- Set `BILLING_UNITS_PER_USD` if you want the UI to expose USD equivalents for the shared balance

Managed AI still runs through the proxy, and the proxy that matters is the one the runtime calls:
hosted runtimes talk to their own per-runtime proxy sidecar (`http://proxy:8789` in
`docker/docker-compose.runtime.provider.yml`), not to the controller's `PROXY_BASE_URL` proxy.
A managed turn carries a proxy token with no credential id, and the sidecar has two ways to serve
it:
- Set `MANAGED_AI_OPENAI_API_KEY` on the controller (`OPENAI_API_KEY` in the controller environment is honoured as the fallback, which is how hosted deployments already pass the key). The controller serves that key through the
  proxy credential-lease route under a fixed managed credential id, so a sidecar without static
  credentials (`remote_dynamic`) leases it like any other credential. The key stays on the
  controller; provider hosts and runtime containers never hold it. This is the recommended setup.
- Give every proxy a runtime calls static credentials (`OPENAI_API_KEY` or an API-key `auth.json`
  at `/opt/instafy/proxy-codex/auth.json` on each provider host), and set `PROXY_PINNED_MODEL` on
  it to `MANAGED_AI_MODEL_ID`. Without it the proxy serves managed turns on its key with whatever
  model a job asks for, speech, transcription and hosted tools such as web search included, and
  logs once that the managed model is not pinned. Both runtime compose files set the sidecar's
  `PROXY_PINNED_MODEL` from the environment that runs `docker compose`, which on a provider host
  is the provider service's: `PROXY_PINNED_MODEL` there, or else `MANAGED_AI_MODEL_ID`; an
  explicitly empty `PROXY_PINNED_MODEL` means no pin. That entry overrides the sidecar's env file,
  so a value in `proxy-credential-lease.env` has no effect.

A sidecar with neither refuses managed turns with `proxy token missing credential_id for BYOC
request`. Only a job token, which carries a run id, is a managed turn. The controller also signs
credential-less tokens without a run id at agent login and runtime register; every proxy with
controller integration refuses those with the same error, so they never spend the platform key,
static credentials included. (A proxy with `PROXY_REQUIRE_CREDENTIAL_CLAIM` refuses every
credential-less token earlier, with `proxy token missing valid credential_id claim`.)

Managed turns run only on Instafy-hosted runtimes. A managed dispatch whose job would be pinned
to a desktop or another private self-hosted runtime, through the chosen runtime or the agent's
own runtime setting, is refused with "Instafy AI runs on Instafy-hosted runtimes. Connect your
own AI to use this runtime." (error code `managed_ai_hosted_runtime_required`, with the runtimes
in `details.runtimeIds`) before the proxy check, the daily prompt count and the reserve, so it
spends nothing. The exception is a chosen runtime that is not dispatch-ready: not ready or
running, without a heartbeat in the last 90 seconds, or without the agent and origin
capabilities, as a stopped desktop is. Dispatch unpins its queued jobs from such a runtime,
private or not, and a hosted runtime of the space answers the turn, reserved and charged like
any other managed turn. That job is not refused. A ready private runtime, and an agent's own
runtime setting that names a private runtime other than the chosen one, are refused whatever
their state. Dispatch queues such a platform job unpinned in its own transaction, so nothing
after the commit can leave it pinned to the stopped runtime.
With `MANAGED_AI_ENABLED=false` there is no Instafy AI to point at, so a user's dispatch there
gets the usual "Managed Instafy AI is unavailable right now" refusal instead. In a skill-mode
ambient turn such a managed participant is skipped instead, by the same rule: it gets no job, its
run is closed with `metadata.managedAiSkipped.reason = "self_hosted_runtime"`, and the human's
message and any own-key participants go ahead.

A private self-hosted runtime never leases a platform AI job, whatever `MANAGED_AI_ENABLED` says,
so unpinned managed work waits for a hosted runtime; own-key jobs and terminal commands still run
there. With managed AI off the controller refuses the managed credential lease, so only a proxy's
own static key can serve a credential-less job, and a private runtime calls the proxy the
controller names unless its owner sets `PROXY_BASE_URL`. That key belongs to the deployment, so
the rule does not relax with the flag. Service-role dispatches, which have no managed gate (plan
workers, lead continuations, and queued sends with no user), are therefore refused the same way
whether or not managed AI is on:
- A skill-authored plan whose workers have no credential of their own would run them only on
  the planning agent's desktop or self-hosted runtime. A plan that reuses the runtime pins them
  there. A plan that spreads them leaves them unpinned, but only its parent runtime and the
  extra runtimes started for it, on the parent's provider, may take them, and those are private
  too. While the planning runtime is dispatch-ready, as it normally is right after the planning
  turn, the workers stay in that workspace rather than moving to a hosted runtime, so none is
  queued: the planning run fails with the reason, the conversation gets it as an error message,
  and a message queued behind the planning turn is sent. A reusing plan whose runtime is no
  longer dispatch-ready (the desktop stopped, say) is not refused: its workers are unpinned as
  above, and a hosted runtime runs them. A spreading plan is refused whatever its runtime's
  state.
- A refused lead checkpoint is written to the conversation as an error message, once per plan.
  A lead checkpoint whose runtime is no longer dispatch-ready is unpinned instead, like the
  workers of a reusing plan.
- A refused queued send is marked failed in the send queue.

A platform AI job that is already queued where only private runtimes could lease it (pinned to
one, or a spread plan worker whose parent runtime and plan runtimes are all private), queued
before this refusal existed, or by any path around the refusal, is failed by the controller's
idle sweep once it has been queued for 30 seconds, with the same reason in its run and
conversation. A job unpinned between the sweep's check and its failure is left queued. A
managed-AI reserve it never used is refunded, as for an expired requeued job.

The controller puts `CODEX_MODEL=MANAGED_AI_MODEL_ID` and `CODEX_MODEL_PROVIDER=openai` in the
job secrets (`/agent/secrets`, `secrets.rs`) of every job on the platform lane: an AI job whose
target has no credential, whether or not it names an agent. This keys on the job itself rather
than the `managedAiUsed` flag, so skill-mode ambient evaluations that have not answered yet and
service-role worker and lead-continuation dispatches get the managed model too. Own-key jobs and
terminal commands keep their agent's model, and with `MANAGED_AI_ENABLED=false` no job is
changed, because the credential-less lane is then the proxy's own key. Not every platform job
reads those secrets, though: a write-scoped worker lane that the runtime runs in parallel never
fetches job secrets, and a job whose secrets fetch failed has none. Both still ask for the
runtime's own model, by default `gpt-5.6-sol`, which lists at 50 to 60 times Luna's rates above.
The managed credential lease therefore carries `pinnedModel`, and the proxy
sends every request on it as `MANAGED_AI_MODEL_ID`, whatever model the job asked for; speech and
transcription are refused on it. A pinned request also forwards only codex's client tool types
(`function`, `custom`, `namespace`, and `tool_search` with `execution: "client"`), in `tools` and in
the `additional_tools` and `tool_search_output` input items, and drops any tool that names its own
model, so a hand-built hosted tool such as `image_generation` cannot run on the platform key.
Hosted OpenAI tools are off on a pinned lease: credits price tokens, and a hosted tool bills per
call on top of them. The proxy therefore also drops `web_search`, which codex does send, and any
tool search OpenAI would run, from the tools a pinned request finally carries, including the
default tools the proxy adds for a ChatGPT login, so pinned managed turns run without web search.
The tool filter follows the pin, like the model and the audio refusal, not the lane: only the
platform lane is ever pinned, and a user's own key or ChatGPT login is never pinned and keeps
every tool. The pin needs both a controller and a proxy that know `pinnedModel`. Either can be
updated first: until both are, requests keep the model they ask for and every tool, web search
included. This is separate from the key rollout order in the next paragraph. Static proxy
credentials serving managed turns get the same pin from `PROXY_PINNED_MODEL`, as described above.

The pricing envs are standard-tier rates, so the platform key also serves only OpenAI's standard
service tier. `priority` costs about twice as much per token, `flex` and `scale` are priced apart,
and a request that names no tier runs on the OpenAI project's own default tier, which the project's
settings decide (`auto` follows it too). The proxy therefore sends every managed Responses and Chat
Completions request to the OpenAI API with `service_tier: "default"` explicitly. A managed request
that asks for any other string tier, such as `priority`, which codex's Fast mode sends, is
overridden to `default` rather than refused, so a stray codex setting never fails a managed turn.
The proxy logs each override when it hands the request to its upstream HTTP client, and counts it
as `serviceTierOverrides` in the `platformLane` health object, next to `serviceTier`; a request
refused before that, for bad input or a failed lease, is not counted. A tier that is not a string,
which codex never sends, is refused with 400 `service_tier_not_allowed` before the proxy leases a
credential or contacts the provider. A static ChatGPT login serving managed turns sends the ChatGPT endpoint no
tier, as before, since how that endpoint treats one is unverified; its overrides are counted and
logged with no tier sent. The tier goes only to OpenAI's own API by default:
`PROXY_PLATFORM_SERVICE_TIER_ENDPOINTS` is `openai` (hosts under `openai.com`), `all` (any endpoint
that takes a tier, for an OpenAI-compatible provider that accepts `default`) or `none`, since such
a provider may reject the field or its value. A request to an endpoint the setting leaves out goes
with no tier, as before this rule, and its override is counted and logged the same way. The
`serviceTier` health field says whether the lane's requests carry the tier; for the controller's
managed lease, whose endpoint comes with each lease, it says what the setting implies. Speech and
transcription refuse any tier but `default` with the same 400 instead of overriding it, since the
proxy forwards audio bodies as sent and codex sends them no tier. This rule follows the lane, not
the pin: it holds however the platform lane is served, pinned or not. A user's own key or ChatGPT
login is sent no tier, as before this rule, whatever its request asks for. The rule needs only the
proxy, so it can ship before any codex upgrade: today's runtime sends no tier, and every managed
Responses and Chat Completions request to the OpenAI API now goes out as `default`.

Roll the proxy out first. Setting `MANAGED_AI_OPENAI_API_KEY` is what makes the controller
advertise managed AI and charge for managed turns, so every provider host must already run a
proxy image built from this change (`RUNTIME_PROXY_IMAGE`) before the key goes on the
controller. Set the key first and an older sidecar keeps rejecting the turns the controller is
already charging for.

BYOC users connect an API key or sanitized `auth.json` through the credential flow. Neither
credential path belongs in a Vite environment or browser bundle. `MANAGED_AI_STARTUP_CHECK=true`
makes the controller fail closed when its own proxy can serve neither path; it does not probe
per-runtime sidecars. When the check passes, the controller logs how that proxy serves managed
turns, from the `platformLane` object on the proxy's `/healthz` (see the proxy README): the
controller's lease or the proxy's static credentials, with their kind and pinned model.

The controller now reserves units at prompt dispatch and then reconciles the final charge after completion from actual input/cached/output token usage. Cached tokens are a subset of the reported input tokens, so only the uncached remainder is billed at the input rate and the cached prefix is billed once at the cached rate. The shared ledger keeps both the usage metadata and any follow-up adjustment row when the final charge differs from the reserve.

Known gap, recorded only: until the proxy metering cutover, this reconciliation charges the token
counts codex reports, and codex multi-agent v2 subagent requests never get one, so legacy billing
under-charges them. The proxy sees their upstream usage, so its meter charges them once metering
moves there; nothing changes the legacy charge before then.

Ambient multi-human evaluation turns defer the managed reserve and prompt count until
the agent actually answers. Telemetry and explicitly hidden progress do not start a
charge; a completion-only answer does, before usage reconciliation. Streaming followed
by completion charges once. A swallowed `NO_RESPONSE` stays uncharged, while a later
real answer starts normal billing. BYOC and scheduled-automation billing keep their
existing rules. See [group participation](Group-Conversation-Participation.md).

Starter guidance with the current defaults:
- 200 units/day is the whole shared free budget
- managed AI has a soft cap of 20 prompts/day by default
- tunnels and hosted runtimes burn from the same pool, so heavy infra usage reduces how much managed AI remains that day
- the balance resets once per day in UTC; there is no carry-over

### Ledger guard
Every `org_credit_ledger` insert moves the team balance through the ledger's balance trigger,
under a lock on the team's balance row:
- A debit that would leave the balance below zero is refused unless the row sets
  `allow_overdraft`. No controller path sets it today.
- A credit is always applied, including one that leaves a negative balance still negative.
- A row whose idempotency key the team already has for the same project is skipped without
  moving the balance, also under `ON CONFLICT DO NOTHING` and between concurrent writers. Rows
  without a project are never deduplicated, as in the ledger's unique index.

### Usage metering (record-only)
The controller is starting to meter managed AI from the proxy's reports of exact upstream usage,
beside the reserve-and-reconcile billing above, which still decides every charge. Today it only
records which jobs run on the platform key and which tokens they hold:
- Dispatch writes one `ai_usage_jobs` row for every platform job, in the transaction that enqueues
  it: an agent job whose intent needs AI (not a `terminal_command`) and whose target has no
  credential. Service-role dispatches such as plan workers, lead continuations and queued sends
  without a user get one too. BYO jobs, including the BYO targets of a mixed dispatch, and
  terminal commands get none, so they have no platform lane to meter.
- The row is the job's billing identity and is written once. Its `billing_mode` is `record_only`:
  nothing is posted to the ledger from it. Its `decline_waiver_units` is
  `MANAGED_AI_DECLINE_WAIVER_UNITS` (default `2`) for a skill-mode ambient evaluation, as the
  dispatch's own participation decision classified it, and `0` for every other job, scheduled
  automations included. It is never read from the job payload, which a client or a later decline
  can change.
- Every job token the job lease mints now names its job and lease attempt (`job_id`,
  `lease_attempt`). For a platform job, and only for one, the lease also records the token's
  SHA-256 in the job's row under that attempt, in the lease transaction. BYO and terminal leases
  write nothing there, so they never depend on the metering table. The metering checks still to
  come (the managed-key lease and the usage report) accept only a token recorded that way, so even
  a holder of the proxy signing secret can use only tokens the controller minted for that job
  attempt. The controller's other proxy tokens (the agent-login and runtime-register envelopes,
  and those for its own credential checks, inline completions and conversation titles) carry
  neither claim. Proxies ignore both claims for now and accept tokens with or without them, so the
  controller and the proxy can be updated in either order.
- Those checks verify a job token in one of two modes. Both require a signature with the proxy
  signing secret and the `aud` (`proxy`), `iss` (`runtime-controller`), `exp` and `iat` claims; a
  token missing any of them is refused. The live mode, for the managed-key lease, also enforces
  `exp` and requires that the job is still leased (`agent_jobs.status = 'leased'`) to the runtime
  the token names and that the token is the one recorded for the job's current attempt. Cancel,
  finish and requeue leave the attempt unchanged, so a token stops being live the moment its job
  stops being leased, not when it expires. The settle mode, for the usage report, skips `exp`,
  accepts a token issued within the last 24 hours and requires the token recorded for the attempt
  it names, whatever the job's status now, so a finished job and a requeued job's earlier attempt
  still bill.
- The next step (the managed-key lease and the usage report) must keep two rules. The managed-key
  lease requires a bound live token in every case, with no fallback for an unbound or legacy
  token. A settle takes the job and lease attempt from the verified token, never from the report
  body.

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
