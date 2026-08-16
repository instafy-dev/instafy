// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function futureJwt(): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: "00000000-0000-4000-8000-000000000001",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`;
}

describe("emitControllerAuthError with an injected override token", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_CONTROLLER_URL", "https://controller.example.test");
    vi.stubEnv("PROD", false);
    window.history.replaceState(null, "", "/studio");
    window.sessionStorage.clear();
    window.__INSTAFY_CONTROLLER_TOKEN__ = null;
    window.__INSTAFY_CONTROLLER_BASE_URL__ = null;
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
    window.sessionStorage.clear();
    window.__INSTAFY_CONTROLLER_TOKEN__ = null;
    window.__INSTAFY_CONTROLLER_BASE_URL__ = null;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("drops a stale override on 401 and requires a reload without sign-out", async () => {
    const overrideToken = futureJwt();
    window.sessionStorage.setItem(
      "instafy.controllerBinding",
      JSON.stringify({ version: 1, token: overrideToken, baseUrl: null }),
    );
    const core = await import("../core");
    const received: number[] = [];
    const listener = (event: Event) => {
      received.push((event as CustomEvent<{ status: number }>).detail.status);
    };
    window.addEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, listener);

    core.emitControllerAuthError({ status: 401, message: "unauthorized (401)" });

    expect(received).toEqual([]);
    expect(JSON.parse(window.sessionStorage.getItem("instafy.controllerBinding") ?? "null")).toEqual({
      version: 1,
      token: null,
      baseUrl: null,
    });
    expect(window.sessionStorage.getItem("instafy.controllerAccessToken")).toBeNull();
    expect(core.isControllerDocumentReloadPending()).toBe(true);

    // Late failures from the old document are ignored while reload is pending.
    core.emitControllerAuthError({ status: 401, message: "unauthorized (401)" });
    expect(received).toEqual([]);
    window.removeEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, listener);
  });

  it("does not consume the override for non-401 auth errors", async () => {
    const overrideToken = futureJwt();
    window.sessionStorage.setItem(
      "instafy.controllerBinding",
      JSON.stringify({ version: 1, token: overrideToken, baseUrl: null }),
    );
    const core = await import("../core");
    const received: number[] = [];
    const listener = (event: Event) => {
      received.push((event as CustomEvent<{ status: number }>).detail.status);
    };
    window.addEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, listener);

    core.emitControllerAuthError({ status: 403, message: "forbidden (403)" });

    expect(received).toEqual([403]);
    expect(JSON.parse(window.sessionStorage.getItem("instafy.controllerBinding") ?? "null")).toEqual({
      version: 1,
      token: overrideToken,
      baseUrl: null,
    });
    expect(window.sessionStorage.getItem("instafy.controllerAccessToken")).toBeNull();
    expect(core.isControllerDocumentReloadPending()).toBe(false);
    window.removeEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, listener);
  });
});
