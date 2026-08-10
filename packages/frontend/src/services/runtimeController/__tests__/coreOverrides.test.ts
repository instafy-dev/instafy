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
const legacyTokenStorageKey = "instafy.controllerAccessToken";
const legacyBaseUrlStorageKey = "instafy.controllerBaseUrl";

function expectStoredBinding(token: string | null, baseUrl: string | null): void {
  const raw = window.sessionStorage.getItem(bindingStorageKey);
  expect(raw).not.toBeNull();
  expect(JSON.parse(raw ?? "null")).toEqual({
    version: 1,
    token,
    baseUrl,
  });
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

  it("accepts only unambiguous HTTP(S) controller base URLs", async () => {
    const { readControllerBaseUrlFromSearch } = await import("../core");

    expect(
      readControllerBaseUrlFromSearch(
        "?controllerUrl=https%3A%2F%2Fcontroller.example.test%2Fprefix%2F%2F%2F",
      ),
    ).toBe("https://controller.example.test/prefix");
    expect(
      readControllerBaseUrlFromSearch("?controllerUrl=javascript%3Aalert(1)"),
    ).toBeNull();
    expect(
      readControllerBaseUrlFromSearch("?controllerUrl=file%3A%2F%2F%2Ftmp%2Fcontroller"),
    ).toBeNull();
    expect(
      readControllerBaseUrlFromSearch(
        "?controllerUrl=https%3A%2F%2Fuser%3Asecret%40controller.example.test",
      ),
    ).toBeNull();
    expect(
      readControllerBaseUrlFromSearch(
        "?controllerUrl=https%3A%2F%2Fcontroller.example.test%3Fredirect%3Dhttps%253A%252F%252Fevil.test",
      ),
    ).toBeNull();
    expect(
      readControllerBaseUrlFromSearch(
        "?controllerUrl=https%3A%2F%2Fcontroller.example.test%2F%23fragment",
      ),
    ).toBeNull();
    expect(
      readControllerBaseUrlFromSearch(
        "?controllerUrl=https%3A%2F%2Fcontroller.example.test%2F%3F",
      ),
    ).toBeNull();
    expect(
      readControllerBaseUrlFromSearch(
        "?controllerUrl=https%3A%2F%2Fcontroller.example.test%2F%23",
      ),
    ).toBeNull();
  });

  it("preserves the localhost voice-harness URL and token as one pair", async () => {
    window.history.replaceState(
      null,
      "",
      "/studio?keep=1&controllerUrl=http%3A%2F%2F127.0.0.1%3A8788%2F%2F%2F&controllerAccessToken=voice-token#voice",
    );

    const core = await import("../core");

    expect(core.controllerBaseUrl).toBe("http://localhost:8788");
    expect(await core.resolveControllerAccessToken("ambient-explicit-token")).toBe(
      "voice-token",
    );
    expect((await core.resolveControllerRequestContext(null)).credentialSource).toBe(
      "fixed",
    );
    expect(getSessionMock).not.toHaveBeenCalled();
    expectStoredBinding("voice-token", "http://localhost:8788");
    expect(window.sessionStorage.getItem(legacyBaseUrlStorageKey)).toBeNull();
    expect(window.sessionStorage.getItem(legacyTokenStorageKey)).toBeNull();
    expect(window.location.search).toBe("?keep=1");
    expect(window.location.hash).toBe("#voice");
  });

  it("rejects an invalid explicit base and its token as one source", async () => {
    window.sessionStorage.setItem(legacyTokenStorageKey, "stored-secret");
    window.history.replaceState(
      null,
      "",
      "/studio?keep=1&controllerUrl=javascript%3Aalert(1)&controllerAccessToken=attacker-token#safe",
    );

    const core = await import("../core");

    expect(core.controllerBaseUrl).toBe(canonicalControllerUrl);
    const requestContext = await core.resolveControllerRequestContext(null);
    expect(requestContext.accessToken).toBe("ambient-session-token");
    expect(requestContext.credentialSource).toBe("ambient");
    expectStoredBinding(null, null);
    expect(window.sessionStorage.getItem(legacyBaseUrlStorageKey)).toBeNull();
    expect(window.sessionStorage.getItem(legacyTokenStorageKey)).toBeNull();
    expect(window.location.search).toBe("?keep=1");
    expect(window.location.hash).toBe("#safe");
  });

  it("does not pair a query base with an unrelated stored token", async () => {
    window.sessionStorage.setItem(legacyTokenStorageKey, "stored-secret");
    window.history.replaceState(
      null,
      "",
      "/studio?controllerUrl=https%3A%2F%2Fevil.example",
    );

    const core = await import("../core");

    expect(core.controllerBaseUrl).toBe(canonicalControllerUrl);
    expectStoredBinding(null, null);
    expect(window.sessionStorage.getItem(legacyTokenStorageKey)).toBeNull();
    expect(await core.resolveControllerAccessToken(null)).toBe("ambient-session-token");
    expect(getSessionMock).toHaveBeenCalledTimes(1);
  });

  it("resumes a stored custom base only with its stored token", async () => {
    window.sessionStorage.setItem(legacyTokenStorageKey, "stored-pair-token");
    window.sessionStorage.setItem(
      legacyBaseUrlStorageKey,
      "https://self-hosted.example/api/",
    );

    const core = await import("../core");

    expect(core.controllerBaseUrl).toBe("https://self-hosted.example/api");
    expect(await core.resolveControllerAccessToken("ambient-explicit-token")).toBe(
      "stored-pair-token",
    );
    expect(getSessionMock).not.toHaveBeenCalled();
    expectStoredBinding("stored-pair-token", "https://self-hosted.example/api");
    expect(window.sessionStorage.getItem(legacyTokenStorageKey)).toBeNull();
    expect(window.sessionStorage.getItem(legacyBaseUrlStorageKey)).toBeNull();
  });

  it("fails closed on a partial legacy token instead of sending it to canonical", async () => {
    window.sessionStorage.setItem(legacyTokenStorageKey, "stranded-custom-token");

    const core = await import("../core");

    expect(core.controllerBaseUrl).toBe(canonicalControllerUrl);
    expect(await core.resolveControllerAccessToken(null)).toBe("ambient-session-token");
    expectStoredBinding(null, null);
    expect(window.sessionStorage.getItem(legacyTokenStorageKey)).toBeNull();
    expect(window.sessionStorage.getItem(legacyBaseUrlStorageKey)).toBeNull();
  });

  it("lets a versioned token-only binding target the canonical controller", async () => {
    window.sessionStorage.setItem(
      bindingStorageKey,
      JSON.stringify({ version: 1, token: "canonical-override-token", baseUrl: null }),
    );
    window.sessionStorage.setItem(legacyTokenStorageKey, "legacy-custom-token");
    window.sessionStorage.setItem(
      legacyBaseUrlStorageKey,
      "https://legacy-controller.example",
    );

    const core = await import("../core");

    expect(core.controllerBaseUrl).toBe(canonicalControllerUrl);
    expect(await core.resolveControllerAccessToken(null)).toBe("canonical-override-token");
    expectStoredBinding("canonical-override-token", null);
    expect(window.sessionStorage.getItem(legacyTokenStorageKey)).toBeNull();
    expect(window.sessionStorage.getItem(legacyBaseUrlStorageKey)).toBeNull();
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed atomic binding without reviving legacy keys", async () => {
    window.sessionStorage.setItem(bindingStorageKey, "{malformed");
    window.sessionStorage.setItem(legacyTokenStorageKey, "legacy-custom-token");
    window.sessionStorage.setItem(
      legacyBaseUrlStorageKey,
      "https://legacy-controller.example",
    );

    const core = await import("../core");

    expect(core.controllerBaseUrl).toBe(canonicalControllerUrl);
    expect(await core.resolveControllerAccessToken(null)).toBe("ambient-session-token");
    expectStoredBinding(null, null);
    expect(window.sessionStorage.getItem(legacyTokenStorageKey)).toBeNull();
    expect(window.sessionStorage.getItem(legacyBaseUrlStorageKey)).toBeNull();
  });

  it("keeps the previous complete binding when an atomic replacement write fails", async () => {
    window.sessionStorage.setItem(
      bindingStorageKey,
      JSON.stringify({
        version: 1,
        token: "original-custom-token",
        baseUrl: "https://original-controller.example",
      }),
    );
    const core = await import("../core");
    expect(core.controllerBaseUrl).toBe("https://original-controller.example");

    const originalSetItem = Storage.prototype.setItem;
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key: string, value: string) {
        if (this === window.sessionStorage && key === bindingStorageKey) {
          throw new Error("simulated interrupted binding write");
        }
        return originalSetItem.call(this, key, value);
      });
    window.history.replaceState(
      null,
      "",
      "/studio?controllerUrl=https%3A%2F%2Fnext-controller.example&controllerAccessToken=next-custom-token",
    );

    core.syncControllerOverridesFromSearch(window.location.search);

    expectStoredBinding(
      "original-custom-token",
      "https://original-controller.example",
    );
    expect(core.isControllerDocumentReloadPending()).toBe(true);

    setItemSpy.mockRestore();
    window.__INSTAFY_CONTROLLER_TOKEN__ = null;
    window.__INSTAFY_CONTROLLER_BASE_URL__ = null;
    vi.resetModules();
    const reloadedCore = await import("../core");

    expect(reloadedCore.controllerBaseUrl).toBe("https://original-controller.example");
    expect(await reloadedCore.resolveControllerAccessToken(null)).toBe(
      "original-custom-token",
    );
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("keeps an explicit clear authoritative when legacy cleanup is interrupted", async () => {
    window.sessionStorage.setItem(
      bindingStorageKey,
      JSON.stringify({
        version: 1,
        token: "rejected-custom-token",
        baseUrl: "https://rejected-controller.example",
      }),
    );
    const core = await import("../core");
    window.sessionStorage.setItem(legacyTokenStorageKey, "stale-custom-token");
    window.sessionStorage.setItem(
      legacyBaseUrlStorageKey,
      "https://stale-controller.example",
    );

    const originalRemoveItem = Storage.prototype.removeItem;
    const removeItemSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, key: string) {
        if (
          this === window.sessionStorage &&
          (key === legacyTokenStorageKey || key === legacyBaseUrlStorageKey)
        ) {
          throw new Error("simulated interrupted legacy cleanup");
        }
        return originalRemoveItem.call(this, key);
      });

    core.emitControllerAuthError({ status: 401, message: "unauthorized" });

    expectStoredBinding(null, null);
    expect(window.sessionStorage.getItem(legacyTokenStorageKey)).toBe(
      "stale-custom-token",
    );
    expect(window.sessionStorage.getItem(legacyBaseUrlStorageKey)).toBe(
      "https://stale-controller.example",
    );

    window.__INSTAFY_CONTROLLER_TOKEN__ = null;
    window.__INSTAFY_CONTROLLER_BASE_URL__ = null;
    vi.resetModules();
    const reloadedCore = await import("../core");
    removeItemSpy.mockRestore();

    expect(reloadedCore.controllerBaseUrl).toBe(canonicalControllerUrl);
    expect(await reloadedCore.resolveControllerAccessToken(null)).toBe(
      "ambient-session-token",
    );
    expectStoredBinding(null, null);
  });

  it("does not fall back to an ambient token when a custom pair expires", async () => {
    const expiredToken = jwtExpiringAt(Math.floor(Date.now() / 1000) - 60);
    window.history.replaceState(
      null,
      "",
      `/studio?controllerUrl=https%3A%2F%2Fself-hosted.example&controllerAccessToken=${encodeURIComponent(expiredToken)}`,
    );

    const core = await import("../core");

    expect(core.controllerBaseUrl).toBe("https://self-hosted.example");
    expect(await core.resolveControllerAccessToken("ambient-explicit-token")).toBeNull();
    const reloadReasons: string[] = [];
    const unsubscribe = core.subscribeToControllerReloadRequired((detail) => {
      reloadReasons.push(detail.reason);
    });
    expect(getSessionMock).not.toHaveBeenCalled();
    expect(core.controllerBaseUrl).toBe("https://self-hosted.example");
    expect(core.isControllerDocumentReloadPending()).toBe(true);
    expect(reloadReasons).toEqual(["rejected-override"]);
    expectStoredBinding(null, null);
    expect(window.sessionStorage.getItem(legacyBaseUrlStorageKey)).toBeNull();
    expect(window.sessionStorage.getItem(legacyTokenStorageKey)).toBeNull();
    expect(window.location.search).toBe("");
    unsubscribe();
  });

  it("clears a rejected custom base and token together on 401", async () => {
    window.history.replaceState(
      null,
      "",
      "/studio?controllerUrl=https%3A%2F%2Fself-hosted.example&controllerAccessToken=custom-token",
    );
    const core = await import("../core");

    core.emitControllerAuthError({ status: 401, message: "unauthorized" });

    expect(core.controllerBaseUrl).toBe("https://self-hosted.example");
    expect(core.isControllerDocumentReloadPending()).toBe(true);
    expect(window.__INSTAFY_CONTROLLER_BASE_URL__).toBeNull();
    expect(window.__INSTAFY_CONTROLLER_TOKEN__).toBeNull();
    expectStoredBinding(null, null);
    expect(window.sessionStorage.getItem(legacyBaseUrlStorageKey)).toBeNull();
    expect(window.sessionStorage.getItem(legacyTokenStorageKey)).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("removes a rejected canonical token override without dropping other query params", async () => {
    window.history.replaceState(
      null,
      "",
      "/studio?keep=1&controllerAccessToken=canonical-override-token",
    );
    const core = await import("../core");

    core.emitControllerAuthError({ status: 401, message: "unauthorized" });

    expectStoredBinding(null, null);
    expect(window.sessionStorage.getItem(legacyTokenStorageKey)).toBeNull();
    expect(window.location.search).toBe("?keep=1");
    expect(core.isControllerDocumentReloadPending()).toBe(true);
    expect(await core.resolveControllerAccessToken(null)).toBeNull();
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("keeps an in-flight session resolution on the old binding when a new pair arrives", async () => {
    let resolveSession!: (value: {
      data: { session: { access_token: string } };
    }) => void;
    getSessionMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );
    window.history.replaceState(null, "", "/studio?keep=1#anchor");
    const core = await import("../core");
    const pendingContext = core.resolveControllerRequestContext(null);
    await vi.waitFor(() => expect(getSessionMock).toHaveBeenCalledOnce());

    const reloadReasons: string[] = [];
    window.addEventListener(
      core.CONTROLLER_RELOAD_REQUIRED_EVENT,
      (event) => reloadReasons.push(
        (event as CustomEvent<{ reason: string }>).detail.reason,
      ),
      { once: true },
    );
    window.history.replaceState(
      null,
      "",
      "/studio?keep=1&controllerUrl=https%3A%2F%2Fnext.example&controllerAccessToken=next-token#anchor",
    );
    core.syncControllerOverridesFromSearch(window.location.search);

    expect(core.controllerBaseUrl).toBe(canonicalControllerUrl);
    expect(core.isControllerDocumentReloadPending()).toBe(true);
    expect(window.location.search).toBe("?keep=1");
    expect(window.location.hash).toBe("#anchor");
    expectStoredBinding("next-token", "https://next.example");
    expect(reloadReasons).toEqual(["override-switch"]);

    resolveSession({
      data: { session: { access_token: "old-ambient-token" } },
    });
    await expect(pendingContext).resolves.toEqual({
      baseUrl: canonicalControllerUrl,
      accessToken: null,
      credentialSource: null,
      generation: 0,
    });
  });

  it("keeps the active ambient context current after resolving an unrelated fixed token", async () => {
    const core = await import("../core");
    const received: number[] = [];
    window.addEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, (event) => {
      received.push(
        (event as CustomEvent<{ status: number }>).detail.status,
      );
    });

    const ambientContext = await core.resolveControllerRequestContext(null);
    const unrelatedFixedContext = await core.resolveControllerRequestContext(
      "one-request-token",
    );
    expect(ambientContext.credentialSource).toBe("ambient");
    expect(unrelatedFixedContext.credentialSource).toBe("fixed");
    expect(unrelatedFixedContext.generation).toBe(ambientContext.generation);
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "ambient-session-token" } },
    });

    await core.readControllerError(
      new Response(JSON.stringify({ message: "ambient token rejected" }), {
        status: 401,
      }),
      "request failed",
      ambientContext,
    );
    expect(received).toEqual([401]);
    expect(getSessionMock).toHaveBeenCalledTimes(2);

    await core.readControllerError(
      new Response(JSON.stringify({ message: "fixed token rejected" }), {
        status: 401,
      }),
      "request failed",
      unrelatedFixedContext,
    );
    expect(getSessionMock).toHaveBeenCalledTimes(2);
    expect(received).toEqual([401]);
  });

  it("keeps contextless 401 parsing non-mutating", async () => {
    window.history.replaceState(
      null,
      "",
      "/studio?controllerAccessToken=canonical-override-token",
    );
    const core = await import("../core");
    const received: number[] = [];
    window.addEventListener(core.CONTROLLER_AUTH_ERROR_EVENT, (event) => {
      received.push(
        (event as CustomEvent<{ status: number }>).detail.status,
      );
    });

    await expect(
      core.readControllerError(
        new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 }),
        "request failed",
      ),
    ).resolves.toBe("unauthorized");
    expect(received).toEqual([]);
    expect(core.isControllerDocumentReloadPending()).toBe(false);
    expectStoredBinding("canonical-override-token", null);
  });

  it("does not expose controller mutation through postMessage", async () => {
    const core = await import("../core");

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "instafy:setControllerBaseUrl",
          url: "https://evil.example",
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "instafy:setControllerAccessToken",
          token: "message-token",
        },
      }),
    );

    expect(core.controllerBaseUrl).toBe(canonicalControllerUrl);
    expectStoredBinding(null, null);
    expect(window.sessionStorage.getItem(legacyBaseUrlStorageKey)).toBeNull();
    expect(window.sessionStorage.getItem(legacyTokenStorageKey)).toBeNull();
  });
});
