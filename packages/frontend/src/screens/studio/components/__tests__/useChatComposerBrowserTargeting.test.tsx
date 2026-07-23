// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatComposerBrowserTargeting } from "../useChatComposerBrowserTargeting";
import type { BrowserTransport } from "../usePersonalBrowserBridge";

const browserPages = [
  {
    id: "shared-page-1",
    url: "https://example.com/",
    host: "example.com",
    label: "Example",
    title: "Example",
    lastReferencedAt: 1,
    isActive: true,
  },
];
const blankBrowserPage = {
  id: "shared-page-blank",
  url: "about:blank",
  host: "",
  label: "New tab",
  title: null,
  lastReferencedAt: 2,
  isActive: false,
};

const { focusPageMock, useBrowserSessionPagesMock } = vi.hoisted(() => ({
  focusPageMock: vi.fn(async () => true),
  useBrowserSessionPagesMock: vi.fn(),
}));

vi.mock("../useBrowserSessionPages", () => ({
  useBrowserSessionPages: useBrowserSessionPagesMock,
}));

type HookResult = ReturnType<typeof useChatComposerBrowserTargeting>;

describe("useChatComposerBrowserTargeting", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestResult: HookResult | null;
  const focusInput = vi.fn();
  const openBrowserSession = vi.fn();
  const requestBrowserSessionExpand = vi.fn();
  const showStatus = vi.fn();

  function Harness({ browserTransport }: { browserTransport: BrowserTransport }) {
    latestResult = useChatComposerBrowserTargeting({
      activeConversationId: "conversation-1",
      activeProjectId: "project-1",
      browserSessionOpen: true,
      browserSessionId: "browser-surface-1",
      sharedBrowserActivated: true,
      browserTransport,
      compactBrowserViewport: false,
      focusInput,
      hasHiddenBrowserSession: false,
      messages: [],
      onHiddenBrowserSessionUnavailable: vi.fn(),
      openBrowserSession,
      preferredBrowserRuntimeId: "runtime-1",
      requestBrowserSessionExpand,
      resolvedBrowserRuntimeId: "runtime-1",
      showStatus,
    });
    return null;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latestResult = null;
    focusInput.mockClear();
    focusPageMock.mockClear();
    openBrowserSession.mockClear();
    requestBrowserSessionExpand.mockClear();
    showStatus.mockClear();
    useBrowserSessionPagesMock.mockClear();
    useBrowserSessionPagesMock.mockReturnValue({
      pages: [blankBrowserPage, ...browserPages],
      resolved: true,
      focusPage: focusPageMock,
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("exposes live Shared pages and supports Shared page selection", async () => {
    await act(async () => {
      root.render(<Harness browserTransport="shared" />);
    });

    expect(useBrowserSessionPagesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        browserSessionId: "browser-surface-1",
        includePlaceholder: true,
      }),
    );
    expect(latestResult?.browserSessionPages).toEqual(browserPages);
    expect(latestResult?.sharedBrowserChromePages).toEqual([
      blankBrowserPage,
      ...browserPages,
    ]);
    expect(latestResult?.preferredBrowserPage).toEqual(browserPages[0]);

    await act(async () => {
      await latestResult?.handleSelectBrowserSessionPage("shared-page-1");
    });
    expect(focusPageMock).toHaveBeenCalledWith("shared-page-1");
  });

  it("clears and blocks Shared page targeting after switching to Personal", async () => {
    await act(async () => {
      root.render(<Harness browserTransport="shared" />);
    });
    await act(async () => {
      latestResult?.handlePrepareNewBrowserSession();
    });
    expect(latestResult?.pendingBrowserLaunchMode).toBe("new_page");

    await act(async () => {
      root.render(<Harness browserTransport="personal" />);
    });

    expect(useBrowserSessionPagesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    expect(latestResult?.browserSessionPages).toEqual([]);
    expect(latestResult?.sharedBrowserChromePages).toEqual([
      blankBrowserPage,
      ...browserPages,
    ]);
    expect(latestResult?.preferredBrowserPage).toBeNull();
    expect(latestResult?.pendingBrowserLaunchMode).toBeNull();
    expect(latestResult?.showBrowserSessionPageStrip).toBe(false);

    await act(async () => {
      latestResult?.setPendingBrowserLaunchMode("new_page");
      latestResult?.handlePrepareNewBrowserSession();
      await latestResult?.handleSelectBrowserSessionPage("shared-page-1");
    });

    expect(latestResult?.pendingBrowserLaunchMode).toBeNull();
    expect(focusPageMock).not.toHaveBeenCalled();
  });
});
