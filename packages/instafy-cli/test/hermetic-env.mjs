// Runs before every test file (vitest.config.ts `setupFiles`). The CLI takes its server, session,
// space, conversation and runtime-job credentials from the environment, along with other settings
// that change what a command does, and most tests start it, or call its code, with the test
// process's environment. Inherited from a developer's shell, or from an Instafy runtime job that
// runs this suite, those would send a test's commands to a real controller or to Supabase, with a
// real token, or change their outcome. So they are removed here, and a test that needs one sets it
// itself.
//
// The two files with a live suite keep them when their own switch is on, since they then reach real
// services on purpose and read some of these themselves: test/tunnel-live.e2e.spec.ts with
// TUNNEL_E2E_LIVE=1, and test/runtime-tunnel.e2e.spec.ts with TUNNEL_BROKER_BASE_URL or
// VITE_TUNNEL_BROKER_BASE_URL. Every other file loses them even then: DEV_SETUP.md has developers
// export TUNNEL_BROKER_BASE_URL just to run a local tunnel broker.
import { expect } from "vitest";

const SESSION_AND_JOB_VARIABLES = [
  // The server, Studio, profile and saved session a command uses.
  "INSTAFY_SERVER_URL",
  "INSTAFY_URL",
  "INSTAFY_STUDIO_URL",
  "INSTAFY_PROFILE",
  "INSTAFY_CLI_CONFIG",
  // Credentials that replace the saved session, and the email login that signs in on its own.
  "INSTAFY_ACCESS_TOKEN",
  "SUPABASE_ACCESS_TOKEN",
  "INSTAFY_SERVICE_TOKEN",
  "INSTAFY_LOGIN_EMAIL",
  "INSTAFY_LOGIN_PASSWORD",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_PROJECT_URL",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  // The space and conversation, which take precedence over a folder's binding.
  "SPACE_ID",
  "INSTAFY_SPACE_ID",
  "PROJECT_ID",
  "INSTAFY_PROJECT_ID",
  "CONTROLLER_SPACE_ID",
  "CONVERSATION_ID",
  "INSTAFY_CONVERSATION_ID",
  // A runtime job's or machine's own credentials and controller, which commands switch to.
  "RUNTIME_ID",
  "RUNTIME_LEASE_ID",
  "LEASE_ID",
  "RUNTIME_ACCESS_TOKEN",
  "CONTROLLER_ACCESS_TOKEN",
  "CONTROLLER_BASE_URL",
  "ORIGIN_ACCESS_TOKEN",
  "ORIGIN_INTERNAL_TOKEN",
  "ORIGIN_ENDPOINT",
  "ORIGIN_ID",
  "ORIGIN_GIT_REMOTE_URL",
  "AGENT_KEY",
  "AGENT_LOGIN_KEY",
  "WORKSPACE_DIR",
  "WORKSPACE_PROJECT_DIR",
  // A turn's limits, its shared research state and the job's cache, and other services the CLI dials.
  "INSTAFY_TURN_STARTED_AT",
  "INSTAFY_TURN_DEADLINE",
  "INSTAFY_STEP_TIMINGS_FILE",
  "INSTAFY_RESEARCH_SHARED",
  "INSTAFY_RESEARCH_ACCESS_TOKEN",
  "INSTAFY_RESEARCH_CONTROLLER_URL",
  "INSTAFY_CACHE_DIR",
  "INSTAFY_PROVIDER_HOST_URL",
  "LOCAL_PROVIDER_HOST_URL",
  "INSTAFY_TUNNEL_SERVER_HOST",
  "INSTAFY_GIT_HOSTS",
  // Settings that change what a command does or prints: the binder and tunnel client it runs, the
  // ports a preview may use, chat's default wait, timeouts, offline web pages (which the built CLI
  // refuses) and forced colour.
  "INSTAFY_BIND_BIN",
  "RATHOLE_BIN",
  "INSTAFY_PREVIEW_DENY_PORTS",
  "INSTAFY_CHAT_WAIT_BY_DEFAULT",
  "INSTAFY_HTTP_TIMEOUT_MS",
  "INSTAFY_MCP_CALL_TIMEOUT_MS",
  "INSTAFY_WEB_FIXTURES",
  "FORCE_COLOR",
  "CLICOLOR_FORCE",
];

// The file this setup runs for, and each live suite's own gate, as the file writes it.
const testFile = expect.getState().testPath ?? "";
const brokerBaseUrl = (process.env.TUNNEL_BROKER_BASE_URL ?? process.env.VITE_TUNNEL_BROKER_BASE_URL ?? "").trim();
const live =
  (/[\\/]tunnel-live\.e2e\.spec\.ts$/.test(testFile) && process.env.TUNNEL_E2E_LIVE === "1") ||
  (/[\\/]runtime-tunnel\.e2e\.spec\.ts$/.test(testFile) && Boolean(brokerBaseUrl));
if (!live) {
  for (const name of SESSION_AND_JOB_VARIABLES) delete process.env[name];
}
