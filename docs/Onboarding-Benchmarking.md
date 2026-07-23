# Chat-First Onboarding & Benchmarking

Instafy should treat onboarding as a conversation contract, not a separate product maze.

## Product contract

The canonical user flow is:

- The user types a repo intent in chat, for example:
  - `Continue working on my project https://github.com/org/repo`
  - `Import github.com/org/repo`
  - `Open this repo and help me fix the tests`

The system should then:

1. Treat the current space as the target workspace.
2. Import the repo into the current space.
3. If access is missing, trigger GitHub onboarding and then retry the same repo intent in the same space.

Dedicated onboarding UI may still exist, but only as a shortcut surface. It should not contain a separate decision tree from the chat flow.

Cross-space repo reuse is intentionally out of scope here. Spaces are isolation boundaries; a repo prompt should not silently jump the user into another space just because the same repo exists elsewhere on the team.

### First-screen contract

The empty conversation should be task-first and usable without completing a wizard:

- Keep the composer active so experienced users can type their intent immediately. A draft may temporarily hide the AI-choice surface, but must not persist onboarding as completed.
- When the user has no personal AI connection, offer both explicit routes immediately:
  - **Start with included Instafy AI**, using the live daily allowance returned by the controller.
  - **Connect AI I already pay for**, opening the existing AI connection wizard at provider selection.
- Do not repeat these AI choices for a user who already has a personal AI connection.
- Persist a settled included-AI choice as an insert-only per-user/project record so another
  signed-in device adopts it without a lossy client metadata merge. Local storage is only the
  optimistic/offline cache; a failed durable write retries while the choice remains relevant.
- An empty server-created conversation is still empty. A controller conversation id by itself must not suppress the first-run experience; only meaningful message history or an explicit dismissal may do that.
- Do not show the large **Choose your AI** surface when a person enters a known multi-human conversation with AI disabled. This is a human-collaboration entry point, not an AI-onboarding entry point. For a public conversation, consider permission-filtered project peers and already-authorized organization peers as well as people who have already opened the conversation, so the owner-first state does not flash the card. Direct-project guests must not trigger protected organization-directory requests. Preserve the two explicit choices for single-user and AI-enabled conversations when the user lacks a settled personal AI connection; an explicit `@octo` turn still opens the intent-scoped AI setup path when needed.
- AI requirement discovery runs in the background and must not lock or dim the composer.

Interest/task starters stay collapsed behind a user-invoked **Need ideas?** disclosure. They must not render automatically just because the conversation is empty. Opening one only prefills the same composer; it does not create a separate mandatory onboarding path. Once AI access is settled, the collapsed disclosure is the only remaining first-run guidance.

## Private-repo fallback

When repo access fails because GitHub auth or scope is missing:

- Prefer GitHub device auth / integration onboarding over asking for pasted tokens in chat.
- After GitHub auth completes, retry the original repo action instead of forcing the user into a new flow.
- Keep follow-up prompts minimal and explicit.

This keeps the UX small while still making private onboarding obvious.

## Hosted import durability

Hosted GitHub import must be durable, not just locally applied.

Expected hosted flow:

1. Download GitHub zipball.
2. Repack and apply into the workspace through Origin `/apply`.
3. Baseline commit locally.
4. If git-canonical is configured, follow with Origin `/git/sync` so the imported state is pushed to canonical history.

If step 4 is skipped, onboarding can appear successful while the imported files are not yet durable in canonical git.

## Benchmark goals

We care about the time it takes for a user to become productive, not just the time it takes to finish a backend task.

Primary metrics:

- `prompt_to_first_file_visible_ms`
  - from sending/importing the repo intent to the first imported file being readable in the workspace
- `prompt_to_import_complete_ms`
  - from repo intent to the controller import response completing
- `prompt_to_canonical_durable_ms`
  - from repo intent to the imported file being readable from the canonical git remote

Secondary metrics:

- `runtime_ready_ms`
  - if hosted runtime/origin startup is part of the path
- `auth_recovery_ms`
  - if private onboarding required GitHub device auth
- `second_user_conversation_visible_ms`
  - from repo intent to the shared conversation becoming visible for another teammate in the same project
- `second_user_file_visible_ms`
  - from repo intent to another teammate being able to open an imported file from the same shared space

## Benchmark matrix

Benchmark these cases separately:

- Public repo, first import
- Private repo, first import with GitHub device-auth fallback
- Small repo
- Medium repo
- Large repo / monorepo
- Whole repo import
- Subfolder-focused import
- Default branch import
- Explicit branch/ref import
- One team, two users, one shared project/space
  - user 1 imports by chat prompt
  - user 2 is already idle in the same space
  - both users should see the shared conversation update
  - both users should be able to open the imported file tree
  - canonical git should contain the same imported file content

## Coverage plan

Minimum required coverage:

- Correctness smoke: imported files are visible locally after onboarding
- Durability smoke: imported files are visible in canonical git after onboarding
- Auth fallback smoke: private repo path requests GitHub onboarding when access is missing
- Human-only shared entry: no AI-choice card or flash while conversation participants and public project/org peers load, including owner-first and invitee-first entry; direct-project guests never enumerate the protected org directory
- Regression boundaries: single-user and AI-enabled conversations retain the intended first screen, while explicit `@octo` still enters AI setup when credentials are missing

Current foothold:

- Playwright smoke coverage now includes both:
  - direct controller import durability
  - chat-first repo-link import durability
- A hermetic Playwright bench now also exists for large public repos:
  - `packages/frontend/tests/playwright/bench/github-import-chat-bench.spec.ts`
  - default repo: `astral-sh/uv`
  - default metrics:
    - `prompt_to_import_complete_ms`
    - `prompt_to_first_file_visible_ms`
    - `prompt_to_canonical_durable_ms`
- Shared-space collaboration coverage now also includes:
  - one user importing by chat prompt
  - a second user observing the same shared conversation in the same project
  - both users opening the imported file through the Files panel
  - canonical durability verification against the git remote
- Auth fallback smoke now checks that a private/access-restricted repo prompt turns into a GitHub connect card in chat.
- Durability smokes should measure and assert:
  - the repo intent/import succeeds
  - at least one imported file becomes readable
  - canonical git remote contains the same imported file content

## Anti-bloat rule

Do not add new dedicated onboarding UI unless the same behavior cannot be expressed as:

- a chat intent
- a small skill/policy rule
- a reusable backend/import primitive
- a thin action-card fallback for auth/consent

If a proposed onboarding step only exists because the system cannot yet resume or retry intelligently, prefer fixing the primitive first.

## Standard public-repo bench

Default command:

```bash
PLAYWRIGHT_RUN_BENCH=1 \
PLAYWRIGHT_ONBOARDING_BENCH_REPO=astral-sh/uv \
pnpm -C packages/frontend test:e2e -- \
  tests/playwright/bench/github-import-chat-bench.spec.ts \
  --max-failures=1
```

Notes:

- This bench is intentionally hermetic.
- It cleans up the created project/workspace/canonical repo after the run instead of keeping benchmark artifacts in the workspace.
- The JSON result is written into the Playwright output directory for that run.

## Hosted benchmark boundary

The public benchmark harness assumes local, disposable state and must not be pointed at a live
deployment. A hosted benchmark runner needs independently reviewed authentication, project-scoped
cleanup, and safeguards that prevent global setup/teardown from mutating unrelated resources.
Deployment-specific endpoints, identities, and invocation are maintained separately.

## Credential reuse

For local benches:

- Playwright treats the maintained `~/.codex/auth.json` from `codex login` as the canonical local subscription login; it does not require a pre-existing proxy mirror
- the Codex backend preflight copies that file into a disposable auth directory with directory mode `0700` and `auth.json` mode `0600`, mounts the copy into its temporary proxy, and removes it afterward, so proxy token refresh cannot mutate the canonical login
- when an application-facing test user needs Codex, Playwright sanitizes the subscription auth JSON and provisions it as that user's controller-scoped credential; default BYO/`remote_dynamic` routing therefore exercises user credential enforcement rather than a generic application-proxy auth mirror
- `tmp/proxy-codex/auth.json` remains only a fallback when the canonical login is unavailable; `OPENAI_API_KEY` is the no-file fallback for the isolated preflight

For any external benchmark, authenticate independently and reuse a credential already connected to
that disposable test account. Never copy a developer's local Codex authentication into a hosted
environment.
