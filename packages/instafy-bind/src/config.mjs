// Controller URL, access token, conversation and space, resolved like the Instafy CLI (`instafy chat`).
// The token is kept on a non-enumerable property so logging or serialising the config never prints it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialFreeEnv } from "./detached-env.mjs";

export const DEFAULT_CONTROLLER_URL = "http://127.0.0.1:8788";

const clean = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || ["null", "undefined"].includes(trimmed.toLowerCase())) return null;
  return trimmed;
};
const normalizeUrl = (value) => clean(value)?.replace(/\/$/, "") ?? null;

function originOf(raw, label) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error(`${label} must use http(s) and must not contain credentials`);
  }
  return url.origin;
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Nearest .instafy/space.json from cwd upwards (the CLI's project manifest). */
export function findSpaceManifest(cwd) {
  let current = path.resolve(cwd);
  for (;;) {
    const file = path.join(current, ".instafy", "space.json");
    if (fs.existsSync(file)) {
      const parsed = readJson(file);
      const spaceId = clean(parsed.spaceId) ?? clean(parsed.space_id);
      if (spaceId) return { ...parsed, spaceId, file };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve the controller connection.
 * Order (like the CLI, except for the runtime job credential):
 * - URL: --server-url, the runtime job binding (CONTROLLER_BASE_URL), INSTAFY_SERVER_URL, the CLI config, the default.
 * - Token: --access-token, INSTAFY_ACCESS_TOKEN, SUPABASE_ACCESS_TOKEN, then the CLI config's token when its saved
 *   origin matches. The runtime job credential (CONTROLLER_ACCESS_TOKEN) is never used: it stops working when the
 *   Octo turn that started `serve` ends, so a long-lived binder must not depend on it.
 * - The owner's conversation (parent of the site's thread): --conversation, INSTAFY_CONVERSATION_ID, CONVERSATION_ID.
 * - The agent conversation: --agent-conversation, INSTAFY_BIND_CONVERSATION_ID. Without it the binder creates the
 *   site's own thread in the space on the first agent intent.
 * - Space: --space, SPACE_ID, INSTAFY_SPACE_ID, PROJECT_ID, INSTAFY_PROJECT_ID, .instafy/space.json.
 */
export function resolveControllerConfig({
  serverUrl = null,
  accessToken = null,
  conversation = null,
  agentConversation = null,
  space = null,
  env = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
} = {}) {
  const manifest = findSpaceManifest(cwd);
  const profile = clean(env.INSTAFY_PROFILE) ?? clean(manifest?.profile);
  if (profile && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) throw new Error(`invalid Instafy profile "${profile}"`);
  const configFile = profile ? path.join(home, ".instafy", "profiles", `${profile}.json`) : path.join(home, ".instafy", "config.json");
  const stored = readJson(configFile);
  const conversationId = clean(conversation) ?? clean(env.INSTAFY_CONVERSATION_ID) ?? clean(env.CONVERSATION_ID);

  let runtime = null;
  // The runtime's job binding. Its token is never used (see above), so a binder started with --detach does not even
  // receive it (detachedBinderEnv); the binding is still recognised to say why agent intents are unavailable.
  if (clean(env.RUNTIME_ID) && conversationId && clean(env.CONTROLLER_BASE_URL)) {
    runtime = { controllerUrl: normalizeUrl(env.CONTROLLER_BASE_URL) };
    originOf(runtime.controllerUrl, "CONTROLLER_BASE_URL");
  }

  const controllerUrl =
    normalizeUrl(serverUrl) ?? runtime?.controllerUrl ?? normalizeUrl(env.INSTAFY_SERVER_URL) ?? normalizeUrl(stored.controllerUrl) ?? DEFAULT_CONTROLLER_URL;
  const origin = originOf(controllerUrl, "controller URL");

  let token = null;
  let tokenSource = "none";
  let note = null;
  if (clean(accessToken)) {
    token = clean(accessToken);
    tokenSource = "explicit";
  } else if (clean(env.INSTAFY_ACCESS_TOKEN)) {
    token = clean(env.INSTAFY_ACCESS_TOKEN);
    tokenSource = "env:INSTAFY_ACCESS_TOKEN";
  } else if (clean(env.SUPABASE_ACCESS_TOKEN)) {
    token = clean(env.SUPABASE_ACCESS_TOKEN);
    tokenSource = "env:SUPABASE_ACCESS_TOKEN";
  } else if (clean(stored.accessToken)) {
    const savedOrigin = normalizeUrl(stored.controllerUrl) ? originOf(normalizeUrl(stored.controllerUrl), "saved controller URL") : null;
    if (savedOrigin === origin) {
      token = clean(stored.accessToken);
      tokenSource = "config";
    } else {
      note = "the saved login belongs to a different controller; it is not used";
    }
  }

  if (!token && runtime) {
    tokenSource = "runtime-refused";
    note = "only the runtime job token is available; it stops working when this Octo turn ends, so agent intents need `instafy login` or INSTAFY_ACCESS_TOKEN";
  }

  const spaceId =
    clean(space) ?? clean(env.SPACE_ID) ?? clean(env.INSTAFY_SPACE_ID) ?? clean(env.PROJECT_ID) ?? clean(env.INSTAFY_PROJECT_ID) ?? manifest?.spaceId ?? null;
  const agentConversationId = clean(agentConversation) ?? clean(env.INSTAFY_BIND_CONVERSATION_ID);

  const config = { controllerUrl, tokenSource, hasToken: Boolean(token), conversationId, agentConversationId, spaceId, profile, configFile, note };
  Object.defineProperty(config, "token", { value: token, enumerable: false });
  return config;
}

/** Why the agent executor cannot dispatch, or null when it can. */
export function agentUnavailableReason(config) {
  if (config.tokenSource === "runtime-refused") return "the runtime job token ends with this Octo turn; run `instafy login` or set INSTAFY_ACCESS_TOKEN";
  if (!config.hasToken) return "no Instafy access token (run `instafy login`, or set INSTAFY_ACCESS_TOKEN)";
  if (!config.agentConversationId && !config.spaceId) {
    return "no space for the site's own Octo thread (pass --space, or --agent-conversation <id> to use an existing conversation)";
  }
  return null;
}

/** True when agent turns would go into the owner's own working conversation. */
export function agentUsesOwnerConversation(config) {
  return Boolean(config.agentConversationId && config.conversationId && config.agentConversationId === config.conversationId);
}

/** Credential names the binder itself reads as the owner's login (above). */
const BINDER_LOGIN_ENV = ["INSTAFY_ACCESS_TOKEN", "SUPABASE_ACCESS_TOKEN"];

/**
 * Why --agent-executor is refused here, or null. It treats a click from this machine's loopback as the owner's own,
 * which is only true on a single-user machine. An Instafy runtime (a job binding: RUNTIME_ID or CONTROLLER_BASE_URL)
 * is shared: other members' Octo turns run there and could click on the owner's login, so it fails closed.
 */
export function agentExecutorRefusal(env = process.env) {
  if (!clean(env.RUNTIME_ID) && !clean(env.CONTROLLER_BASE_URL)) return null;
  return "--agent-executor runs Octo turns on your own login for clicks from this machine, so it needs a machine only you use; this is a shared Instafy runtime (RUNTIME_ID or CONTROLLER_BASE_URL is set). Ask Octo works without it: clicks in Studio are sent as the clicker's own message";
}

/**
 * The environment of a binder started with `serve --detach`: `credentialFreeEnv` (no runtime job token or other
 * CONTROLLER_* secret, no SUPABASE_* service values, no credential-like names such as space secrets), except names
 * passed with --allow-env, and the owner's login only with `keepLogin` (--agent-executor, the one mode that
 * dispatches Octo turns itself). Everything else (PATH, HOME, the space and conversation ids, plain settings a
 * handler may declare in `env`) is kept.
 */
export function detachedBinderEnv(env = process.env, allowEnv = [], { keepLogin = false } = {}) {
  return credentialFreeEnv(env, [...allowEnv, ...(keepLogin ? BINDER_LOGIN_ENV : [])]);
}
