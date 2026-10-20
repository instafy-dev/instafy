// Private site previews on the local stack (docs/Previews.md).
//
// Previews are off unless configured. The dev launcher turns them on only for
// the tunnel broker it starts itself: viewer hosts are
// `p-<label>--<tunnel>.preview.localhost` on the local Traefik port, which
// browsers resolve to loopback. Production and self-hosted deployments never
// run this code, so they stay off until an operator sets the same variables.

export const LOCAL_PREVIEW_DOMAIN = "preview.localhost";
// The broker's address on its compose network, which Traefik's forwardAuth uses.
export const LOCAL_PREVIEW_AUTH_ADDRESS = "http://broker:8080";

function configured(env, key) {
  return String(env?.[key] ?? "").trim();
}

/**
 * Whether the local stack should serve private previews. Setting
 * `PREVIEW_DOMAIN` to an empty value turns them off for this stack.
 */
export function localPreviewsEnabled(env = process.env) {
  return !(Object.hasOwn(env ?? {}, "PREVIEW_DOMAIN") && configured(env, "PREVIEW_DOMAIN") === "");
}

/**
 * The variables the broker (compose), its ingress sidecar and the controller
 * need for private previews on the local stack, or `{}` when previews are off.
 *
 * - Broker: PREVIEW_DOMAIN, PREVIEW_AUTH_ADDRESS, PREVIEW_AUTH_HOOK_URL, and
 *   ACL_HOOK_URL so tunnel credits are still burned once the hook secret is set
 *   (the controller skips its own burn for broker tunnels when it is).
 * - Controller: PREVIEW_DOMAIN, PREVIEW_BASE_URL.
 * - Both: the shared hook bearer (broker ACL_HOOK_TOKEN = controller
 *   TUNNEL_BROKER_HOOK_SECRET). If they differ, every preview request is
 *   denied. `resolveHookSecret` is called only when previews are on.
 *
 * Values already in `env` win.
 */
export function localPreviewEnv({ env = process.env, controllerPort, ingressPort, resolveHookSecret }) {
  if (!localPreviewsEnabled(env)) {
    return {};
  }
  const pick = (key, fallback) => configured(env, key) || fallback;
  const controllerHooks = `http://host.docker.internal:${controllerPort}/tunnel-broker/hooks`;
  const domain = pick("PREVIEW_DOMAIN", LOCAL_PREVIEW_DOMAIN);
  const hookSecret = resolveHookSecret();
  return {
    PREVIEW_DOMAIN: domain,
    PREVIEW_BASE_URL: pick("PREVIEW_BASE_URL", `http://${domain}:${ingressPort}`),
    PREVIEW_AUTH_ADDRESS: pick("PREVIEW_AUTH_ADDRESS", LOCAL_PREVIEW_AUTH_ADDRESS),
    PREVIEW_AUTH_HOOK_URL: pick("PREVIEW_AUTH_HOOK_URL", `${controllerHooks}/preview-auth`),
    ACL_HOOK_URL: pick("ACL_HOOK_URL", `${controllerHooks}/acl`),
    ACL_HOOK_TOKEN: hookSecret,
    TUNNEL_BROKER_HOOK_SECRET: hookSecret,
  };
}
