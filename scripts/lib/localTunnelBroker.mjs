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
 * Whether `host` is a loopback host by the controller's rule
 * (`is_loopback_host` in runtime-controller previews/sessions.rs): `localhost`,
 * a name under `.localhost`, or a loopback IP. Only such a host may have a plain
 * `http` PREVIEW_BASE_URL; the controller refuses to start with any other.
 */
export function isLoopbackPreviewHost(host) {
  const value = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (value === "localhost" || value.endsWith(".localhost")) {
    return true;
  }
  const bare = value.replace(/^\[|\]$/g, "");
  return bare === "::1" || /^127(\.\d{1,3}){3}$/.test(bare);
}

/**
 * Private preview settings for the broker, its ingress sidecar and the
 * controller, or `{}` when previews are off. Values already in `env` win.
 *
 * PREVIEW_BASE_URL is derived (`http://<domain>:<ingressPort>`, the local
 * Traefik) only for a loopback domain. For any other domain it is left unset,
 * so the controller uses `https://<domain>` and the operator supplies that
 * ingress. A given plain-http PREVIEW_BASE_URL on a non-loopback host is
 * refused here, because the controller would refuse to start with it.
 */
export function localPreviewEnv({ env = process.env, controllerPort, ingressPort = LOCAL_INGRESS_HTTP_PORT }) {
  if (!localPreviewsEnabled(env)) {
    return {};
  }
  const pick = (key, fallback) => configured(env, key) || fallback;
  const domain = pick("PREVIEW_DOMAIN", LOCAL_PREVIEW_DOMAIN);
  const givenBaseUrl = configured(env, "PREVIEW_BASE_URL");
  if (givenBaseUrl) {
    let parsed = null;
    try {
      parsed = new URL(givenBaseUrl);
    } catch {}
    if (parsed?.protocol === "http:" && !isLoopbackPreviewHost(parsed.hostname)) {
      throw new Error(
        "PREVIEW_BASE_URL uses plain http on a host that is not loopback, which the controller refuses at startup. " +
          "Use https, a localhost name, or leave PREVIEW_BASE_URL unset."
      );
    }
  }
  const baseUrl = givenBaseUrl || (isLoopbackPreviewHost(domain) ? `http://${domain}:${ingressPort}` : "");
  return {
    PREVIEW_DOMAIN: domain,
    ...(baseUrl ? { PREVIEW_BASE_URL: baseUrl } : {}),
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
 * The two `docker compose` calls that start the broker's stack: the broker
 * with its postgres, rathole and Traefik, then the ingress sidecar. Both get
 * `env` plus `plan.broker`, as a new object: `env` itself is never changed, so
 * other children of the launcher never see the hook secret.
 */
export function tunnelBrokerComposeCalls({ plan, env = process.env, composeFiles, cwd }) {
  const composeEnv = { ...env, ...plan.broker };
  const files = composeFiles.flatMap((file) => ["-f", file]);
  const up = (...services) => ({
    command: "docker",
    args: ["compose", ...files, "--profile", "ingress", "up", "-d", ...services],
    options: { cwd, env: composeEnv },
  });
  return [up("postgres", "broker", "rathole", "traefik"), up("rathole-sidecar")];
}

/**
 * Whether this checkout started the controller listening on its port: the pid
 * it recorded is a runtime controller, and a listener on the port is that
 * process or in its process group (the launcher starts the controller
 * detached, so `cargo run` and the binary it runs share the recorded pid as
 * their group). `listeners` is `[{ pid, pgid }]` for the port.
 */
export function ownsControllerListener({ recordedPid, recordedIsController, listeners }) {
  if (!Number.isInteger(recordedPid) || recordedPid <= 0 || !recordedIsController) {
    return false;
  }
  return (listeners ?? []).some(({ pid, pgid }) => pid === recordedPid || pgid === recordedPid);
}

/**
 * What the launcher does with a controller already on its port:
 * - `reuse` when it has an origin signing key and, if this launch has a hook
 *   secret, holds that secret;
 * - otherwise `restart` when this checkout started it (`ownsListener`), and
 *   `refuse` when it did not. A controller this checkout did not start (another
 *   worktree's, another project's, one started by hand) is never stopped.
 */
export function controllerReuseDecision({ jwksReady, hookSecret, holdsSecret, ownsListener, controllerPort }) {
  const missing = !jwksReady
    ? "an origin signing key"
    : hookSecret && !holdsSecret
      ? "this checkout's tunnel broker hook secret"
      : "";
  if (!missing) {
    return { action: "reuse" };
  }
  const reason = `without ${missing}`;
  if (ownsListener) {
    return { action: "restart", reason };
  }
  return {
    action: "refuse",
    reason,
    message:
      `A controller on port ${controllerPort} is running ${reason}, and this checkout did not start it, ` +
      "so it is left running. Stop it yourself, set CONTROLLER_PORT to a free port, or run it with " +
      "RUNTIME_SKIP_CONTROLLER=1 and TUNNEL_BROKER_HOOK_SECRET set to the secret it holds.",
  };
}

/**
 * Whether the controller at `baseUrl`, already running, holds the hook
 * `secret`. It is asked through its ACL hook with that bearer and an empty
 * project, which writes nothing. This relies on the hook's order in
 * `post_tunnel_broker_acl_hook` (runtime-controller tunnels/mod.rs): the bearer
 * is checked before the project id, so 400 means it does; 401 (a different
 * secret), 503 (none), any other answer or no answer means it does not. The
 * controller test `acl_hook_checks_the_bearer_before_the_project` pins that
 * order.
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
