import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeMocks = vi.hoisted(() => ({
  addListener: vi.fn(),
  getLaunchUrl: vi.fn(),
  isNativePlatform: vi.fn(),
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: nativeMocks.addListener,
    getLaunchUrl: nativeMocks.getLaunchUrl,
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: nativeMocks.isNativePlatform,
  },
}));

import {
  buildNativeStudioDeepLink,
  installNativeDeepLinkBootstrap,
  resolveNativeAppNavigationTarget,
} from "../nativeDeepLinks";

beforeEach(() => {
  nativeMocks.addListener.mockReset();
  nativeMocks.getLaunchUrl.mockReset();
  nativeMocks.isNativePlatform.mockReset();
  nativeMocks.isNativePlatform.mockReturnValue(true);
  nativeMocks.getLaunchUrl.mockResolvedValue(null);
  nativeMocks.addListener.mockResolvedValue({ remove: vi.fn() });
  vi.stubGlobal("window", {
    location: {
      hostname: "instafy.dev",
      origin: "https://instafy.dev",
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveNativeAppNavigationTarget", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const runtimeId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  it("builds a token-free studio handoff deep link", () => {
    const result = buildNativeStudioDeepLink({
      projectId: "project-1",
      conversationControllerId: "conversation-1",
      panel: "chat",
    });

    expect(result).toBe(
      "instafy://studio?projectId=project-1&conversationControllerId=conversation-1&panel=chat",
    );
    expect(result).not.toContain("token=");
    expect(result).not.toContain("role=");
  });

  it("maps custom-scheme invite links to app routes", () => {
    expect(
      resolveNativeAppNavigationTarget(
        "instafy://invite?token=abc&projectId=proj-1&panel=chat",
      ),
    ).toBe("/invite?token=abc&projectId=proj-1&panel=chat");
  });

  it("maps path-style custom-scheme studio links to app routes", () => {
    expect(
      resolveNativeAppNavigationTarget(
        "instafy:///studio?projectId=proj-1&conversationId=conv-1",
      ),
    ).toBe("/studio?projectId=proj-1&conversationId=conv-1");
  });

  it("accepts public https invite links for the configured app host", () => {
    expect(
      resolveNativeAppNavigationTarget(
        "https://instafy.dev/invite?token=abc&projectId=proj-1&panel=chat",
      ),
    ).toBe("/invite?token=abc&projectId=proj-1&panel=chat");
  });

  it("rejects auth callbacks so login flow keeps handling them", () => {
    expect(resolveNativeAppNavigationTarget("instafy://auth?code=test-code")).toBeNull();
    expect(resolveNativeAppNavigationTarget("dev.instafy.studio://auth?code=test-code")).toBeNull();
  });

  it("rejects unrelated external hosts", () => {
    expect(
      resolveNativeAppNavigationTarget(
        "https://example.com/invite?token=abc&projectId=proj-1&panel=chat",
      ),
    ).toBeNull();
  });

  it("builds and receives a token-free Shared Browser locator for a native device", () => {
    const link = buildNativeStudioDeepLink({
      projectId,
      browserRuntimeId: runtimeId,
      conversationControllerId: "conversation-1",
      panel: "files",
    });
    expect(link).toBe(`instafy://studio?projectId=${projectId}&panel=chat&browserRuntimeId=${runtimeId.toLowerCase()}`);
    expect(resolveNativeAppNavigationTarget(link)).toBe(
      `/studio?projectId=${projectId}&panel=chat&browserRuntimeId=${runtimeId.toLowerCase()}`,
    );
  });

  it("preserves a valid public Shared Browser locator and normalizes its runtime ID", () => {
    expect(resolveNativeAppNavigationTarget(
      `https://instafy.dev/studio?projectId=${projectId}&panel=chat&browserRuntimeId=${runtimeId}`,
    )).toBe(`/studio?projectId=${projectId}&panel=chat&browserRuntimeId=${runtimeId.toLowerCase()}`);
  });

  it.each([
    "not-a-runtime",
    "https%3A%2F%2Fexample.test",
    `${runtimeId}&browserRuntimeId=${runtimeId}`,
  ])("keeps normal navigation without forwarding an invalid/duplicate runtime locator: %s", (value) => {
    expect(resolveNativeAppNavigationTarget(
      `instafy://studio?projectId=${projectId}&panel=chat&browserRuntimeId=${value}`,
    )).toBe(`/studio?projectId=${projectId}&panel=chat`);
  });

  it("omits a runtime from a builder request without a valid project or runtime", () => {
    expect(buildNativeStudioDeepLink({ projectId: "project-1", browserRuntimeId: runtimeId })).toBe(
      "instafy://studio?projectId=project-1",
    );
    expect(buildNativeStudioDeepLink({ projectId, browserRuntimeId: "not-a-runtime" })).toBe(
      `instafy://studio?projectId=${projectId}`,
    );
  });
});

describe("installNativeDeepLinkBootstrap", () => {
  it("opens a Shared Browser locator on a cold native launch without copying a grant", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const runtimeId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    nativeMocks.getLaunchUrl.mockResolvedValue({
      url: buildNativeStudioDeepLink({ projectId, browserRuntimeId: runtimeId }),
    });
    const navigate = vi.fn();
    installNativeDeepLinkBootstrap({ navigate });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(
      `/studio?projectId=${projectId}&panel=chat&browserRuntimeId=${runtimeId.toLowerCase()}`,
    ));
  });

  it("navigates a cold native launch into the requested studio space", async () => {
    nativeMocks.getLaunchUrl.mockResolvedValue({
      url: "instafy://studio?projectId=11111111-1111-4111-8111-111111111111&panel=chat",
    });
    const navigate = vi.fn();

    installNativeDeepLinkBootstrap({ navigate });

    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        "/studio?projectId=11111111-1111-4111-8111-111111111111&panel=chat",
      );
    });
  });

  it("handles a studio handoff while the native app is already open", async () => {
    let appUrlOpenHandler: ((event: { url?: string | null }) => void) | null = null;
    nativeMocks.addListener.mockImplementation(
      async (_eventName: string, handler: (event: { url?: string | null }) => void) => {
        appUrlOpenHandler = handler;
        return { remove: vi.fn() };
      },
    );
    const navigate = vi.fn();

    installNativeDeepLinkBootstrap({ navigate });
    await vi.waitFor(() => expect(appUrlOpenHandler).not.toBeNull());
    (appUrlOpenHandler as unknown as (event: { url?: string | null }) => void)({
      url: "instafy://studio?projectId=22222222-2222-4222-8222-222222222222&panel=files",
    });

    expect(navigate).toHaveBeenCalledWith(
      "/studio?projectId=22222222-2222-4222-8222-222222222222&panel=files",
    );
  });
});
