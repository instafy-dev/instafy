# Instafy Studio Docs

These docs reflect the current product scope: a chat-first filesystem workspace with credits and billing. Preview/publish/custom domains are intentionally out of scope right now.

## Maps
- Product overview: `docs/Product.md`
- Brand colors, logo variants, and asset rules: `docs/Brand.md`
- Scheduled automations and quiet runs: `docs/Automations.md`
- Scoped search, message excerpts and exact-message navigation: [Studio search](Studio-Search.md)
- Durable notification center, push delivery, and verification: [Notifications](Notifications.md)
- Runtime architecture: `docs/Architecture.md`
- Runtime pooling plan (shared vs dedicated): `docs/runtime-plan-shared-vs-dedicated.md`
- Git-canonical storage: `docs/Git-Service.md`
- Sharing, invitations, roles, and device handoff: `docs/Sharing-Permissions.md`
- Multi-human + Octo participation: `docs/Group-Conversation-Participation.md`
- Chat-first onboarding + benchmarking: `docs/Onboarding-Benchmarking.md`
- /learn and benchmark system: `docs/Learn-Benchmarking.md`
- Multi-agent evaluation: `docs/Multi-Agent-Evaluation.md`
- AI-driven diagnostics and support consent: `docs/Agent-Diagnostics.md`
- npm package versioning and release automation: `docs/Package-Releases.md`
- Credits and billing: `docs/Credits-Billing.md`
- Local development: `docs/Local-Dev.md`
- Testing: `docs/Testing.md`
- Camera operator guide: `docs/Camera-Operator.md`
- Voice operator guide: `docs/Voice-Operator.md`
- Voice TODO: `docs/Voice-TODO.md`
- CLI: `docs/CLI.md`
- Capacitor (mobile/desktop packaging): `docs/Capacitor.md`
- OTA rollout: `docs/OTA-Rollout.md`
- OTA control plane: `docs/OTA-Control-Plane.md`
- Desktop updater: `docs/Desktop-Updater.md`
- Shared Browser native shell and streaming boundary: `docs/Shared-Browser.md`
- Browser profiles, cookie sharing, and clearing scope: `docs/Browser-Profiles.md`
- Shared Browser origin scopes and transport boundary: `docs/Shared-Browser-Authorization.md`
- Personal Browser desktop architecture and security boundary: `docs/Personal-Browser.md`
- Private self-hosted ownership and future Team runtime boundary: `docs/Self-Hosted-Runtime-Security.md`
- Space bootstrap template (seeded into new workspaces): `packages/runtime-agent/assets/instafy/INSTAFY.md`

## Debugging Entry Points

Use the environment-specific path instead of mixing tools across surfaces:

- Web / Playwright:
  - `pnpm test:e2e`
  - `pnpm test:e2e:smoke`
  - `pnpm test:e2e:headed`
  - Details: `docs/Testing.md`
- Camera / multi-device:
  - `pnpm test:camera:tri-client:smoke:recommended`
  - `pnpm test:camera:tri-client:smoke:ios-simulator`
  - `pnpm test:camera:tri-client:smoke:desktop-provider:ios-simulator`
  - `pnpm test:camera:tri-client:smoke:two-devices`
  - `pnpm --dir packages/frontend test:android:camera:smoke`
  - `pnpm test:ios:camera:smoke`
  - Details: `docs/Testing.md`, `docs/Capacitor.md`
- Voice / speech provider:
  - `pnpm test:voice:release`
  - `pnpm test:voice:release:desktop`
  - `pnpm test:voice:doctor`
  - `pnpm test:voice:tunnel:smoke`
  - `pnpm test:chat:voice:speech`
  - `pnpm test:desktop:voice:host`
  - `pnpm test:desktop:voice:host:bootstrap`
  - `pnpm test:speech:server:smoke`
  - Details: `docs/Voice-Operator.md`, `docs/Voice-TODO.md`
- Android / Capacitor:
  - `pnpm test:android:build`
  - Details: `docs/Capacitor.md`
- iPhone physical device:
  - `pnpm ios:device:status`
  - `pnpm ios:device:launch`
  - `pnpm ios:device:webview -- --json`
  - `pnpm ios:device:uitest`
  - `pnpm ios:device:capture`
  - `pnpm test:ios:camera:smoke`
  - Details: `docs/Capacitor.md#physical-device-debugging`

## Keep In Sync
Update these docs whenever you change runtime orchestration, credits/billing flows, or the Studio surface (Assistant, Files, Credits).
