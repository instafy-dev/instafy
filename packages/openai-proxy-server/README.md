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
| `CONTROLLER_INTERNAL_TOKEN` | Service bearer used for controller credit events | `None` |
| `PROXY_CREDENTIAL_LEASE_TOKEN` | Dedicated bearer used only for controller credential leases | `None` |
| `CODEX_PROXY_CHATGPT_ENDPOINT` | Upstream ChatGPT Codex Responses endpoint | `https://chatgpt.com/backend-api/codex/responses` |

`CODEX_OPENAI_ENDPOINT` can also point at an OpenAI-compatible Chat Completions endpoint (e.g. `.../chat/completions`). When it does, the proxy will call that upstream endpoint and adapt the result into an OpenAI Responses-shaped payload for downstream callers.

Standalone local mode may read and refresh the operator's own `auth.json`. In
controller-integrated mode, the controller is the only refresh-token authority: the proxy gets a
short-lived access/API-key lease and never receives the stored refresh token.

## Tests & formatting

Run the standard checks before committing changes:

```bash
cargo fmt
cargo test
```

The backend smoke test will automatically skip if credentials are missing or the backend rejects the request (e.g., rate limits).

## Next steps

- Extend the proxy to handle streaming responses.
- Support additional OpenAI options (tool calls, caching hints, etc.).
- Add structured logging for observability.
