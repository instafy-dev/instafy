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

  function Harness({ browserTransport, pagesActive }: { browserTransport: BrowserTransport; pagesActive?: boolean }) {
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
      sharedBrowserPagesActive: pagesActive,
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

  it("binds a task to the blank tab of a browser that just started, without targeting it", async () => {
    const restartedBlankTab = { ...blankBrowserPage, isActive: true };
    useBrowserSessionPagesMock.mockReturnValue({
      pages: [restartedBlankTab],
      resolved: true,
      focusPage: focusPageMock,
    });
    await act(async () => {
      root.render(<Harness browserTransport="shared" />);
    });

    // The browser bar still lists the blank tab, but nothing names it.
    expect(latestResult?.sharedBrowserChromePages).toEqual([restartedBlankTab]);
    expect(latestResult?.browserSessionPages).toEqual([]);
    expect(latestResult?.preferredBrowserPage).toBeNull();
    expect(latestResult?.sharedBrowserBindingPage).toEqual(restartedBlankTab);
  });

  it("binds a task to the real page over an active blank tab", async () => {
    useBrowserSessionPagesMock.mockReturnValue({
      pages: [{ ...blankBrowserPage, isActive: true }, { ...browserPages[0], isActive: false }],
      resolved: true,
      focusPage: focusPageMock,
    });
    await act(async () => {
      root.render(<Harness browserTransport="shared" />);
    });

    expect(latestResult?.preferredBrowserPage?.id).toBe("shared-page-1");
    expect(latestResult?.sharedBrowserBindingPage?.id).toBe("shared-page-1");
  });

  it("offers no page to bind to before the live pages are read", async () => {
    useBrowserSessionPagesMock.mockReturnValue({
      pages: [],
      resolved: false,
      focusPage: focusPageMock,
    });
    await act(async () => {
      root.render(<Harness browserTransport="shared" />);
    });

    expect(latestResult?.sharedBrowserBindingPage).toBeNull();
  });

  it("reads the pages only while the browser view is opening or live", async () => {
    await act(async () => {
      root.render(<Harness browserTransport="shared" />);
    });
    expect(useBrowserSessionPagesMock).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, pollPages: true }));
    await act(async () => {
      root.render(<Harness browserTransport="shared" pagesActive={false} />);
    });
    expect(useBrowserSessionPagesMock).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, pollPages: false }));
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
    expect(latestResult?.sharedBrowserBindingPage).toBeNull();
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

  it("describes a pending request without changing the current page and lets it be canceled", async () => {
    await act(async () => {
      root.render(<Harness browserTransport="shared" />);
    });
    await act(async () => {
      latestResult?.handlePrepareNewBrowserSession();
    });
    expect(latestResult?.pendingBrowserLaunchMode).toBe("new_page");
    expect(latestResult?.browserSessionPages).toEqual(browserPages);
    expect(focusPageMock).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenLastCalledWith(
      "Your next AI message will request a new tab while keeping the existing pages available.",
      "info",
      3000,
    );
    expect(focusInput).toHaveBeenLastCalledWith({ force: true });

    await act(async () => {
      latestResult?.handleClearPendingNewBrowserSession();
    });
    expect(latestResult?.pendingBrowserLaunchMode).toBeNull();
    expect(latestResult?.browserSessionPages).toEqual(browserPages);
    expect(showStatus).toHaveBeenLastCalledWith(
      "New tab request canceled. Existing browser pages are unchanged.",
      "info",
      2500,
    );
  });
});
