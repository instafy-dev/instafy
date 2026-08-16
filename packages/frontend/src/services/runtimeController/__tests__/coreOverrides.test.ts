// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: getSessionMock,
    },
  },
}));

const canonicalControllerUrl = "https://controller.example.test";
const bindingStorageKey = "instafy.controllerBinding";
const retiredTokenStorageKey = "instafy.controllerAccessToken";
const retiredBaseUrlStorageKey = "instafy.controllerBaseUrl";

function expectStoredBinding(token: string | null, baseUrl: string | null): void {
  const raw = window.sessionStorage.getItem(bindingStorageKey);
  expect(raw).not.toBeNull();
  expect(JSON.parse(raw ?? "null")).toEqual({ version: 1, token, baseUrl });
}

function jwtExpiringAt(expiresAtSeconds: number): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    exp: expiresAtSeconds,
  })}.signature`;
}

describe("runtime controller override containment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_CONTROLLER_URL", canonicalControllerUrl);
    vi.stubEnv("PROD", false);
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

  it("ignores and scrubs retired URL and split-storage credentials", async () => {
    window.history.replaceState(
      null,
      "",
      "/studio?keep=1&controllerUrl=https%3A%2F%2Fevil.example&controllerAccessToken=url-secret#anchor",
    );
    window.sessionStorage.setItem(retiredTokenStorageKey, "stored-secret");
    window.sessionStorage.setItem(retiredBaseUrlStorageKey, "https://stored.example");

    const core = await import("../core");

    expect(core.controllerBaseUrl).toBe(canonicalControllerUrl);
    expect(await core.resolveControllerAccessToken(null)).toBe("ambient-session-token");
    expect(window.location.search).toBe("?keep=1");
    expect(window.location.hash).toBe("#anchor");
    expect(window.sessionStorage.getItem(retiredTokenStorageKey)).toBeNull();
    expect(window.sessionStorage.getItem(retiredBaseUrlStorageKey)).toBeNull();
    expectStoredBinding(null, null);
  });

  it("accepts a complete controller binding injected before application startup", async () => {
    window.__INSTAFY_CONTROLLER_TOKEN__ = "injected-token";
    window.__INSTAFY_CONTROLLER_BASE_URL__ = "http://127.0.0.1:8788/prefix///";

    const core = await import("../core");

    expect(core.controllerBaseUrl).toBe("http://localhost:8788/prefix");
    expect(await core.resolveControllerAccessToken("unrelated-token")).toBe(
      "injected-token",
    );
    expect(getSessionMock).not.toHaveBeenCalled();
    expectStoredBinding("injected-token", "http://localhost:8788/prefix");
  });

  it("rejects an invalid injected base and its token as one source", async () => {
    window.__INSTAFY_CONTROLLER_TOKEN__ = "injected-secret";
    window.__INSTAFY_CONTROLLER_BASE_URL__ = "javascript:alert(1)";

    const core = await import("../core");

    expect(core.controllerBaseUrl).toBe(canonicalControllerUrl);
    expect(await core.resolveControllerAccessToken(null)).toBe("ambient-session-token");
    expect(window.__INSTAFY_CONTROLLER_TOKEN__).toBeNull();
    expect(window.__INSTAFY_CONTROLLER_BASE_URL__).toBeNull();
    expectStoredBinding(null, null);
  });

  it("resumes only a valid atomic custom binding", async () => {
    window.sessionStorage.setItem(
      bindingStorageKey,
      JSON.stringify({
        version: 1,
        token: "stored-pair-token",
        baseUrl: "https://self-hosted.example/api/",
      }),
    );

    const core = await import("../core");

    expect(core.controllerBaseUrl).toBe("https://self-hosted.example/api");
    expect(await core.resolveControllerAccessToken(null)).toBe("stored-pair-token");
    expect(getSessionMock).not.toHaveBeenCalled();
    expectStoredBinding("stored-pair-token", "https://self-hosted.example/api");
  });

  it("allows a versioned token-only binding on the canonical controller", async () => {
    window.sessionStorage.setItem(
      bindingStorageKey,
      JSON.stringify({ version: 1, token: "canonical-fixed-token", baseUrl: null }),
    );

    const core = await import("../core");

    expect(core.controllerBaseUrl).toBe(canonicalControllerUrl);
    expect(await core.resolveControllerAccessToken(null)).toBe("canonical-fixed-token");
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed atomic binding", async () => {
    window.sessionStorage.setItem(bindingStorageKey, "{malformed");
    window.sessionStorage.setItem(retiredTokenStorageKey, "retired-secret");

    const core = await import("../core");

    expect(core.controllerBaseUrl).toBe(canonicalControllerUrl);
    expect(await core.resolveControllerAccessToken(null)).toBe("ambient-session-token");
    expectStoredBinding(null, null);
    expect(window.sessionStorage.getItem(retiredTokenStorageKey)).toBeNull();
  });

  it("does not fall back to ambient auth when a custom token expires", async () => {
    window.sessionStorage.setItem(
      bindingStorageKey,
      JSON.stringify({
        version: 1,
        token: jwtExpiringAt(Math.floor(Date.now() / 1000) - 60),
        baseUrl: "https://self-hosted.example",
      }),
    );

    const core = await import("../core");
    const reloadReasons: string[] = [];
    const unsubscribe = core.subscribeToControllerReloadRequired((detail) => {
      reloadReasons.push(detail.reason);
    });

    expect(await core.resolveControllerAccessToken("ambient-explicit-token")).toBeNull();
    expect(core.isControllerDocumentReloadPending()).toBe(true);
    expect(reloadReasons).toEqual(["rejected-override"]);
    expectStoredBinding(null, null);
    expect(getSessionMock).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("clears a rejected injected pair together on 401", async () => {
    window.__INSTAFY_CONTROLLER_TOKEN__ = "custom-token";
    window.__INSTAFY_CONTROLLER_BASE_URL__ = "https://self-hosted.example";
    const core = await import("../core");

    core.emitControllerAuthError({ status: 401, message: "unauthorized" });

    expect(core.isControllerDocumentReloadPending()).toBe(true);
    expect(window.__INSTAFY_CONTROLLER_BASE_URL__).toBeNull();
    expect(window.__INSTAFY_CONTROLLER_TOKEN__).toBeNull();
    expectStoredBinding(null, null);
  });

  it("keeps an ambient request context separate from a one-request fixed token", async () => {
    const core = await import("../core");
    const received: number[] = [];
    window.addEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, (event) => {
      received.push((event as CustomEvent<{ status: number }>).detail.status);
    });

    const ambientContext = await core.resolveControllerRequestContext(null);
    const fixedContext = await core.resolveControllerRequestContext("one-request-token");
    expect(ambientContext.credentialSource).toBe("ambient");
    expect(fixedContext.credentialSource).toBe("fixed");

    await core.readControllerError(
      new Response(JSON.stringify({ message: "ambient rejected" }), { status: 401 }),
      "request failed",
      ambientContext,
    );
    expect(received).toEqual([401]);

    await core.readControllerError(
      new Response(JSON.stringify({ message: "fixed rejected" }), { status: 401 }),
      "request failed",
      fixedContext,
    );
    expect(received).toEqual([401]);
  });

  it("keeps contextless 401 parsing non-mutating", async () => {
    window.sessionStorage.setItem(
      bindingStorageKey,
      JSON.stringify({ version: 1, token: "canonical-fixed-token", baseUrl: null }),
    );
    const core = await import("../core");

    await expect(
      core.readControllerError(
        new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 }),
        "request failed",
      ),
    ).resolves.toBe("unauthorized");
    expect(core.isControllerDocumentReloadPending()).toBe(false);
    expectStoredBinding("canonical-fixed-token", null);
  });

  it("does not expose controller mutation through postMessage", async () => {
    const core = await import("../core");

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "instafy:setControllerBaseUrl", url: "https://evil.example" },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "instafy:setControllerAccessToken", token: "message-token" },
      }),
    );

    expect(core.controllerBaseUrl).toBe(canonicalControllerUrl);
    expectStoredBinding(null, null);
  });
});
