# Voice Operator Guide

This is the practical runbook for provider-backed Instafy voice across Studio chat,
provider-owned surfaces, phone clients, and a Mac-hosted speech service.

## Current Shape

Voice is not a standalone conversation route. Product voice entrypoints are:

- the inline Studio chat composer voice control
- provider-owned conversation speech
- shared speech backend settings in `Settings -> Project -> AI`

The speech provider contract is shared across host modes:

- `Desktop`: the intended local product path. After the user enables the Mac as a speech host, Instafy Desktop starts and supervises the local speech service plus provider host.
- `CLI`: the explicit developer/operator path, mainly for local debugging and smoke tests.
- `server`: the remote/shared host path using the same provider contract.

## Route Preference

Voice route preference is shared per project through the project `speech` integration metadata.

Use `Settings -> Project -> AI` to confirm whether the selected route is direct, tunneled, unavailable, or falling back to this device. In Desktop, the same card also reports local host lifecycle state and exposes repair/restart actions.

The Studio top bar shows compact Desktop voice readiness so operators can see whether the host is `ready`, `syncing`, or needs repair without opening Settings.

## Interaction Modes

Studio chat supports:

- `Hold to talk`
- `Tap to talk`
- `Continuous`, when provider-backed hosted capture is available

Continuous mode is foreground-only. It starts one turn, stops after a real speech pause, submits the transcript, waits for the assistant reply cycle, then listens again. If the app leaves the foreground, Instafy pauses or resumes according to platform rules instead of pretending it is always listening.

Wake-word detections are surfaced as trigger candidates in Studio chat when a connected audio provider emits them. They stay foreground-only and require explicit arming per space.

## Useful Commands

- `pnpm test:chat:voice:speech`: browser proof for inline Studio chat voice.
- `pnpm test:voice:tunnel:smoke`: local tunnel smoke for speech transport.
- `pnpm test:voice:release`: canonical browser voice lane.
- `pnpm test:desktop:voice:host`: Desktop local-host proof.
- `pnpm test:desktop:voice:host:bootstrap`: clean-install Desktop host bootstrap proof.
- `pnpm test:voice:release:desktop`: browser voice lane plus Desktop host proofs.

## Local Development

1. Start the local stack:

```bash
pnpm stack:up
```

2. Start either:

- Instafy Desktop for the product path
- `pnpm dev:speech-service` for the explicit CLI/operator path

3. Run the smallest relevant proof:

```bash
pnpm test:chat:voice:speech
pnpm test:desktop:voice:host
```

## Self-hosted speech backends

The default local path transcribes with `insanely-fast-whisper` plus `ffmpeg` and synthesises with
macOS `say`. Check and install those host dependencies with:

```bash
pnpm speech:bootstrap:check
pnpm speech:bootstrap:install
```

`pnpm speech:fixtures:check` writes deterministic audio into
`packages/frontend/test-results/speech-fixtures` and round-trips it through the speech provider, so
STT/TTS regressions are catchable without a human listening.

To check strictly against real HTTP backends rather than the macOS fallback:

```bash
pnpm dev:speech-tts-proxy
export LOCAL_SPEECH_TTS_BACKEND_URL=http://127.0.0.1:8799/v1/audio/speech
export LOCAL_SPEECH_TRANSCRIPTION_BACKEND_URL=http://127.0.0.1:8799/v1/audio/transcriptions
pnpm speech:strict-roundtrip:check
```

The proxy serves both `/v1/audio/speech` and `/v1/audio/transcriptions`, and the doctor derives the
transcription endpoint when only the synthesis URL is set. It resolves credentials from
`OPENAI_API_KEY`, then `.env.openai` at the repo root, then `tmp/proxy-codex/auth.json`, then
`~/.codex/auth.json`.

`pnpm speech:tts:probe` is the cheap check of whether the configured backend can synthesise at all,
and verifies both endpoints in one pass. When a backend cannot synthesise, the doctor reports
`synthesis.engine = "proxy"`, `synthesis.installState = "backend_probe_failed"` and
`synthesis.strictRoundtripSupported = false`.

If your backend exposes a dedicated voices endpoint, set `INSTAFY_SPEECH_VOICES_URL` so the host
discovers real voices instead of inferring `/voices` from the synthesis URL. Per-space routing lives
in `Project settings -> AI overrides` (`Auto`, `Speech provider`, or `This device`).

## Troubleshooting

- If microphone permission still says blocked after approving macOS access, click `Request again` in the same chat surface so the browser permission can update too.
- If Android reply playback fails with `no supported source`, verify the speech service returns `audio/wav` or `audio/mpeg`, not `audio/aiff`.
- If the phone still points at `127.0.0.1`, the build picked up a direct local env instead of the tunnel base URL.
- `pnpm test:voice:doctor` tells you which lane is runnable from the current machine before starting heavier validation.
- If the inline hands-free notice says `Foreground only` or `Paused in background`, that is the product truth for the current client even if the speech backend itself is healthy.
