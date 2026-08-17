// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://app.instafy.dev/"}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: getSessionMock,
    },
  },
}));

const canonicalControllerUrl = "https://controller.instafy.dev";

describe("hosted production controller overrides", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_CONTROLLER_URL", canonicalControllerUrl);
    vi.stubEnv("PROD", true);
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "ambient-session-token" } },
    });
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

  it("ignores and purges URL, global, and stored custom controller pairs", async () => {
    window.history.replaceState(
      null,
      "",
      "/studio?keep=1&controllerUrl=https%3A%2F%2Fevil-query.example&controllerAccessToken=query-token",
    );
    window.__INSTAFY_CONTROLLER_TOKEN__ = "global-token";
    window.__INSTAFY_CONTROLLER_BASE_URL__ = "https://evil-global.example";
    window.sessionStorage.setItem("instafy.controllerAccessToken", "stored-token");
    window.sessionStorage.setItem(
      "instafy.controllerBaseUrl",
      "https://evil-stored.example",
    );

    const core = await import("../core");

    expect(core.controllerBaseUrl).toBe(canonicalControllerUrl);
    expect(core.runtimeControllerEnabled).toBe(true);
    expect(window.__INSTAFY_CONTROLLER_BASE_URL__).toBeNull();
    expect(window.__INSTAFY_CONTROLLER_TOKEN__).toBeNull();
    expect(JSON.parse(window.sessionStorage.getItem("instafy.controllerBinding") ?? "null")).toEqual({
      version: 1,
      token: null,
      baseUrl: null,
    });
    expect(window.sessionStorage.getItem("instafy.controllerBaseUrl")).toBeNull();
    expect(window.sessionStorage.getItem("instafy.controllerAccessToken")).toBeNull();
    expect(window.location.search).toBe("?keep=1");
    expect(await core.resolveControllerAccessToken(null)).toBe("ambient-session-token");
  });
});
