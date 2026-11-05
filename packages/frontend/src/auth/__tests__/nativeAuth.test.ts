import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimNativeAuthCallback,
  clearNativeAuthCallbackAttemptId,
  clearSignInReturnPath,
  clearPendingNativeAuthAttempt,
  createPendingNativeAuthAttempt,
  forgetNativeAuthCallbackClaimsForTests,
  isNativeAuthCallbackClaimed,
  isTokenPairNativeAuthCallback,
  nativeAuthAttemptProvider,
  nativeAuthCallbackErrorMessage,
  parseNativeAuthCallbackUrl,
  readNativeAuthCallbackAttemptId,
  readNativeAuthCallbackParams,
  readSignInReturnPath,
  readPendingNativeAuthAttempt,
  releaseNativeAuthCallbackUrlClaims,
  writeNativeAuthCallbackAttemptId,
  writeSignInReturnPath,
  writePendingNativeAuthAttempt,
} from "../nativeAuth";

function createSessionStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("window", {
    sessionStorage: createSessionStorageMock(),
    localStorage: createSessionStorageMock(),
  });
});

afterEach(() => {
  clearNativeAuthCallbackAttemptId();
  clearPendingNativeAuthAttempt();
  forgetNativeAuthCallbackClaimsForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("parseNativeAuthCallbackUrl", () => {
  it("accepts the standard native callback host", () => {
    const parsed = parseNativeAuthCallbackUrl("instafy://auth?code=test-code");

    expect(parsed).not.toBeNull();
    expect(parsed?.searchParams.get("code")).toBe("test-code");
  });

  it("accepts callback URLs that arrive via the auth path instead of hostname", () => {
    const parsed = parseNativeAuthCallbackUrl("instafy:///auth?code=test-code");

    expect(parsed).not.toBeNull();
    expect(parsed?.searchParams.get("code")).toBe("test-code");
  });

  it("accepts Android callback URLs that parse auth as a double-slash pathname", () => {
    const parsed = parseNativeAuthCallbackUrl("instafy://auth#access_token=test-token&refresh_token=test-refresh");

    expect(parsed).not.toBeNull();
    expect(parsed?.hash).toContain("access_token=test-token");
  });

  it("accepts the legacy Android app-id scheme callback", () => {
    const parsed = parseNativeAuthCallbackUrl("dev.instafy.studio://auth?code=test-code");

    expect(parsed).not.toBeNull();
    expect(parsed?.searchParams.get("code")).toBe("test-code");
  });

  it("accepts the legacy Android app-id path-style callback", () => {
    const parsed = parseNativeAuthCallbackUrl("dev.instafy.studio:///auth?code=test-code");

    expect(parsed).not.toBeNull();
    expect(parsed?.searchParams.get("code")).toBe("test-code");
  });

  it("rejects unrelated deep links", () => {
    expect(parseNativeAuthCallbackUrl("instafy://studio?code=test-code")).toBeNull();
    expect(parseNativeAuthCallbackUrl("https://instafy.dev/login?code=test-code")).toBeNull();
  });
});

describe("pending native auth attempt storage", () => {
  it("persists and restores pending auth attempts", () => {
    const attempt = createPendingNativeAuthAttempt("github");

    writePendingNativeAuthAttempt(attempt);

    expect(readPendingNativeAuthAttempt()).toEqual(attempt);
  });

  it("returns null for malformed stored attempts", () => {
    window.localStorage.setItem("instafy.login.nativeAuthAttempt", JSON.stringify({ provider: "github" }));

    expect(readPendingNativeAuthAttempt()).toBeNull();
  });

  // Android can end the app's process while the provider's custom tab is in
  // front; the deep link then starts a new process with an empty
  // sessionStorage.
  it("keeps the attempt when the process that started it is gone", () => {
    writePendingNativeAuthAttempt(createPendingNativeAuthAttempt("google"));
    vi.stubGlobal("window", { sessionStorage: createSessionStorageMock(), localStorage: window.localStorage });

    expect(nativeAuthAttemptProvider(readPendingNativeAuthAttempt())).toBe("google");
  });

  it("ignores an attempt abandoned more than 30 minutes ago", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T08:00:00Z"));
    writePendingNativeAuthAttempt(createPendingNativeAuthAttempt("google"));

    vi.setSystemTime(new Date("2026-10-28T08:29:00Z"));
    expect(readPendingNativeAuthAttempt()?.provider).toBe("google");

    vi.setSystemTime(new Date("2026-10-28T08:31:00Z"));
    expect(readPendingNativeAuthAttempt()).toBeNull();
  });
});

describe("claimNativeAuthCallback", () => {
  const claim = (url: string) => claimNativeAuthCallback(parseNativeAuthCallbackUrl(url)!);

  it("lets exactly one handler take a code, however the callback is spelled", () => {
    expect(claim("instafy://auth?code=abc")).toBe(true);
    expect(claim("instafy://auth?code=abc")).toBe(false);
    expect(claim("instafy://auth/?code=abc")).toBe(false);
    expect(claim("instafy://auth#code=abc")).toBe(false);
    expect(claim("instafy://auth?code=def")).toBe(true);
  });

  // App.getLaunchUrl() keeps returning the launch URL for the life of the
  // process, so a reloaded page sees the same spent code again.
  it("does not hand a reloaded page a code it already claimed, and keeps only a hash", async () => {
    expect(claim("instafy://auth?code=launch-code")).toBe(true);
    expect(JSON.stringify(window.sessionStorage.getItem("instafy.login.nativeAuthClaimedCodes"))).not.toContain(
      "launch-code",
    );

    vi.resetModules();
    const reloaded = await import("../nativeAuth");
    expect(reloaded.claimNativeAuthCallback(reloaded.parseNativeAuthCallbackUrl("instafy://auth?code=launch-code")!)).toBe(false);

    vi.resetModules();
    window.sessionStorage.clear();
    const newProcess = await import("../nativeAuth");
    expect(newProcess.claimNativeAuthCallback(newProcess.parseNativeAuthCallbackUrl("instafy://auth?code=launch-code")!)).toBe(true);
  });

  it("claims a callback without a code by its URL", () => {
    expect(claim("instafy://auth?error=access_denied")).toBe(true);
    expect(claim("instafy://auth?error=access_denied")).toBe(false);
    expect(claim("instafy://auth?error=server_error")).toBe(true);
  });

  // The handlers exchange the first code that is not blank, the query's before
  // the fragment's, so a blank query value must not hide the fragment's code
  // from the claim or from the hash kept for a reloaded page.
  it("knows a code by the one the handlers exchange, also after a reload", async () => {
    expect(claim("instafy://auth?code=abc")).toBe(true);
    expect(claim("instafy://auth?code=%20#code=abc")).toBe(false);
    expect(claim("instafy://auth?code=%20#code=def")).toBe(true);

    vi.resetModules();
    const reloaded = await import("../nativeAuth");
    const claimAfterReload = (url: string) =>
      reloaded.claimNativeAuthCallback(reloaded.parseNativeAuthCallbackUrl(url)!);
    expect(claimAfterReload("instafy://auth?code=%20#code=abc")).toBe(false);
    expect(claimAfterReload("instafy://auth?code=%20#code=def")).toBe(false);
  });
});

describe("isNativeAuthCallbackClaimed", () => {
  const callback = (url: string) => parseNativeAuthCallbackUrl(url)!;

  it("reports a claim without making one", () => {
    expect(isNativeAuthCallbackClaimed(callback("instafy://auth?code=abc"))).toBe(false);
    expect(isNativeAuthCallbackClaimed(callback("instafy://auth?code=abc"))).toBe(false);
    // Asking left it for a handler to claim.
    expect(claimNativeAuthCallback(callback("instafy://auth?code=abc"))).toBe(true);
    expect(isNativeAuthCallbackClaimed(callback("instafy://auth?code=abc"))).toBe(true);
  });

  it("knows a callback by the same key the claim uses", () => {
    claimNativeAuthCallback(callback("instafy://auth?code=abc"));
    expect(isNativeAuthCallbackClaimed(callback("instafy://auth#code=abc"))).toBe(true);
    expect(isNativeAuthCallbackClaimed(callback("instafy://auth?code=def"))).toBe(false);

    claimNativeAuthCallback(callback("instafy://auth?error=access_denied"));
    expect(isNativeAuthCallbackClaimed(callback("instafy://auth?error=access_denied"))).toBe(true);
    releaseNativeAuthCallbackUrlClaims();
    expect(isNativeAuthCallbackClaimed(callback("instafy://auth?error=access_denied"))).toBe(false);
    expect(isNativeAuthCallbackClaimed(callback("instafy://auth?code=abc"))).toBe(true);
  });

  // A reloaded page is handed the launch URL again, whose code the page before
  // the reload claimed. The desktop queue asks this before keeping a callback,
  // so a spent code must not take the place of a live one there.
  it("knows a code claimed before a reload, as the claim does", async () => {
    expect(claimNativeAuthCallback(callback("instafy://auth?code=launch-code"))).toBe(true);

    vi.resetModules();
    const reloaded = await import("../nativeAuth");
    const reloadedCallback = (url: string) => reloaded.parseNativeAuthCallbackUrl(url)!;
    expect(reloaded.isNativeAuthCallbackClaimed(reloadedCallback("instafy://auth?code=launch-code"))).toBe(true);
    expect(reloaded.isNativeAuthCallbackClaimed(reloadedCallback("instafy://auth#code=launch-code"))).toBe(true);
    expect(reloaded.claimNativeAuthCallback(reloadedCallback("instafy://auth?code=launch-code"))).toBe(false);

    expect(reloaded.isNativeAuthCallbackClaimed(reloadedCallback("instafy://auth?code=live-code"))).toBe(false);
    expect(reloaded.claimNativeAuthCallback(reloadedCallback("instafy://auth?code=live-code"))).toBe(true);
  });
});

describe("readNativeAuthCallbackParams", () => {
  const read = (url: string) => readNativeAuthCallbackParams(parseNativeAuthCallbackUrl(url)!);

  it("reads the query before the fragment", () => {
    expect(read("instafy://auth?code=from-query#code=from-fragment").code).toBe("from-query");
    expect(read("instafy://auth#access_token=a&refresh_token=r")).toEqual({
      code: null,
      accessToken: "a",
      refreshToken: "r",
      oauthError: null,
    });
  });

  it("trims values and passes over blank ones", () => {
    expect(read("instafy://auth?code=%20abc%20").code).toBe("abc");
    // A blank query value does not hide the fragment's.
    expect(read("instafy://auth?code=%20#code=from-fragment").code).toBe("from-fragment");
    expect(read("instafy://auth?code=&access_token=%20%20")).toEqual({
      code: null,
      accessToken: null,
      refreshToken: null,
      oauthError: null,
    });
  });

  it("prefers the provider's error_description to its error, wherever each is", () => {
    expect(read("instafy://auth?error=access_denied&error_description=The+user+denied+access").oauthError).toBe(
      "The user denied access",
    );
    expect(read("instafy://auth?error=access_denied#error_description=denied").oauthError).toBe("denied");
    expect(read("instafy://auth?error=access_denied").oauthError).toBe("access_denied");
    expect(read("instafy://auth").oauthError).toBeNull();
  });
});

describe("isTokenPairNativeAuthCallback", () => {
  const isTokenPair = (url: string) =>
    isTokenPairNativeAuthCallback(readNativeAuthCallbackParams(parseNativeAuthCallbackUrl(url)!));

  // Every sign-in the apps start is PKCE and returns a code, so tokens were
  // put there by whoever opened the link.
  it("picks out a callback that carries session tokens instead of a code or a refusal", () => {
    expect(isTokenPair("instafy://auth#access_token=a&refresh_token=r&expires_in=3600&token_type=bearer")).toBe(true);
    expect(isTokenPair("instafy://auth?refresh_token=r")).toBe(true);
    expect(isTokenPair("instafy://auth?access_token=a")).toBe(true);
  });

  it("leaves a code, a refusal and an empty callback to the handlers", () => {
    expect(isTokenPair("instafy://auth?code=abc#access_token=a&refresh_token=r")).toBe(false);
    expect(isTokenPair("instafy://auth?error=access_denied#access_token=a&refresh_token=r")).toBe(false);
    expect(isTokenPair("instafy://auth?code=abc")).toBe(false);
    expect(isTokenPair("instafy://auth?error=access_denied")).toBe(false);
    expect(isTokenPair("instafy://auth")).toBe(false);
  });
});

describe("native auth attempt provider", () => {
  it("names the provider the attempt started with, and GitHub when there is none", () => {
    writePendingNativeAuthAttempt(createPendingNativeAuthAttempt("Google"));
    expect(nativeAuthAttemptProvider(readPendingNativeAuthAttempt())).toBe("google");

    writePendingNativeAuthAttempt(createPendingNativeAuthAttempt("github"));
    expect(nativeAuthAttemptProvider(readPendingNativeAuthAttempt())).toBe("github");

    expect(nativeAuthAttemptProvider(null)).toBe("github");
    expect(nativeAuthAttemptProvider({ provider: "unknown" })).toBe("github");
  });
});

describe("native auth callback error message", () => {
  it("names the provider and never carries the callback's error text", () => {
    expect(nativeAuthCallbackErrorMessage("google")).toBe("Google sign-in was cancelled or refused. Try again.");
    expect(nativeAuthCallbackErrorMessage("github")).toBe("GitHub sign-in was cancelled or refused. Try again.");
  });
});

describe("native auth callback attempt storage", () => {
  it("persists and clears the callback-started attempt id", () => {
    writeNativeAuthCallbackAttemptId("attempt-123");

    expect(readNativeAuthCallbackAttemptId()).toBe("attempt-123");

    clearNativeAuthCallbackAttemptId();

    expect(readNativeAuthCallbackAttemptId()).toBeNull();
  });
});

describe("OAuth redirect target", () => {
  it("keeps a native sign-in's destination for a new process, and a web one in its tab", () => {
    writeSignInReturnPath("/studio?projectId=p1", { durable: true });
    window.sessionStorage.clear();
    expect(readSignInReturnPath()).toBe("/studio?projectId=p1");

    clearSignInReturnPath();
    writeSignInReturnPath("/studio?projectId=p2", { durable: false });
    expect(readSignInReturnPath()).toBe("/studio?projectId=p2");
    window.sessionStorage.clear();
    expect(readSignInReturnPath()).toBeNull();
  });

  it("ignores a stale or off-site destination", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T08:00:00Z"));
    writeSignInReturnPath("/studio?projectId=p1", { durable: true });
    window.sessionStorage.clear();
    vi.setSystemTime(new Date("2026-10-28T08:31:00Z"));
    expect(readSignInReturnPath()).toBeNull();

    writeSignInReturnPath("//elsewhere.example/studio", { durable: true });
    expect(readSignInReturnPath()).toBeNull();
    window.localStorage.setItem(
      "instafy.login.returnPathDurable",
      JSON.stringify({ path: "https://elsewhere.example/", savedAt: new Date().toISOString() }),
    );
    expect(readSignInReturnPath()).toBeNull();
  });

  // A browser reads /\host as another host, and /<tab>/host too once it drops
  // the tab; the router refuses to go to either.
  it("ignores a destination with a backslash or a control character", () => {
    for (const path of ["/\\evil.example", "/\t/evil.example", "/studio?projectId=p1\u0000"]) {
      writeSignInReturnPath(path, { durable: true });
      expect(readSignInReturnPath()).toBeNull();
    }

    // Kept before this check existed.
    window.sessionStorage.setItem("instafy.login.returnPath", "/\\evil.example");
    window.localStorage.setItem(
      "instafy.login.returnPathDurable",
      JSON.stringify({ path: "/\n/evil.example", savedAt: new Date().toISOString() }),
    );
    expect(readSignInReturnPath()).toBeNull();
    expect(window.localStorage.getItem("instafy.login.returnPathDurable")).toBeNull();

    writeSignInReturnPath("/studio?projectId=p1&tab=chat#message-1", { durable: true });
    expect(readSignInReturnPath()).toBe("/studio?projectId=p1&tab=chat#message-1");
  });

  // The path can carry an invite's token, so a stale copy does not stay on the device.
  it("removes a stale kept copy when it reads it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T08:00:00Z"));
    writeSignInReturnPath("/invite?token=T", { durable: true });
    window.sessionStorage.clear();
    vi.setSystemTime(new Date("2026-10-28T08:31:00Z"));

    expect(readSignInReturnPath()).toBeNull();
    expect(window.localStorage.getItem("instafy.login.returnPathDurable")).toBeNull();
  });

  it("forgets both copies once sign-in finishes", () => {
    writeSignInReturnPath("/studio?projectId=p1", { durable: true });
    clearSignInReturnPath();
    expect(readSignInReturnPath()).toBeNull();
  });
});
