import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimNativeAuthCallback,
  clearNativeAuthCallbackAttemptId,
  clearPendingNativeAuthAttempt,
  createPendingNativeAuthAttempt,
  forgetNativeAuthCallbackClaimsForTests,
  nativeAuthAttemptProvider,
  nativeAuthCallbackErrorMessage,
  parseNativeAuthCallbackUrl,
  readNativeAuthCallbackAttemptId,
  readPendingNativeAuthAttempt,
  writeNativeAuthCallbackAttemptId,
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

  it("claims a callback without a code by its URL", () => {
    expect(claim("instafy://auth?error=access_denied")).toBe(true);
    expect(claim("instafy://auth?error=access_denied")).toBe(false);
    expect(claim("instafy://auth?error=server_error")).toBe(true);
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
