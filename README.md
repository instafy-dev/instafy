# Instafy

Instafy is an open-source, self-hostable AI agent workspace. It gives agents a real project
filesystem and gives people a browser, Desktop app and CLI for chatting, reviewing changes and
editing files.

The public repository contains the complete product core: the React workspace, runtime controller
and agent, AI proxy, CLI, Desktop shell, mobile shells, database migrations and local deployment
tools. Optional product integrations and hosted operations compose on top of the same public
interfaces.

## Quick start

You need Node.js 20+, pnpm 10, Git and Docker.

1. Install the workspace:
   ```bash
   corepack enable
   pnpm install --frozen-lockfile
   ```
2. Copy the browser-safe frontend template:
   ```bash
   cp packages/frontend/.env.example packages/frontend/.env
   ```
3. Start the local Supabase stack:
   ```bash
   pnpm supabase:up
   ```
   The command applies the public migrations and prints the local URL and browser-safe anon key.
   Put those values in `packages/frontend/.env`. Keep controller, proxy, service-role and AI
   credentials in server-only environment variables or a secret manager.
4. Launch Instafy:
   ```bash
   pnpm dev
   ```
5. Run the public checks:
   ```bash
   pnpm --filter @instafy/frontend test:unit
   pnpm --filter @instafy/cli test:package
   ```

Run `pnpm supabase:down` when you are finished. For the controller, agent, proxy, Desktop,
mobile and end-to-end workflows, continue with the
[Developer Environment Guide](DEV_SETUP.md).

## Documentation Map
- [Developer Environment Guide](DEV_SETUP.md)
- [Agent Handbook](AGENTS.md)
- [Product Overview](docs/Product.md)
- [Automations](docs/Automations.md)
- [Runtime Architecture](docs/Architecture.md)
- [Credits & Billing](docs/Credits-Billing.md)
- [Local Development](docs/Local-Dev.md)
- [Testing](docs/Testing.md)
- [Package Releases](docs/Package-Releases.md)
- [Documentation Hub](docs/README.md)

Keep the documentation hub open while you work; it links to every playbook and should be updated alongside your code changes.

## Debugging Quick Map

Use the shortest path for the surface you are debugging:

For Camera/provider work, treat the current recommended multi-device lane as:

- `pnpm test:camera:tri-client:smoke:recommended`

Use the stronger camera lanes only when the change specifically needs them:

- Android native capture only:
  - `pnpm --dir packages/frontend test:android:camera:smoke`
- Full physical Android + iPhone proof:
  - `pnpm test:camera:tri-client:smoke:two-devices`

- Web Studio / browser flows:
  - `pnpm test:e2e`
  - `pnpm test:e2e:smoke`
  - `pnpm test:e2e:headed`
  - See [Testing](docs/Testing.md)
- Anything behind the login wall — mint a throwaway user instead of signing in by hand:
  - `node scripts/mint-test-user.mjs --json` prints a session plus the exact `localStorage` key and
    value the frontend reads, so a browser lands authenticated
  - `node scripts/mint-test-user.mjs --cleanup-all-test-users` removes what it created
  - Local stack only unless given two explicit opt-ins; see [Agent Handbook](AGENTS.md)
- Android app / native mobile flows:
  - `pnpm test:android:build`
  - `pnpm test:camera:tri-client:smoke:recommended`
  - `pnpm --dir packages/frontend test:android:camera:smoke`
  - See [Capacitor](docs/Capacitor.md)
- iPhone physical-device flows:
  - `pnpm ios:device:status`
  - `pnpm ios:device:launch`
  - `pnpm ios:device:webview -- --json`
  - `pnpm ios:device:uitest`
  - `pnpm ios:device:capture`
  - `pnpm test:ios:camera:smoke`
  - See [Capacitor](docs/Capacitor.md#physical-device-debugging)

If a change crosses browser, Android, and iPhone, use the matching surface-specific path instead of guessing from one environment.

## Speech and voice

Provider-owned conversation surfaces route speech through the same host speech service Studio uses,
rather than each surface owning its own STT/TTS stack. On desktop the local provider host exposes a
first-party `speech` provider that reports dependency status, bootstraps host dependencies, and
routes mounted-runtime speech through a local service, a tunnelled remote service, or a
browser/native fallback.

```bash
pnpm speech:bootstrap:check   # what is installed and runnable here
pnpm dev:speech-service       # the explicit CLI/operator path
```

Backend setup, strict round-trip checking against real HTTP backends, and troubleshooting live in
the [Voice Operator Guide](docs/Voice-Operator.md).

## Supabase

For local work, `pnpm supabase:up` from the Quick start is all you need: it starts the stack,
applies `supabase/migrations/`, and prints the URL and anon key.

To apply the same migrations to your own isolated, non-production hosted project:

```bash
npx supabase link --project-ref <ref>
pnpm dev:supabase:release
pnpm test:e2e            # proves the chat + filesystem loop against it
```

If that project needs hosted secrets, set them from an env file you keep outside the repository
(`npx supabase secrets set --env-file <your-file>`); none is committed here.

Hosted production migrations are intentionally outside this path. Keep them pinned, reviewed, and
separate from `pnpm dev:supabase:release`.

## Distribution boundary

The public repository contains the source, local build tools, OTA packaging primitives, and
verification commands. Store signing identities and publishing credentials outside the repository,
and configure your own artifact host and release automation. Instafy's hosted signing, publication,
promotion, and production migration procedures are maintained separately.

## Key Workflows

### Supabase & GitHub
- Browser builds use only the Supabase URL and anon key. Service-role credentials are server-only
  and must stay out of Vite, browser bundles, logs, and committed env files.
- GitHub repository import is active in Studio and the runtime controller. Public repos import without GitHub auth; private repos use GitHub device-code auth when `GITHUB_DEVICE_AUTH_CLIENT_ID` is configured.
- Broader GitHub workflow automation is still out of scope for this release. Issue/PR/release automation should not be treated as shipped repo sync.

### AI Providers
- Managed AI turns are served by OpenAI (the controller pins `CODEX_MODEL_PROVIDER=openai`; the model comes from `MANAGED_AI_MODEL_ID`, default `gpt-5.5`).
- BYOC lets users bring their own provider instead: an OpenAI API key or ChatGPT device-code login, DeepSeek, z.ai, or Gemini.
- All controller-driven automation **must route through the Instafy AI proxy**. Set `PROXY_BASE_URL` and `PROXY_SIGNING_SECRET` in your environment, and ensure any CLI agents (including the Codex runner inside dev containers) call the proxy endpoint instead of OpenAI directly so credit debits and BYO keys are enforced.

### Testing & QA
- `pnpm test:e2e` — core Playwright suite (auto-starts Vite).
- `pnpm test:e2e:headed` — headed debugging.
- `pnpm test:e2e:status` / `pnpm test:e2e:stop` — check/kill a running e2e job (pidfile-backed).
### GitHub
Studio can import GitHub repositories into the current space through the project launcher or chat-first repo prompts. This import path brings repo files into the workspace; it is separate from broader GitHub automation such as issue/PR workflow orchestration.

## Repo Scripts
- `pnpm dev` — launch the Vite frontend.
- `pnpm supabase:up` / `pnpm supabase:down` — start/stop the local Supabase stack + Postgres (applies migrations and prints connection info for `DATABASE_URL` / `TEST_DATABASE_URL`).
- `pnpm test:controller` — run `cargo test -p runtime-controller` with `TEST_DATABASE_URL` auto-populated from the running Supabase stack. If Supabase is not running yet, the wrapper starts it for you. Pass a focused test name the same way you would to `cargo test`, for example: `pnpm test:controller conversation_message_routes_preserve_inline_reference_content -- --nocapture`.
- `pnpm stack:check` — verify Supabase, the controller, and the runtime container are all running
  (returns non-zero otherwise).
- `pnpm deepseek:smoke` — safe DeepSeek API compatibility probe (sends a tiny prompt; reads `DEEPSEEK_API_KEY` from `.env.deepseek`).
- `pnpm zai:smoke` — safe z.ai API compatibility probe (sends a tiny prompt; reads `ZAI_API_KEY` from `.env.zai`).
- Runtime controller instances require a Redis instance (`REDIS_URL`, `REDIS_GENERATE_NAMESPACE`) so conversations can cache run results for replay in the Studio.
- When the controller is configured with shared storage (local workspace or AWS EFS), the Studio should consume
  file content via the project origin (e.g. HTTP origin `/entries`, `/files`, `/raw`). Large artifacts (images, logs)
  should be written to the workspace and referenced by path instead of being embedded in Redis or Supabase rows.
- Set `WORKSPACE_ROOT` for the controller to point at the shared workspace mount (local directory or EFS access
  point). If read-only compatibility routes are enabled, the controller restricts `/fs/*` access to
  `<WORKSPACE_ROOT>/<project_id>` so project data stays isolated.
- `pnpm sync:supabase-local` — sync `.env` values into the local Supabase stack.
- `pnpm dev:supabase:release` — apply SQL migrations to an isolated, non-production linked
  project. The current public tree contains no Supabase Edge Functions.

## Support
- Document new patterns in the relevant guide before merging.
- Use repository issues and discussions for public bugs, design questions, and roadmap proposals.

## License

Instafy's product core is licensed under the GNU Affero General Public License v3.0 — see
[LICENSE](LICENSE). Private deployments may add separately maintained product integrations,
branding and operational configuration without changing the public core's source of truth.
