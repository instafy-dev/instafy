# Runtime flavors (pinned)

Never prune: yes

Instafy can run multiple “runtime-agent” images (flavors). Keep the base image small, and opt into heavier toolchains only when needed.

## Flavors

- **base**: Rust `runtime-agent` + tunnel helper (`rathole`). Best for general code/file edits.
- **webdev**: base + Node.js + npm/npx (+ `corepack`/pnpm) + Playwright tooling. Use when the task requires running JS builds/tests or Playwright (e.g. `pnpm`, `npm`, `npx playwright`, `playwright test`).

## When to switch

Switch to **webdev** if you need any of:
- `pnpm install/build/test`
- `npm/npx` workflows
- `playwright` CLI / browser automation

Default to **base** otherwise (faster cold starts, smaller images).

## How to switch runtimes (hosted)

Principle: you can’t “upgrade” an already-running runtime container/VM in-place; instead you **ensure a new runtime** with the desired image, then **set runtime preference** so future runs target it.

Typical flow (via Instafy CLI):
1) Ensure a new runtime (pass the image in runtime metadata):
   - `instafy api post "/runtime/ensure" --json '{"project_id":"<projectId>","provider":"<providerId>","metadata":{"runtimeAgentImage":"<imageRef>"}}'`
2) Set it as the preferred runtime for the project:
   - `instafy api post "/projects/<projectId>/runtime/preference" --json '{"runtimeId":"<runtimeId>","source":"agent:webdev"}'`
3) Optionally stop the old runtime if it’s no longer needed:
   - `instafy api post "/runtime/stop" --json '{"runtime_id":"<oldRuntimeId>","reason":"switched to webdev runtime"}'`

Always ask for confirmation before switching if the user didn’t request it explicitly (switching can burn time/credits).

## Hetzner allocator note

For Hetzner-backed providers, the cloud-init user-data template should support `{{RUNTIME_AGENT_IMAGE}}`, and the controller/provider metadata should provide `runtimeAgentImage` so the allocator can substitute the correct container image at provision time.
