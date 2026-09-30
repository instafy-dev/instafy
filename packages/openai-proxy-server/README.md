# Codex Proxy & CLI

A Rust playground for driving OpenAI Codex-style completions with your local credentials. It includes:

- `openai-proxy-server` binary: send a prompt to the Codex backend via CLI.
- `proxy` binary: host a lightweight HTTP proxy that mimics the OpenAI Responses API while delegating to the Codex backend.

> ⚠️ This project requires valid Codex/ChatGPT credentials stored in `.codex/auth.json` or provided via environment variables. Make sure you can run the official `codex` CLI first.

## Prerequisites

- Rust toolchain (Rust 1.80+ recommended).
- `.codex/auth.json` produced by the official Codex CLI, or the env var `OPENAI_API_KEY`.
- Internet access for the proxy/CLI to reach the Codex backend.

### Credential resolution order

1. `OPENAI_API_KEY` environment variable.
2. `CODEX_AUTH_PATH` pointing directly to an `auth.json` file.
3. `CODEX_HOME` (expects `<CODEX_HOME>/auth.json`).
4. `$HOME/.codex/auth.json`.

## Running the CLI

Use the main binary to send a one-off prompt. Provide input as CLI args or pipe from stdin.

```bash
# default binary (same as --bin openai-proxy-server)
cargo run -- "Explain what this project does"

# equivalent explicit form
cargo run --bin openai-proxy-server -- "Explain what this project does"

# or via stdin
printf 'List three Rust async runtimes.' | cargo run --
```

The CLI prints the assistant text when available; otherwise it dumps the full JSON response.

## Running the proxy

Launch the proxy binary to expose a local OpenAI-compatible endpoint:

```bash
cargo run --bin proxy
```

By default it binds to `127.0.0.1:8080`. Adjust by setting `CODEX_PROXY_ADDR`:

```bash
CODEX_PROXY_ADDR=0.0.0.0:9000 cargo run --bin proxy
```

### Testing the proxy with curl

```bash
curl -s http://127.0.0.1:8080/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
        "model": "gpt-5.5",
        "prompt": "Tell me a Rust joke"
      }' | jq
```

Any of the following fields can supply user input: `prompt`, `text`, `input` (Codex array format), or a Chat Completions-style `messages` array. The proxy forwards the request using credentials from your `auth.json` and returns the upstream JSON verbatim.

Pass `reasoning.effort` to `/v1/responses`, or `reasoning_effort` to
`/v1/chat/completions`, to choose `minimal`, `low`, `medium`, `high`, `xhigh`, or
`max`. Valid requests override `CODEX_REASONING_EFFORT` and retain their effort
when forwarded to ChatGPT, API-key Responses, or Chat Completions upstreams.
Values are trimmed and case-normalized; invalid values are ignored. Model support
still applies: [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)
supports `low` through `max`, while older models may support fewer values.

The proxy also exposes OpenAI-style speech synthesis at `/v1/audio/speech`. That is intended for
local speech-host tooling that wants an HTTP TTS backend instead of the macOS `say` fallback:

```bash
curl -s http://127.0.0.1:8080/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
        "model": "gpt-4o-mini-tts",
        "voice": "cedar",
        "input": "Hello from Instafy.",
        "response_format": "wav"
      }' \
  --output /tmp/instafy-speech.wav
```

If the upstream account or credential path does not actually support speech synthesis, the proxy
returns a surfaced upstream error instead of silently pretending the backend is healthy.

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `CODEX_PROXY_ADDR` | HTTP bind address for the proxy | `127.0.0.1:8080` |
| `CODEX_AUTH_PATH` | Absolute path to `auth.json` | `None` |
| `CODEX_HOME` | Directory containing `auth.json` | `$HOME/.codex` |
| `OPENAI_API_KEY` | API key credential | `None` |
| `CODEX_OPENAI_ENDPOINT` | Upstream Responses endpoint for API-key credentials | `https://api.openai.com/v1/responses` |
| `CODEX_REASONING_EFFORT` | Fallback effort (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`), read once at startup/first use | Unset; ChatGPT defaults to `medium` |
| `PROXY_CONTROLLER_BASE_URL` | Enables controller-integrated hosted mode | `None` |
| `CONTROLLER_INTERNAL_TOKEN` | Required with controller integration; the proxy derives its token signing secret from it when `PROXY_SIGNING_SECRET` is unset | `None` |
| `PROXY_CREDENTIAL_LEASE_TOKEN` | Dedicated bearer used only for controller credential leases | `None` |
| `PROXY_PINNED_MODEL` | The only model static credentials serve managed runs as (set it to the controller's `MANAGED_AI_MODEL_ID`); see [Model selection](#model-selection) | `None` |
| `CODEX_PROXY_CHATGPT_ENDPOINT` | Upstream ChatGPT Codex Responses endpoint | `https://chatgpt.com/backend-api/codex/responses` |

`CODEX_OPENAI_ENDPOINT` can also point at an OpenAI-compatible Chat Completions endpoint (e.g. `.../chat/completions`). When it does, the proxy will call that upstream endpoint and adapt the result into an OpenAI Responses-shaped payload for downstream callers.

The proxy does not debit credits. `PROXY_CREDIT_BURN_AMOUNT`, which once charged a flat amount
per request through the controller, has no effect; the proxy logs one warning at startup when it
is still set, with or without controller integration.

Standalone local mode may read and refresh the operator's own `auth.json`. In
controller-integrated mode, the controller is the only refresh-token authority: the proxy gets a
short-lived access/API-key lease and never receives the stored refresh token.

### Model selection

A request's `model` picks the upstream model. An absent or empty model uses the credential's
default. An explicit id goes to OpenAI endpoints as is. On a bring-your-own provider endpoint
(DeepSeek, z.ai, Gemini) the credential's default replaces it, and a ChatGPT login given another
provider's id uses its default, so a mismatched id does not fail upstream.

In controller-integrated mode the controller can pin a credential lease to one model with
`pinnedModel` on the lease response. It pins the managed Instafy AI lease, which the operator
pays for, to `MANAGED_AI_MODEL_ID`. The proxy then sends every Responses and Chat Completions
request on that lease as the pinned model, whatever model the request names, and logs
`credential lease pins the model` with the requested and sent ids when they differ. Speech and
transcription requests name an audio model the pinned model cannot replace, so both routes
answer 400 on a pinned lease without contacting the provider. Client tools on a pinned lease are
limited to codex's client tool types (`function`, `custom`, `namespace`, and `tool_search` with
`execution: "client"`), both in `tools` and in the input items that carry tool definitions
(`additional_tools`, where codex lists its tools for Responses Lite models such as the managed
one, and `tool_search_output`). Before the request goes upstream the proxy drops any other type,
any tool that names its own `model`, and a namespace holding either, and logs
`credential lease drops client tools` with a count per tool type and reason. Hosted tools, which
OpenAI runs and bills per call, are off on a pinned lease: `web_search`, which codex sends, and
a tool search with any other `execution` are dropped with reason `hosted`, and a drift test fails
when codex adds a tool type that is neither allowed nor dropped on purpose. The filter runs
again on the tools the request finally carries, so the default tools the proxy gives a ChatGPT
login's request that keeps none of its own lose `web_search` too, whatever
`CODEX_ENABLE_WEB_SEARCH` says. The pin, not the lane, decides all of this. Only the platform
lane is ever pinned, by the controller's managed lease or by `PROXY_PINNED_MODEL` below, but a
platform lane without a pin is not filtered. Leases without `pinnedModel` (bring-your-own API
keys, ChatGPT logins, and leases from a controller that predates the field) keep the rules above
and forward client tools unchanged, hosted ones included.

With controller integration, static proxy credentials (`OPENAI_API_KEY` or `auth.json`) serve
the platform lane: managed runs, whose controller-signed job tokens carry a `run_id` and no
`credential_id`. Set `PROXY_PINNED_MODEL` to the controller's `MANAGED_AI_MODEL_ID` and those
runs get exactly the pinned-lease policy above. A controller-signed token with neither a
`credential_id` nor a `run_id` (the agent-login and runtime-register session envelopes) is not a
turn, and both backends refuse it with 401 `proxy token missing credential_id for BYOC request`
instead of serving it on the operator's key (a proxy with `PROXY_REQUIRE_CREDENTIAL_CLAIM` refuses
every credential-less token earlier, with `proxy token missing valid credential_id claim`). Tokens that name a credential are leased from the
controller and never pinned by the setting. In standalone mode, without a controller, the proxy
checks no token and its static credentials serve every request unpinned. Without the setting managed
runs are not pinned: they keep the requested model, speech, transcription and every client tool,
hosted ones included, and the first one logs a warning that says so.
A proxy without static credentials ignores the setting. The runtime compose files
(`docker/docker-compose.runtime.provider.yml` and `docker/docker-compose.runtime.yml`) set it on
the sidecar from the environment that runs `docker compose`, which on a provider host is the
provider service's: `PROXY_PINNED_MODEL` there, or else `MANAGED_AI_MODEL_ID`; an explicitly
empty `PROXY_PINNED_MODEL` means no pin. That entry overrides the sidecar's env file, so a value
in `proxy-credential-lease.env` has no effect.

### Platform lane health report

`/healthz` and `/readyz` carry a `platformLane` object that says how the proxy serves managed runs
(the platform lane, on the operator's key). The controller reads it from its own proxy at startup
and logs it.

| Field | Meaning |
| --- | --- |
| `servedBy` | `controller_lease` (no static credentials: the controller's managed lease), `static` (the proxy's static credentials), or `refused` (`PROXY_REQUIRE_CREDENTIAL_CLAIM` turns away every credential-less token) |
| `pinnedModel` | The model static credentials serve managed runs as (`PROXY_PINNED_MODEL`). `null` for a controller lease, which carries its own pin, and in standalone mode, where no token marks a managed run |
| `staticCredentialKind` | `api_key`, `chatgpt` or `gemini_code_assist` when `servedBy` is `static`, else `null` |
| `sessionTokensRefused` | `true` with controller integration: credential-less tokens without a `run_id` get 401 |
| `reportsUsage` | Whether the proxy reports platform-lane usage to the controller; `false` today |
| `controllerMeteringProtocol` | The controller's usage metering protocol as the proxy last read it; `null` today |
| `outputCeilingSource` | Where the output token ceiling sent upstream comes from; `null` today, no ceiling is sent |

### Upstream failures and retries

Responses, Chat Completions, speech and transcription preserve upstream HTTP error statuses. A rejected request or
credential (400/401/403) is terminal; rate limits (429, except an exhausted bucket that needs more
than five minutes to refill, as described below), timeouts (504), and temporary upstream failures (5xx) remain retryable.
Recognized `insufficient_quota` codes in an HTTP 429 body or a failed Responses stream return
terminal 402. A ChatGPT plan limit (`usage_limit_reached` or
`usage_not_included` in an HTTP 429 body or a failed Responses stream) stays 429 but is terminal
and carries no `Retry-After`, because no wait within a turn lifts it: `usage_limit_reached` means
the plan's usage window is spent until it rolls over, hours or days later, and
`usage_not_included` means the plan does not include that usage at all. Failed credential renewal
and invalid request or redirect configuration return terminal 424. Unknown transport errors,
including opaque TLS handshake failures, return retryable 502 because they may be temporary.

Upstream error envelopes retain `error.type: "upstream_error"` and a safe `error.message`, and
add a stable `error.code` and boolean `error.retryable`. The one exception is a plan limit,
whose `error.type` is the provider's `usage_limit_reached` or `usage_not_included` so Codex
reports it as a usage limit, with a positive integer `error.resets_at` (Unix seconds) when the
provider gave one. Raw provider messages, response bodies, credentials, and endpoint URLs are
not echoed. Valid `Retry-After` seconds or HTTP dates are forwarded for 429 and 503 with the
provider's value and no bound of the proxy's own (Codex reads it only on a retryable 429 and
clamps that wait to 1-30 seconds); other
header values are discarded. Every retryable 429 carries a `Retry-After`. When the provider
sends no usable one, the proxy derives it from the rate-limit bucket that refused the request,
using OpenAI's `x-ratelimit-remaining-*` and `x-ratelimit-reset-*` headers (reset durations such
as `6s` or `1m2.5s` are rounded up to whole seconds):

- A bucket whose `x-ratelimit-remaining-*` count is 0 refused the request, so the proxy waits
  for that bucket's reset, or for the later of both resets when both counts are 0.
- When no count is 0, or the counts are missing, nothing shows which bucket refused: a tokens
  bucket with room left can still refuse a large request. The proxy then waits for the later of
  the two resets.

A derived delay is clamped to 1-30 seconds. With no usable reset, and for an in-stream
`rate_limit_exceeded`, which carries no headers, the proxy uses 5 seconds, the same fallback
Codex applies to a retryable 429 without `Retry-After`. Reset headers are time until a bucket
is completely full, and a per-minute bucket is full again within about a minute. When a bucket
at 0 needs more than five minutes to refill, as with a daily requests or tokens limit, the
turn's retries (roughly five waits of up to 30 seconds) cannot outlast it: the proxy answers a
terminal 429 (`upstream_rate_limit`, `retryable: false`) with no `Retry-After`, and Codex ends
the turn with a rate-limit error instead of waiting out its retry budget. When no bucket is at
0, a long reset does not prove that the slower bucket is the one that refused, so that 429
stays retryable.

The proxy does not replay ordinary failed model requests. It retains one credential renewal
and one resend after an eligible ChatGPT 401. Controller mode performs that renewal through
the controller lease interface; standalone mode uses its local refresh authority. Calling
runtimes own bounded transient retries. Invalid successful responses are retryable 502 failures;
they do not change credential state.

## Tests & formatting

Run the standard checks before committing changes:

```bash
cargo fmt
cargo test
```

The backend smoke test will automatically skip if credentials are missing or the backend rejects the request (e.g., rate limits).

For deterministic failure and retry validation without provider access or local auth files:

```bash
cargo test --lib --test proxy_upstream_failures
```

This suite uses inert credentials and loopback HTTP mocks, covering terminal and transient
statuses, recovery, one-shot refresh, malformed responses, safe diagnostics, and typed transport
classification. It does not demonstrate live-provider availability or certificate repair.

## Next steps

- Extend the proxy to handle streaming responses.
- Support additional OpenAI options (tool calls, caching hints, etc.).
- Add structured logging for observability.
