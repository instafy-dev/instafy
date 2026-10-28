// Local drives with the browser the way users get it (STACK_BROWSER_HOST=1).
//
// Users' spaces run Instafy's browser on their own machine, on demand: the
// controller covers every space with HOSTED_BROWSER_HOST and launches each
// space's machine from the base runtime image, which carries the on-demand
// browser host. Such a run starts in routine browsing ("Browser on the space's
// own machine" in docs/Shared-Browser.md). The dev stack's default is the
// older path instead: every space machine runs the webdev image, and the first
// browser press restarts the machine as a browser session of its own, whose
// runs start in Ask. A drive on that path sees prompts users never see.
//
// With STACK_BROWSER_HOST=1 the stack builds the base image (target
// `runtime`), the provider launches space machines from it, and the controller
// covers every space. Webdev launches keep the webdev image. Each value the
// operator sets explicitly is kept.

export const STACK_BROWSER_HOST_ENV = "STACK_BROWSER_HOST";
/** The base runtime image, with the on-demand browser host, built for this mode. */
export const STACK_BROWSER_HOST_IMAGE = "runtime-agent:host-local";
export const STACK_BROWSER_HOST_BUILD_TARGET = "runtime";

export function stackBrowserHostEnabled(env = process.env) {
  return String(env?.[STACK_BROWSER_HOST_ENV] ?? "").trim() === "1";
}

function unset(value) {
  return typeof value !== "string" || value.trim().length === 0;
}

/** The provider's launch settings: space machines from the base image. */
export function withStackBrowserHostProviderEnv(env) {
  if (!stackBrowserHostEnabled(env)) return env;
  return unset(env.RUNTIME_AGENT_IMAGE) ? { ...env, RUNTIME_AGENT_IMAGE: STACK_BROWSER_HOST_IMAGE } : env;
}

/** The controller's policy: every space's own machine hosts the browser. */
export function withStackBrowserHostControllerEnv(env, source = env) {
  if (!stackBrowserHostEnabled(source)) return env;
  return unset(env.HOSTED_BROWSER_HOST) ? { ...env, HOSTED_BROWSER_HOST: "all" } : env;
}
