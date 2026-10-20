// The tunnel broker the dev launcher starts for the local stack, and what it
// shares with the controller beside it (docs/Previews.md, and
// packages/tunnel-broker/docs/integration.md for the hooks).
//
// Two independent parts:
// - Hooks: the broker asks the controller's `/tunnel-broker/hooks/acl` before
//   it creates a tunnel and reports lifecycle events to `/hooks/events`, with
//   the controller's TUNNEL_BROKER_HOOK_SECRET as the bearer, as in a hosted
//   deployment.
// - Private previews: viewer hosts `p-<label>--<tunnel>.preview.localhost` on
//   the local Traefik, which browsers resolve to loopback. They need the hooks.
//
// Production and self-hosted deployments never run this code.

export const LOCAL_PREVIEW_DOMAIN = "preview.localhost";
// The broker's address on its compose network, which Traefik's forwardAuth uses.
export const LOCAL_PREVIEW_AUTH_ADDRESS = "http://broker:8080";
// docker-compose.yml publishes the local Traefik's plain-HTTP entrypoint here.
export const LOCAL_INGRESS_HTTP_PORT = 8083;

// What the controller reads; everything else goes to the broker's compose.
const CONTROLLER_KEYS = ["TUNNEL_BROKER_HOOK_SECRET", "PREVIEW_DOMAIN", "PREVIEW_BASE_URL"];
const HOOK_SECRET_KEYS = ["TUNNEL_BROKER_HOOK_SECRET", "ACL_HOOK_TOKEN", "EVENT_HOOK_TOKEN"];

function configured(env, key) {
  return String(env?.[key] ?? "").trim();
}

/** The hook secret given in `env`, or "" when none is. Throws when the given values differ. */
export function configuredHookSecret(env = process.env) {
  const given = [...new Set(HOOK_SECRET_KEYS.map((key) => configured(env, key)).filter(Boolean))];
  if (given.length > 1) {
    throw new Error(
      "TUNNEL_BROKER_HOOK_SECRET, ACL_HOOK_TOKEN and EVENT_HOOK_TOKEN are set to different values. " +
        "The broker calls the controller's hooks with its tokens, so they must match; set only TUNNEL_BROKER_HOOK_SECRET."
    );
  }
  return given[0] ?? "";
}

/**
 * Broker-to-controller hooks: ACL_HOOK_URL and EVENT_HOOK_URL with one bearer,
 * which is also the controller's TUNNEL_BROKER_HOOK_SECRET. A hook URL already
 * in `env` wins. The secret is the one given in `env` (TUNNEL_BROKER_HOOK_SECRET,
 * ACL_HOOK_TOKEN or EVENT_HOOK_TOKEN, which must agree), or else
 * `resolveHookSecret()`.
 */
export function localBrokerHookEnv({ env = process.env, controllerPort, resolveHookSecret }) {
  const hooks = `http://host.docker.internal:${controllerPort}/tunnel-broker/hooks`;
  const secret = configuredHookSecret(env) || resolveHookSecret();
  return {
    ACL_HOOK_URL: configured(env, "ACL_HOOK_URL") || `${hooks}/acl`,
    ACL_HOOK_TOKEN: secret,
    EVENT_HOOK_URL: configured(env, "EVENT_HOOK_URL") || `${hooks}/events`,
    EVENT_HOOK_TOKEN: secret,
    TUNNEL_BROKER_HOOK_SECRET: secret,
  };
}

/** Whether the local stack should serve private previews. `PREVIEW_DOMAIN=` (empty) turns them off. */
export function localPreviewsEnabled(env = process.env) {
  return !(Object.hasOwn(env ?? {}, "PREVIEW_DOMAIN") && configured(env, "PREVIEW_DOMAIN") === "");
}

/**
 * Private preview settings for the broker, its ingress sidecar and the
 * controller, or `{}` when previews are off. Values already in `env` win.
 */
export function localPreviewEnv({ env = process.env, controllerPort, ingressPort = LOCAL_INGRESS_HTTP_PORT }) {
  if (!localPreviewsEnabled(env)) {
    return {};
  }
  const pick = (key, fallback) => configured(env, key) || fallback;
  const domain = pick("PREVIEW_DOMAIN", LOCAL_PREVIEW_DOMAIN);
  return {
    PREVIEW_DOMAIN: domain,
    PREVIEW_BASE_URL: pick("PREVIEW_BASE_URL", `http://${domain}:${ingressPort}`),
    PREVIEW_AUTH_ADDRESS: pick("PREVIEW_AUTH_ADDRESS", LOCAL_PREVIEW_AUTH_ADDRESS),
    PREVIEW_AUTH_HOOK_URL: pick(
      "PREVIEW_AUTH_HOOK_URL",
      `http://host.docker.internal:${controllerPort}/tunnel-broker/hooks/preview-auth`
    ),
  };
}

function split(values) {
  const broker = {};
  const controller = {};
  for (const [key, value] of Object.entries(values)) {
    if (CONTROLLER_KEYS.includes(key)) controller[key] = value;
    if (key !== "TUNNEL_BROKER_HOOK_SECRET" && key !== "PREVIEW_BASE_URL") broker[key] = value;
  }
  return { broker, controller };
}

/**
 * What the launcher does about the tunnel broker, and the settings it passes on.
 *
 * - `skip` (RUNTIME_SKIP_TUNNEL_BROKER=1) and `external` (TUNNEL_BROKER_BASE_URL
 *   set): no broker is started and nothing is set.
 * - `start`: `broker` goes to the broker's compose, `controller` to the
 *   controller the launcher starts. Both get the hooks. When the launcher does
 *   not start the controller (RUNTIME_SKIP_CONTROLLER=1) it cannot give it a
 *   secret, so without one in `env` the broker gets no hooks and no previews,
 *   and `warnings` says so. Previews need the hooks.
 *
 * `resolveHookSecret` is called only when a secret is needed and none is given.
 */
export function tunnelBrokerStartPlan({ env = process.env, controllerPort, ingressPort, resolveHookSecret }) {
  if (configured(env, "RUNTIME_SKIP_TUNNEL_BROKER") === "1") {
    return { action: "skip", broker: {}, controller: {}, warnings: [] };
  }
  if (configured(env, "TUNNEL_BROKER_BASE_URL")) {
    return { action: "external", broker: {}, controller: {}, warnings: [] };
  }
  if (configured(env, "RUNTIME_SKIP_CONTROLLER") === "1" && !configuredHookSecret(env)) {
    return {
      action: "start",
      broker: {},
      controller: {},
      warnings: [
        "The controller is not started by this script (RUNTIME_SKIP_CONTROLLER=1) and TUNNEL_BROKER_HOOK_SECRET is unset, " +
          "so the tunnel broker calls no controller hooks and serves no private previews.",
      ],
    };
  }
  const values = {
    ...localBrokerHookEnv({ env, controllerPort, resolveHookSecret }),
    ...localPreviewEnv({ env, controllerPort, ingressPort }),
  };
  return { action: "start", ...split(values), warnings: [] };
}

/**
 * Whether the controller at `baseUrl`, already running, holds the hook
 * `secret`. It is asked through its ACL hook with that bearer and no project,
 * which writes nothing: 400 (the project is checked only after the bearer)
 * means it does; 401 (a different secret), 503 (none), any other answer or no
 * answer means it does not, and the launcher restarts it with the secret.
 */
export async function controllerHoldsHookSecret({ baseUrl, secret, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(`${baseUrl}/tunnel-broker/hooks/acl`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ intent: "check", project_id: "" }),
      signal: AbortSignal.timeout(5_000),
    });
    return response.status === 400;
  } catch {
    return false;
  }
}
