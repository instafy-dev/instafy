# Codex adapter

This workspace package holds Instafy-maintained scripts and notes for the upstream `codex/` git submodule.

Why this exists:
- Keep the `codex/` submodule clean (no local changes inside the submodule).
- Provide stable `pnpm` entrypoints for updating/verifying Codex without memorizing `git submodule` commands.

Common commands:
- `pnpm --filter @instafy/codex-adapter codex:status`
- `pnpm --filter @instafy/codex-adapter codex:update`
- `pnpm --filter @instafy/codex-adapter codex:verify:e2e`

