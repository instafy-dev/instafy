# Voice TODO

This document tracks the current voice product shape and the remaining useful work. Voice should feel like one coherent capability inside the normal Instafy surfaces, not a separate product route.

## Current Shape

Shipped voice surfaces:

- inline Studio chat voice capture
- provider-owned runtime speech
- shared project speech backend settings
- Desktop-managed local speech/provider host
- provider-backed transcription and reply playback
- browser or native fallback when provider-backed speech is unavailable

Removed product surface:

- standalone voice conversation route

## Direction

Keep the voice stack provider-first:

- Route by capability family such as `speech`, `camera`, or `robot`, not bespoke frontend routes.
- Keep speech-route selection in project metadata with browser/local fallback only when metadata is unavailable.
- Keep Desktop, CLI, and server hosts on the same provider contract.
- Keep conversation memory and reply playback attached to the active chat or mounted agent surface.

## Architecture Layers

1. Interaction surface: Studio chat and provider-owned speech controls start/stop voice turns and show permission/listening/transcribing/responding state.
2. Capture host: browser/native microphone capture, hosted capture helpers, and permission recovery.
3. Speech backend selection: provider-backed speech, configured HTTP transcription, local Desktop host, tunnel route, or device fallback.
4. Cross-device connectivity: direct reachability first, Instafy tunnel when direct access is missing.
5. Conversation/reply layer: submit transcript into the active conversation, keep normal assistant routing, and play the reply through the selected backend.

## Product Gaps

- Improve copy for direct vs tunneled vs fallback speech without exposing raw network details.
- Tighten foreground/background voice state copy as real platform constraints appear.
- Decide whether wake-word support should remain foreground/manual or become a larger explicit product mode.
- Improve Desktop repair UX only if real operators hit dependency drift or repeated warmup failures.
- Keep settings concise: one place for route preference, voice readiness, tunnel/debug state, and fallback status.

## Implementation TODO

- Keep route status aligned across Settings, Studio chat, and provider-owned surfaces.
- Keep provider diagnostics explicit about whether the active route is local, tunneled, warming, or fallback.
- Avoid new page-local voice orchestration; use the shared speech hooks and provider route model.
- Keep the voice UI inside the active product surface unless a new concrete user need justifies another surface.
- Keep microphone permission recovery available inline where the user started voice.

## Testing

Keep these lanes green:

- `pnpm test:chat:voice:speech`
- `pnpm test:voice:tunnel:smoke`
- `pnpm test:voice:doctor`
- `pnpm test:voice:release`
- `pnpm test:desktop:voice:host`
- `pnpm test:desktop:voice:host:bootstrap`
- `pnpm test:voice:release:desktop`

Prefer the smallest relevant proof while iterating. Run the full release lane only when the change touches shared voice routing, hosted capture, Desktop host lifecycle, or speech backend selection.
