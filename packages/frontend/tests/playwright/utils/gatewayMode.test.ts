import { afterEach, describe, expect, it } from "vitest";
import type { Page } from "@playwright/test";
import { assertGatewayMode, gatewayMode, gatewayModeFromStatus, readGatewayModeEnv } from "./gatewayMode.js";

describe("Playwright gateway mode", () => {
  const original = process.env.PLAYWRIGHT_GATEWAY_MODE;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.PLAYWRIGHT_GATEWAY_MODE;
    } else {
      process.env.PLAYWRIGHT_GATEWAY_MODE = original;
    }
  });

  it("reads the named mode and treats unset as legacy", () => {
    expect(readGatewayModeEnv({})).toBeNull();
    expect(gatewayMode({})).toBe("legacy");
    expect(gatewayMode({ PLAYWRIGHT_GATEWAY_MODE: " Stateless " })).toBe("stateless");
    expect(() => readGatewayModeEnv({ PLAYWRIGHT_GATEWAY_MODE: "cloud" })).toThrow(/legacy" or "stateless/);
  });

  it("maps status answers the way the Studio probe does", () => {
    expect(gatewayModeFromStatus({ statusCode: 200, payload: { supported: true, stateless: true } })).toBe("stateless");
    expect(gatewayModeFromStatus({ statusCode: 200, payload: { supported: true } })).toBe("legacy");
    expect(gatewayModeFromStatus({ statusCode: 404, payload: null })).toBe("legacy");
    expect(gatewayModeFromStatus({ statusCode: 502, payload: null })).toBeNull();
    expect(gatewayModeFromStatus(null)).toBeNull();
  });

  it("fails instead of skipping when the stack disagrees", async () => {
    const page = {} as Page;
    process.env.PLAYWRIGHT_GATEWAY_MODE = "stateless";
    await expect(assertGatewayMode(page, "p", async () => ({ statusCode: 200, payload: {} }))).rejects.toThrow(
      /answers as legacy/,
    );
    await expect(assertGatewayMode(page, "p", async () => null)).rejects.toThrow(/unreachable/);
    await expect(
      assertGatewayMode(page, "p", async () => ({ statusCode: 200, payload: { stateless: true } })),
    ).resolves.toBeUndefined();
    delete process.env.PLAYWRIGHT_GATEWAY_MODE;
    await expect(assertGatewayMode(page, "p", async () => null)).resolves.toBeUndefined();
  });
});
