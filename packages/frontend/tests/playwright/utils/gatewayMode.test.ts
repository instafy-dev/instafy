import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import {
  assertGatewayMode,
  gatewayMode,
  gatewayModeFromStatus,
  probeGatewayMode,
  readGatewayModeEnv,
  requireGatewayMode,
} from "./gatewayMode.js";

const playwrightTest = vi.hoisted(() => ({ skip: vi.fn() }));

vi.mock("@playwright/test", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@playwright/test")>()),
  test: playwrightTest,
}));

describe("Playwright gateway mode", () => {
  const original = process.env.PLAYWRIGHT_GATEWAY_MODE;
  afterEach(() => {
    playwrightTest.skip.mockReset();
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
  it("probes the default origin and fails when it gives no usable answer", async () => {
    const page = {} as Page;
    await expect(
      probeGatewayMode(page, "p", async () => ({ statusCode: 200, payload: { stateless: true } })),
    ).resolves.toBe("stateless");
    await expect(probeGatewayMode(page, "p", async () => ({ statusCode: 404, payload: null }))).resolves.toBe("legacy");
    await expect(probeGatewayMode(page, "p", async () => ({ statusCode: 502, payload: null }))).rejects.toThrow(
      /answered 502/,
    );
    await expect(probeGatewayMode(page, "p", async () => null)).rejects.toThrow(/No origin token/);
  });

  it("skips a spec for the other mode without probing", async () => {
    const page = {} as Page;
    const probe = vi.fn(async () => ({ statusCode: 200, payload: {} }));
    delete process.env.PLAYWRIGHT_GATEWAY_MODE;
    await requireGatewayMode(page, "p", "stateless", probe);
    expect(playwrightTest.skip).toHaveBeenCalledWith(true, expect.stringMatching(/PLAYWRIGHT_GATEWAY_MODE=stateless/));
    expect(probe).not.toHaveBeenCalled();
  });

  it("probes whenever a required spec runs, unset included, and fails on a mismatch", async () => {
    const page = {} as Page;
    delete process.env.PLAYWRIGHT_GATEWAY_MODE;
    await expect(
      requireGatewayMode(page, "p", "legacy", async () => ({ statusCode: 200, payload: { stateless: true } })),
    ).rejects.toThrow(/PLAYWRIGHT_GATEWAY_MODE=legacy, but the stack's gateway answers as stateless/);
    await expect(
      requireGatewayMode(page, "p", "legacy", async () => ({ statusCode: 200, payload: {} })),
    ).resolves.toBeUndefined();
    process.env.PLAYWRIGHT_GATEWAY_MODE = "stateless";
    await expect(
      requireGatewayMode(page, "p", "stateless", async () => ({ statusCode: 200, payload: { stateless: true } })),
    ).resolves.toBeUndefined();
    await expect(requireGatewayMode(page, "p", "stateless", async () => null)).rejects.toThrow(/No origin token/);
    expect(playwrightTest.skip).not.toHaveBeenCalled();
  });
});
