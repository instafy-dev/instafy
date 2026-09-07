// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatBrowserSessionState } from "../useChatBrowserSessionState";

type BrowserSessionState = ReturnType<typeof useChatBrowserSessionState>;

const setSessionRuntimeOverride = vi.fn();
function TestHarness({ resultRef, userId = "user-1", projectId = "project-1" }: {
  resultRef: { current: BrowserSessionState | null }; userId?: string | null; projectId?: string;
}) {
  resultRef.current = useChatBrowserSessionState({
    currentUserId: userId,
    activeConversationControllerId: "controller-conversation-1",
    activeConversationId: "conversation-1",
    activeProjectId: projectId,
    effectiveRuntimeId: null,
    preferredRuntimeId: null,
    refreshRuntimeStatuses: vi.fn(),
    setSessionRuntimeOverride,
  });
  return null;
}

describe("useChatBrowserSessionState", () => {
  let container: HTMLDivElement;
  let root: Root;
  let resultRef: { current: BrowserSessionState | null };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.sessionStorage.clear();
    setSessionRuntimeOverride.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resultRef = { current: null };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.sessionStorage.clear();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("reopens a hidden browser session with its resolved runtime", async () => {
    await act(async () => {
      root.render(<TestHarness resultRef={resultRef} />);
    });

    await act(async () => {
      resultRef.current?.openBrowserSession("runtime-1");
    });
    expect(resultRef.current?.browserSessionOpen).toBe(true);
    expect(resultRef.current?.resolvedBrowserRuntimeId).toBe("runtime-1");

    await act(async () => {
      resultRef.current?.handleBrowserSessionOpenChange(false);
    });
    expect(resultRef.current?.browserSessionOpen).toBe(false);
    expect(resultRef.current?.hasHiddenBrowserSession).toBe(true);

    const revealToken = resultRef.current?.browserSessionExpandRequestToken ?? 0;
    await act(async () => {
      resultRef.current?.handleToggleBrowserSession();
    });
    expect(resultRef.current?.browserSessionOpen).toBe(true);
    expect(resultRef.current?.resolvedBrowserRuntimeId).toBe("runtime-1");
    expect(resultRef.current?.browserSessionExpandRequestToken).toBeGreaterThan(revealToken);
  });

  it("distinguishes generic workspace preference from an exact tool-originated open", async () => {
    await act(async () => root.render(<TestHarness resultRef={resultRef} />));
    await act(async () => resultRef.current?.openBrowserSession("generic-runtime"));
    expect(resultRef.current?.exactBrowserRuntimeId).toBeNull();
    await act(async () => window.dispatchEvent(new CustomEvent("instafy:browser-open", {
      detail: { runtimeId: "browser-runtime", conversationLocalId: "conversation-1" },
    })));
    expect(resultRef.current?.exactBrowserRuntimeId).toBe("browser-runtime");
    expect(resultRef.current?.browserSessionOpen).toBe(true);
    expect(JSON.parse(window.sessionStorage.getItem("instafy:browser-session:user-1:project-1:conversation-1")!)).toMatchObject({
      runtimeId: "browser-runtime", exactRuntimeId: "browser-runtime",
    });
  });

  it("pins an observed runtime and restores only explicitly recorded exact intent", async () => {
    window.sessionStorage.setItem("instafy:browser-session:user-1:project-1:conversation-1", JSON.stringify({ open: true, runtimeId: "old-preference" }));
    await act(async () => root.render(<TestHarness resultRef={resultRef} />));
    expect(resultRef.current?.exactBrowserRuntimeId).toBeNull();
    await act(async () => resultRef.current?.handleBrowserRuntimeIdResolved("observed-browser"));
    expect(resultRef.current?.exactBrowserRuntimeId).toBe("observed-browser");
    await act(async () => { resultRef.current?.handleBrowserSessionOpenChange(false); });
    await act(async () => resultRef.current?.handleToggleBrowserSession());
    expect(resultRef.current?.exactBrowserRuntimeId).toBe("observed-browser");
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<TestHarness resultRef={resultRef} />));
    expect(resultRef.current?.exactBrowserRuntimeId).toBe("observed-browser");
  });

  it("does not inherit legacy unscoped exact intent or hydrate while signed out", async () => {
    window.sessionStorage.setItem("instafy:browser-session:project-1:conversation-1", JSON.stringify({
      open: true, runtimeId: "legacy-browser", exactRuntimeId: "legacy-browser",
    }));
    await act(async () => root.render(<TestHarness resultRef={resultRef} userId={null} />));
    expect(resultRef.current?.browserSessionStateHydrated).toBe(false);
    await act(async () => resultRef.current?.resumeBrowserSession("signed-out-intent"));
    expect(resultRef.current?.browserSessionOpen).toBe(false);
    await act(async () => root.render(<TestHarness resultRef={resultRef} />));
    expect(resultRef.current?.browserSessionStateHydrated).toBe(true);
    expect(resultRef.current?.exactBrowserRuntimeId).toBeNull();
    expect(resultRef.current?.resolvedBrowserRuntimeId).toBeNull();
    expect(resultRef.current?.browserSessionOpen).toBe(false);
  });

  it.each([{ userId: "user-2", projectId: "project-1" }, { userId: "user-1", projectId: "project-2" }])(
    "isolates saved exact intent and stale callbacks when identity changes: %j", async (next) => {
      await act(async () => root.render(<TestHarness resultRef={resultRef} />));
      await act(async () => resultRef.current?.handleBrowserRuntimeIdResolved("first-browser"));
      const stale = resultRef.current!;
      await act(async () => root.render(<TestHarness resultRef={resultRef} {...next} />));
      expect(resultRef.current?.browserSessionStateHydrated).toBe(true);
      expect(resultRef.current?.exactBrowserRuntimeId).toBeNull();
      expect(resultRef.current?.browserSessionOpen).toBe(false);
      setSessionRuntimeOverride.mockClear();
      await act(async () => {
        stale.handleBrowserRuntimeIdResolved("late-browser");
        stale.openBrowserSession("late-browser");
        stale.resumeBrowserSession("late-browser");
        stale.handleBrowserSessionOpenChange(true);
      });
      expect(resultRef.current?.exactBrowserRuntimeId).toBeNull();
      expect(resultRef.current?.browserSessionOpen).toBe(false);
      expect(setSessionRuntimeOverride).not.toHaveBeenCalled();
      expect(window.sessionStorage.getItem(`instafy:browser-session:${next.userId}:${next.projectId}:conversation-1`)).toBeNull();
      await act(async () => resultRef.current?.handleBrowserRuntimeIdResolved("second-browser"));
      await act(async () => root.render(<TestHarness resultRef={resultRef} />));
      expect(resultRef.current?.exactBrowserRuntimeId).toBe("first-browser");
      await act(async () => root.render(<TestHarness resultRef={resultRef} {...next} />));
      expect(resultRef.current?.exactBrowserRuntimeId).toBe("second-browser");
    },
  );
});
