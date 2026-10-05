import { test, type Page } from "@playwright/test";
import { fetchDefaultOriginGitStatus, type OriginTokenFailure } from "./harness.js";

/**
 * Which hosted gateway a Playwright run targets: `legacy` (today's stateful
 * gateway) or `stateless` (`/git/status` answers `stateless: true`).
 *
 * `PLAYWRIGHT_GATEWAY_MODE=legacy|stateless` names the stack; unset means
 * legacy. Specs written for one mode skip the other. Both checks below fail
 * (they never skip) when the stack disagrees, so a wrong or missing stack
 * cannot pass silently:
 * - `assertGatewayMode` probes only when the mode is named, which keeps runs
 *   with the variable unset exactly as before.
 * - `requireGatewayMode` skips a spec written for the other mode and probes
 *   whenever the spec runs, unset included.
 *
 * A spec that runs on both gateways reads `readGatewayModeEnv()` and checks
 * a mode's own details only when the run names that mode.
 */
export type PlaywrightGatewayMode = "legacy" | "stateless";
export type GatewayMode = PlaywrightGatewayMode;

export const GATEWAY_MODE_ENV = "PLAYWRIGHT_GATEWAY_MODE";

type GatewayStatusProbe = (
  page: Page,
  options: { projectId: string },
) => ReturnType<typeof fetchDefaultOriginGitStatus>;

/** The mode the run names, or null when it names none. Any other value throws. */
export function readGatewayModeEnv(env: NodeJS.ProcessEnv = process.env): PlaywrightGatewayMode | null {
  const raw = (env[GATEWAY_MODE_ENV] ?? "").trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (raw === "legacy" || raw === "stateless") {
    return raw;
  }
  throw new Error(`${GATEWAY_MODE_ENV} must be "legacy" or "stateless", got "${raw}".`);
}

/** The mode specs should assume: the named one, or legacy when unset. */
export function gatewayMode(env: NodeJS.ProcessEnv = process.env): PlaywrightGatewayMode {
  return readGatewayModeEnv(env) ?? "legacy";
}

/** The stack's declared mode (same as `gatewayMode`). */
export function declaredGatewayMode(env: NodeJS.ProcessEnv = process.env): GatewayMode {
  return gatewayMode(env);
}

/** Map a `/git/status` answer to the mode the Studio would choose. */
export function gatewayModeFromStatus(
  status: { statusCode: number; payload: Record<string, unknown> | null } | null,
): PlaywrightGatewayMode | null {
  if (!status) {
    return null;
  }
  if (status.statusCode >= 200 && status.statusCode < 300 && status.payload?.stateless === true) {
    return "stateless";
  }
  if (status.statusCode === 404 || (status.statusCode >= 200 && status.statusCode < 300)) {
    return "legacy";
  }
  return null;
}

/** Why the probe had no origin token, for an error message. */
export function describeOriginTokenFailure(failure: OriginTokenFailure): string {
  switch (failure.reason) {
    case "unconfigured":
      return "No origin token: the controller URL and service role key are required to probe the gateway.";
    case "mint_failed":
      return `Origin token mint failed (${failure.statusCode}).`;
    case "mint_empty":
      return "Origin token mint returned no endpoint or token.";
  }
}

/**
 * Ask the project's default origin how it keeps versions (one status call).
 * Throws when the origin gives no usable answer.
 */
export async function probeGatewayMode(
  page: Page,
  projectId: string,
  probe: GatewayStatusProbe = fetchDefaultOriginGitStatus,
): Promise<GatewayMode> {
  const status = await probe(page, { projectId });
  if ("tokenFailure" in status) {
    throw new Error(`[gatewayMode] ${describeOriginTokenFailure(status.tokenFailure)}`);
  }
  const mode = gatewayModeFromStatus(status);
  if (!mode) {
    throw new Error(`[gatewayMode] /git/status answered ${status.statusCode}.`);
  }
  return mode;
}

/**
 * Fail the test when the named mode and the stack disagree. Does nothing
 * when the mode is not named.
 */
export async function assertGatewayMode(
  page: Page,
  projectId: string,
  probe: GatewayStatusProbe = fetchDefaultOriginGitStatus,
): Promise<void> {
  const expected = readGatewayModeEnv();
  if (!expected) {
    return;
  }
  const status = await probe(page, { projectId });
  if ("tokenFailure" in status) {
    throw new Error(
      `${GATEWAY_MODE_ENV}=${expected}, but the project's default origin is unreachable. ` +
        describeOriginTokenFailure(status.tokenFailure),
    );
  }
  const actual = gatewayModeFromStatus(status);
  if (actual !== expected) {
    throw new Error(
      `${GATEWAY_MODE_ENV}=${expected}, but the project's default origin answers as ${actual ?? "unreachable"}.`,
    );
  }
}

/**
 * Skip unless the stack declares `required`; fail when the declared mode and
 * the gateway's answer disagree.
 */
export async function requireGatewayMode(
  page: Page,
  projectId: string,
  required: GatewayMode,
  probe: GatewayStatusProbe = fetchDefaultOriginGitStatus,
): Promise<void> {
  const declared = declaredGatewayMode();
  if (declared !== required) {
    test.skip(true, `Covers the ${required} gateway; set ${GATEWAY_MODE_ENV}=${required}.`);
    return;
  }
  const probed = await probeGatewayMode(page, projectId, probe);
  if (probed !== declared) {
    throw new Error(
      `${GATEWAY_MODE_ENV}=${declared}, but the stack's gateway answers as ${probed}. ` +
        "Start the matching stack or fix the variable.",
    );
  }
}
