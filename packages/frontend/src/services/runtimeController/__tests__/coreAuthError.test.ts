// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONTROLLER_AUTH_ERROR_EVENT,
  clearControllerAccessTokenOverride,
  emitControllerAuthError,
  syncControllerAccessTokenFromSearch,
} from "../core";

function futureJwt(): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: "00000000-0000-4000-8000-000000000001",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`;
}

describe("emitControllerAuthError with an injected override token", () => {
  const received: number[] = [];
  const listener = (event: Event) => {
    received.push((event as CustomEvent<{ status: number }>).detail.status);
  };

  let nowOffset = 0;

  beforeEach(() => {
    received.length = 0;
    window.addEventListener(CONTROLLER_AUTH_ERROR_EVENT, listener);
    // Step past the emitter's 2s debounce between tests and between emits.
    const realNow = Date.now.bind(Date);
    nowOffset += 60_000;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + nowOffset);
  });

  afterEach(() => {
    window.removeEventListener(CONTROLLER_AUTH_ERROR_EVENT, listener);
    clearControllerAccessTokenOverride();
    window.sessionStorage.removeItem("instafy.controllerAccessToken");
    vi.restoreAllMocks();
  });

  it("drops a stale override on 401 instead of escalating to sign-out", () => {
    // A previous invite/device-handoff visit leaves an unexpired override
    // behind; a freshly signed-in user must not be signed out because of it.
    syncControllerAccessTokenFromSearch(`?controllerAccessToken=${futureJwt()}`);

    emitControllerAuthError({ status: 401, message: "unauthorized (401)" });
    expect(received).toEqual([]);
    expect(window.sessionStorage.getItem("instafy.controllerAccessToken")).toBeNull();

    // 401s from requests that were already in flight with the dead override
    // land inside the grace window and must not escalate either.
    emitControllerAuthError({ status: 401, message: "unauthorized (401)" });
    expect(received).toEqual([]);

    // Past the grace window with no override, a 401 means the real session is
    // bad and the sign-out flow must engage.
    nowOffset += 60_000;
    emitControllerAuthError({ status: 401, message: "unauthorized (401)" });
    expect(received).toEqual([401]);
  });

  it("does not consume the override for non-401 auth errors", () => {
    syncControllerAccessTokenFromSearch(`?controllerAccessToken=${futureJwt()}`);

    emitControllerAuthError({ status: 403, message: "forbidden (403)" });
    expect(received).toEqual([403]);
    expect(window.sessionStorage.getItem("instafy.controllerAccessToken")).not.toBeNull();
  });
});
