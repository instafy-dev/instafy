// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatBrowserSessionState } from "../useChatBrowserSessionState";

type BrowserSessionState = ReturnType<typeof useChatBrowserSessionState>;

function TestHarness({ resultRef }: { resultRef: { current: BrowserSessionState | null } }) {
  resultRef.current = useChatBrowserSessionState({
    activeConversationControllerId: "controller-conversation-1",
    activeConversationId: "conversation-1",
    activeProjectId: "project-1",
    effectiveRuntimeId: null,
    preferredRuntimeId: null,
    refreshRuntimeStatuses: vi.fn(),
    setSessionRuntimeOverride: vi.fn(),
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
});
