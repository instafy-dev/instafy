import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearNativeAuthCallbackAttemptId,
  clearPendingNativeAuthAttempt,
  createPendingNativeAuthAttempt,
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
  });
});

afterEach(() => {
  clearNativeAuthCallbackAttemptId();
  clearPendingNativeAuthAttempt();
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
    window.sessionStorage.setItem("instafy.login.nativeAuthAttempt", JSON.stringify({ provider: "github" }));

    expect(readPendingNativeAuthAttempt()).toBeNull();
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
