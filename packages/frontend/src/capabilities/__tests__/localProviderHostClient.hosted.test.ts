// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://instafy.dev/studio"}

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveExtensionPanelSectionNotice } from "../../extensions/extensionPanelSectionContent";
import {
  isLocalProviderHostUnavailableOnThisClient,
  listLocalProviders,
} from "../localProviderHostClient";

// A live test of the hosted Studio showed the Extensions panel saying
// "Local providers unavailable — Failed to fetch". The browser tab asked the
// provider host on this computer (127.0.0.1), which only answers Instafy
// Desktop and local development pages, so the request could never succeed.
// The client binds fetch when the module loads, so replace it first.
const { fetchMock, originalFetch } = vi.hoisted(() => {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, originalFetch };
});

describe("local provider host from a hosted Studio tab", () => {
  beforeEach(() => {
    fetchMock.mockReset().mockRejectedValue(new TypeError("Failed to fetch"));
  });

  afterEach(() => {
    delete (window as { instafyDesktop?: unknown }).instafyDesktop;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  async function extensionsNotice() {
    const localProvidersError = await listLocalProviders().then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    return resolveExtensionPanelSectionNotice({
      activeProjectId: "project-1",
      localProvidersError,
      localProviderHostUnavailableOnThisClient: isLocalProviderHostUnavailableOnThisClient(),
      projectIntegrationsError: null,
      localProvidersLoading: false,
      projectIntegrationsLoading: false,
      projectExtensionsCount: 0,
    });
  }

  it("does not ask the provider host on this computer, and says what is true", async () => {
    expect(window.location.origin).toBe("https://instafy.dev");
    expect(isLocalProviderHostUnavailableOnThisClient()).toBe(true);
    await expect(listLocalProviders()).rejects.toThrow(
      "Extensions on this computer are available in Instafy Desktop.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await extensionsNotice()).toEqual({
      tone: "info",
      title: "No extensions yet",
      message: "Open Instafy on a phone or desktop to add a camera or board.",
    });
  });

  it("still asks it inside Instafy Desktop, which the host answers", async () => {
    (window as { instafyDesktop?: unknown }).instafyDesktop = {};
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, providers: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect(isLocalProviderHostUnavailableOnThisClient()).toBe(false);
    await expect(listLocalProviders()).resolves.toEqual({ ok: true, providers: [] });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8797/providers", undefined);
  });
});
