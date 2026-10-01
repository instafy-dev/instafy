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
| `PROXY_PLATFORM_SERVICE_TIER_ENDPOINTS` | Which upstream endpoints get the platform lane's `service_tier: "default"`: `openai` (only hosts under `openai.com`), `all` (any endpoint that takes a tier) or `none`; any other value stops the proxy at startup. See [Service tier](#service-tier) | `openai` |
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
`credential_id`. A job token also names the job and lease attempt it was minted for (`job_id`
and `lease_attempt`) for the controller's usage metering; the proxy accepts tokens with or
without them and does not use them yet.
Set `PROXY_PINNED_MODEL` to the controller's `MANAGED_AI_MODEL_ID` and those
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

### Tool controls

The proxy builds each upstream body itself. On the Responses wire API, to the OpenAI API (or an
OpenAI-compatible Responses endpoint) and to a ChatGPT login's Codex endpoint, a `/v1/responses`
request that lists `tools` sends them with its `tool_choice` (`auto` when absent) and
`parallel_tool_calls` (`false` when absent). A request without `tools` sends the OpenAI API no
tool control, and a ChatGPT login gets the proxy's default tools (`shell`, `apply_patch`,
`update_plan` and `view_image`, which the `CODEX_*` tool flags can change) with
`tool_choice: "auto"` and `parallel_tool_calls: false`. Codex sends the tools of a Responses Lite
model, such as gpt-6-luna or gpt-5.6-sol, in an `additional_tools` input item and omits `tools`,
so the request's own `tool_choice` is not forwarded on either path. The OpenAI API does get such a
request's own `parallel_tool_calls` when the request sends a boolean, as codex does (`false` for
these models), since the API's own default is `true`; a request that sends none, or a value that
is not a boolean, gets none, as before. The runtime offers such a model only the tools in that
item, so a ChatGPT login sends a request that carries the item none of the default tools: no
`tools` at all, with `tool_choice: "auto"` and `parallel_tool_calls: false`, even when a pinned
lease dropped every tool in the item. An explicit
empty `tools` array, by contrast, asks for a plain text completion, as `tool_choice: "none"` does,
and goes upstream with no tools at all. A Chat Completions or Gemini Code Assist upstream is sent
no client tools and no tool control. The request's `client_metadata` is never copied upstream.

**Required tool call.** While the runtime's required execution gate is armed, codex adds
`client_metadata["instafy.require_tool_call"] = "1"` to its model request. The proxy sends such a
request upstream with `tool_choice: "required"`, to the OpenAI API and to the ChatGPT Codex
endpoint alike, when all of these hold:

- the key's value is exactly the string `"1"`;
- the request goes upstream on the Responses wire API, which alone carries tool controls, not to
  a Chat Completions or Gemini Code Assist endpoint;
- the request offers tools: a non-empty `tools`, or an `additional_tools` input item with at least
  one tool, counted after a pinned lease drops the tools it does not forward;
- its `tool_choice` is `"auto"` or absent;
- it is not a remote compaction request, whose input carries a `compaction_trigger` item. Codex
  sends that request with the turn's tools while a required tool call is still pending, but it
  must come back as a compaction item, and a tool call would fail it.

A Responses Lite request then carries `tool_choice: "required"` although it has no `tools`, on a
ChatGPT login as well, and nothing else in the upstream body changes. Any other request, one
whose key has another value included, goes upstream exactly as it would without the key: a
request that chose `none`, `required` or a named tool keeps the controls above, so a Responses
Lite request's own `required` is still not forwarded. The key applies on every lane whose
requests use the Responses wire API, the platform lane and bring-your-own credentials alike,
since the gate is codex's behaviour and not a billing rule. Each request that goes upstream with
`required` logs one `required tool call sends tool_choice required` line with the route and the
run id, never the request body. A request to a Chat Completions or Gemini Code Assist endpoint
logs none, since it carries no tool control. The key itself never goes upstream, since no
`client_metadata` does.

**When upstream refuses `required`.** Whether OpenAI accepts `tool_choice: "required"` for a
request whose tools arrive only in `additional_tools` is unverified, so the proxy falls back
rather than fail every such turn. When a request goes upstream with the `required` the proxy set
and the upstream, the OpenAI API or the ChatGPT Codex endpoint, answers 400 with an error that
blames the tool controls, the proxy sends the same request once more, on the same lease and
credential, exactly as it would have gone without the key: with `tool_choice: "auto"` when it
lists `tools`, and, for a Responses Lite request, with no `tool_choice` to the OpenAI API and
`auto` to a ChatGPT login. The error blames the tool controls when the body is an
OpenAI error object whose `param` is `tool_choice` or `tools`, or, when it names no `param`, whose
code (`error.code`, or `error.type` without one) is set and whose `message` names the tool choice
(`tool_choice` or `tool choice`). Nothing else falls back: not a 400 whose `param` names another
parameter, whatever its message says, nor one without an `error` object (such as a
`{"detail": ...}` body), nor any other status, nor an error a stream reports after it has
started, nor any request whose `required` the proxy did not set, one that chose `required` itself
included. Those go back to the client after one attempt, as before. If the retry fails too, its
failure goes back as any failure does.

Each fallback logs one `required tool call falls back to the request's own tool choice` line with
the route, the run id, the upstream error's code (at most 64 characters) and its `param`, never
its message or the request body, and adds one to `requiredToolCallFallbacks` in the
[health report](#platform-lane-health-report). The retry belongs to the same request: it counts
no second service tier override, logs no second `required tool call sends tool_choice required`
line, and a lease renewal that follows it sends no `required` either.

The loopback tests prove only what the proxy sends. Whether OpenAI honours
`tool_choice: "required"` when the tools arrive only in `additional_tools` cannot be shown with a
mock upstream, so it is a staging check. So is whether the ChatGPT Codex endpoint serves a
Responses Lite request that has no `tools` and `tool_choice: "auto"`: codex sends it that shape
when codex itself holds the ChatGPT login, but the proxy's requests have not been tried there. On
staging, a `requiredToolCallFallbacks` above `0`, with the log lines that name the error, shows
that the upstream refuses `required`; a refusal in a shape the proxy does not match still fails
the turn, as it did before the fallback.

### Service tier

The platform lane serves only OpenAI's standard tier, because managed AI credits are priced at
the standard tier's rates: `priority` costs about twice as much per token, and `flex` and `scale`
are priced apart too. Every Responses and Chat Completions request on the platform lane that goes
to the OpenAI API (an API key, from the controller's managed lease or the proxy's static
credentials) goes upstream with `service_tier: "default"`. A request without a tier would
otherwise run on the OpenAI project's own default tier, which the project's settings decide. The
rule follows the lane, not the pin: an unpinned platform lane gets it too, since the tier
multiplies the price of whatever model runs on the operator's key.

`PROXY_PLATFORM_SERVICE_TIER_ENDPOINTS` says which upstream endpoints get that tier. The
default, `openai`, sends it only when the endpoint's host is `api.openai.com` or another host
under `openai.com`: the proxy parses the endpoint URL and compares its host, in any case, so a
path, query, userinfo or IP address that names OpenAI does not count. An OpenAI-compatible
provider set with `CODEX_OPENAI_ENDPOINT`, or a managed lease whose endpoint is not OpenAI, may
reject the field or its value (Groq, for one, names its tiers differently), so any other host
gets no tier, as before the platform lane sent one. `all` sends it to any endpoint that takes
one, for an OpenAI-compatible provider that accepts `default`, and `none` sends it to none. Any
other value stops the proxy at startup with an error that names the setting. The setting decides
only where the tier goes: the overrides and refusals below apply under all three, and a request
sent no tier drops the one it asked for.

A platform-lane model request that asks for any other string tier (`auto`, which follows that
project default, `priority`, which codex's Fast mode sends, `flex`, `scale`, a differently cased
or padded `default`, an empty string, or anything else) is overridden rather than refused: it goes
upstream as `default`, or with no tier where none is sent, so a stray codex setting or agent role
never fails a managed turn. Each override logs one
`platform lane overrides the requested service tier` line with the route, the run id, the tier
sent (`serviceTier`) and at most the first 32 characters of the requested tier, never the request
body, and adds one to `serviceTierOverrides` in the health report below. Both happen when the
proxy hands the request to its upstream HTTP client, once per request however many attempts it
takes, so a request that then fails to connect is still counted; one refused for bad input or a
failed lease, or failing inside the proxy before that point, is neither logged nor counted. An explicit `null` counts as no tier. Codex never sends
a tier that is not a string, so a number, boolean, object or array is refused with 400 before any
lease or upstream request. The refusal's `error.type` is `invalid_request_error`, its
`error.code` is `service_tier_not_allowed`, and its message says the platform key serves only the
default tier.

A static ChatGPT login serving the platform lane sends the ChatGPT Codex endpoint no tier,
whatever the setting: the proxy never sent it one, codex itself sends it no `default`, and how
that endpoint treats one is unverified. Its overrides are still counted and logged, with
`serviceTier` `null` in the log line, since the requested tier is dropped rather than replaced.
Gemini Code Assist requests have no service tier, so none is sent on them either, and their
overrides are logged the same way, as are those of an endpoint the setting sends no tier.

Bring-your-own lanes (a user's API key or ChatGPT login) send no `service_tier`, whatever the
request asks for, as the proxy always has: it builds the upstream body itself and never copied the
tier into it. Dropping it there is not an override and is not counted. In standalone mode, without
a controller, no token marks a managed run and the proxy sends no tier either.

Speech and transcription refuse instead of override. They forward the client's own body, so an
override would mean rewriting it, a multipart form included, and codex sends no tier to either,
so a refusal there costs no managed turn. OpenAI documents no service tier for audio, so the proxy
adds none to them. On the platform lane a speech request whose JSON names any `service_tier` but
`default`, or a transcription form in which the proxy's own form reader finds a `service_tier` field
other than `default`, gets the same
coded 400 before any lease or upstream request, pinned or not, and counts no override. A
platform-lane audio request with no tier, `null` or `default` goes upstream exactly as sent. On a
bring-your-own lane and in standalone mode the audio body goes as sent, tier included, as before.
A pinned platform lease still refuses both routes, as above.

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
| `serviceTier` | The `service_tier` platform-lane Responses and Chat Completions requests go upstream with (see [Service tier](#service-tier)), by the rule the requests follow: `default` when static credentials and their endpoint carry it, and `null` for a static ChatGPT login, Gemini Code Assist, an endpoint `PROXY_PLATFORM_SERVICE_TIER_ENDPOINTS` does not name (with the default `openai`, a host not under `openai.com`), when `servedBy` is `refused`, and in standalone mode. A controller lease names its endpoint only per lease, so for `controller_lease` the field says what the setting implies for the controller's OpenAI API key: `default` unless the setting is `none`. A lease whose endpoint is not an OpenAI host still gets no tier under `openai`, which each override's log line shows |
| `serviceTierOverrides` | How many platform-lane Responses and Chat Completions requests since the proxy started went upstream without the string tier they asked for: replaced with `default`, or dropped where no tier is sent (a ChatGPT login, Gemini Code Assist, or an endpoint the setting does not name). A request counts when it goes upstream, once however many attempts it takes; one that never gets there (refused for bad input, no credits or a failed lease, or failing inside the proxy after its lease) does not. It only grows, and stays `0` without a platform lane |
| `reportsUsage` | Whether the proxy reports platform-lane usage to the controller; `false` today |
| `controllerMeteringProtocol` | The controller's usage metering protocol as the proxy last read it; `null` today |
| `outputCeilingSource` | Where the output token ceiling sent upstream comes from; `null` today, no ceiling is sent |

Next to `platformLane`, both endpoints carry one more top-level field:

| Field | Meaning |
| --- | --- |
| `requiredToolCallFallbacks` | How many requests since the proxy started went upstream again without the `tool_choice: "required"` the proxy set, after the upstream refused it with a 400 that blames the tool controls (see [When upstream refuses `required`](#tool-controls)). It counts every lane, bring-your-own credentials included, since the required tool call applies on each, and a request counts once, when it falls back, however many attempts it takes. It only grows, and `0` is what a proxy whose upstream accepts `required` reports |

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
provider's value and no bound of the proxy's own (Codex itself does not retry an HTTP 429, so
the header matters to other clients and to the streamed wait below); other header values are
discarded. Every retryable 429 carries a `Retry-After`. When the provider
sends no usable one, the proxy derives it from the rate-limit bucket that refused the request,
using OpenAI's `x-ratelimit-remaining-*` and `x-ratelimit-reset-*` headers (reset durations such
as `6s` or `1m2.5s` are rounded up to whole seconds):

- A bucket whose `x-ratelimit-remaining-*` count is 0 refused the request, so the proxy waits
  for that bucket's reset, or for the later of both resets when both counts are 0.
- When no count is 0, or the counts are missing, nothing shows which bucket refused: a tokens
  bucket with room left can still refuse a large request. The proxy then waits for the later of
  the two resets.

A derived delay is clamped to 1-30 seconds. With no usable reset, and for an in-stream
`rate_limit_exceeded`, which carries no headers, the proxy uses 5 seconds. Reset headers are time until a bucket
is completely full, and a per-minute bucket is full again within about a minute. When a bucket
at 0 needs more than five minutes to refill, as with a daily requests or tokens limit, the
turn's retries (roughly five waits of up to 30 seconds) cannot outlast it: the proxy answers a
terminal 429 (`upstream_rate_limit`, `retryable: false`) with no `Retry-After`, and Codex ends
the turn with a rate-limit error instead of waiting out its retry budget. When no bucket is at
0, a long reset does not prove that the slower bucket is the one that refused, so that 429
stays retryable.

A streaming `/v1/responses` request, which is how Codex sends every request, gets a transient
rate limit as a stream failure instead. Codex does not retry an HTTP 429 by itself (its
`retry_429` is off for every provider), but it does retry a stream that fails with
`rate_limit_exceeded`, after the wait the failure's message names and within its stream retry
budget. The proxy therefore answers HTTP 200 with one server-sent `response.failed` event, then
`[DONE]`:

```json
{"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded",
  "message":"The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 5.734s."}}}
```

The wait is the `Retry-After` the 429 would have carried (the provider's own, the derived one,
or 5 seconds), clamped to 1-30 seconds and spread by up to 20% so that runtimes sharing one key
do not all retry at the same instant. The spread only lengthens a wait and never past 30
seconds; a `Retry-After` of 30 seconds or more spreads below 30 instead. The wait is stated to
the millisecond, the precision Codex reads back. The message keeps the `upstream_rate_limit`
code and the words the Studio and the runtime recognise. Only a transient rate limit changes: a
plan limit, a rate limit window too long to wait out, quota exhaustion and every other failure
keep their HTTP error, and a request that does not stream, every Chat Completions request
included, keeps the HTTP 429.

### Responses the upstream cuts short

The upstream can stop a response before it finishes, at `max_output_tokens` or by a content
filter for example. An API key's Responses upstream answers with `status: "incomplete"` and
`incomplete_details.reason`, and a ChatGPT login's stream ends with `response.incomplete`
instead of `response.completed`. The upstream has produced and billed that response by then.
Codex treats an upstream `response.incomplete` as a retryable stream error: it sends the same
request again, billed again to whoever owns the key and most likely stopped the same way, and
it runs any tool call the response carried, truncated arguments included. The proxy buffers the
whole upstream response before it answers, so on every lane, and on both routes that stream
(`/v1/responses`, and `/v1/chat/completions`, which streams the same Responses events), a
streaming client gets `response.completed` instead, never `response.failed`:

- An output item is finished when its status is `completed`, or when it has no status and is
  not the last item: the stop cuts off the last item, so that one is finished only when it says
  so. Every other item was cut off, such as an answer or a tool call with truncated arguments
  that the upstream finalized with status `incomplete`. On a ChatGPT stream, an item that was
  only added, and text that only streamed as deltas, were cut off too and never reach the
  output.
- When a finished tool call that Codex runs remains (a `function_call`, a `custom_tool_call`,
  or a `tool_search_call` with a `call_id` and `execution: "client"`), the response keeps only
  the finished items. Codex runs the call and continues on its own follow-up request, which
  hands the model the call's output.
- Otherwise the response keeps the finished items and any assistant message the stop cut off
  after some of its text arrived, with that text, and a notice the proxy adds,
  `The response was cut off before it finished (reason: <reason>).` The reason is the
  upstream's `incomplete_details.reason` when that is a reason code (1 to 64 lowercase letters,
  digits and `_`), and `unknown` otherwise. Codex takes the turn's last assistant message with
  text as the turn's answer, so the notice joins the last answer the response keeps, as an
  `output_text` part of its own after that answer's text, and the turn's answer is the text that
  arrived followed by the notice. Only when the response keeps no answer, or its last answer is
  commentary, is the notice an assistant message of its own, with the id `proxy-notice-` and
  the response id with each `_` written as `-`. Without a `_` it is not a prefixed item id, so
  Codex drops the id before it sends the message back and the upstream never sees an id it did
  not issue. Either way Codex records the output and ends the turn normally instead of sending
  the request again.
- A cut-off reasoning item or tool call never reaches the client.

The response keeps the upstream's `usage` either way, so Codex reports the turn's tokens as for
any completed turn and the controller reconciles the charge on them. A ChatGPT login's
subscription-usage report is sent as for a completed response. Each cut-short response logs one
`upstream response incomplete` line with its id, its reason as the notice gives it, what was
delivered (`tool_call` or `notice`) and how many items were kept, never their content.

A request that does not stream gets the response as the upstream reported it, with
`status: "incomplete"` and its `incomplete_details`, as the Responses API answers without a
stream; on a ChatGPT login its output holds the items the stream finished, including one the
upstream finalized as `incomplete`. A non-streaming Chat Completions request gets the text the
response has, with `finish_reason` `content_filter` for a filtered response and `length` for
any other reason. Responses from a Chat Completions or Gemini Code Assist upstream are adapted
as completed ones, as before.

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
`cargo test --test proxy_cut_short` pins, the same way, the exact events a streaming client
gets for a cut-short response and for a transient rate limit on each lane.

## Next steps

- Extend the proxy to handle streaming responses.
- Support additional OpenAI options (tool calls, caching hints, etc.).
- Add structured logging for observability.
