import type { Page } from "@playwright/test";
import { fetchDefaultOriginGitStatus } from "./harness.js";

/**
 * Which hosted gateway a Playwright run targets.
 *
 * `PLAYWRIGHT_GATEWAY_MODE=legacy|stateless` names the stack. Specs written
 * for one mode skip the other, and `assertGatewayMode` probes the project's
 * default origin and fails (it never skips) when the stack disagrees, so a
 * wrong or missing stack cannot pass silently. Unset means legacy (today's
 * stateful gateway) and no probe, which keeps existing runs unchanged.
 */
export type PlaywrightGatewayMode = "legacy" | "stateless";

export const GATEWAY_MODE_ENV = "PLAYWRIGHT_GATEWAY_MODE";

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

/**
 * Fail the test when the named mode and the stack disagree. Does nothing
 * when the mode is not named.
 */
export async function assertGatewayMode(
  page: Page,
  projectId: string,
  probe: (page: Page, options: { projectId: string }) => ReturnType<typeof fetchDefaultOriginGitStatus> = fetchDefaultOriginGitStatus,
): Promise<void> {
  const expected = readGatewayModeEnv();
  if (!expected) {
    return;
  }
  const actual = gatewayModeFromStatus(await probe(page, { projectId }));
  if (actual !== expected) {
    throw new Error(
      `${GATEWAY_MODE_ENV}=${expected}, but the project's default origin answers as ${actual ?? "unreachable"}.`,
    );
  }
}
