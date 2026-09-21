// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveMobileOverviewSection,
  resolveWorkspaceEmptyState,
  useStudioNavigationPosture,
} from "../useStudioNavigationPosture";
import { createTabForPanel, type WorkspaceTabState } from "../../../workspace/workspaceTabFactories";

function NavigationPosture() {
  const posture = useStudioNavigationPosture();
  return <output>{JSON.stringify(posture)}</output>;
}

describe("useStudioNavigationPosture", () => {
  let container: HTMLDivElement;
  let root: Root;
  let width: number;
  let touch: boolean;
  let mediaListeners: Map<(event: MediaQueryListEvent) => void, string>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    width = 390;
    touch = true;
    mediaListeners = new Map();
    window.localStorage.clear();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        const minWidth = query.match(/min-width:\s*(\d+)px/);
        return minWidth ? width >= Number(minWidth[1]) : touch;
      },
      media: query,
      addEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.set(listener, query),
      removeEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.delete(listener),
    }));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([
    { label: "phone", viewportWidth: 390, touchInput: true, composerNavigation: false },
    { label: "narrow mouse browser", viewportWidth: 390, touchInput: false, composerNavigation: true },
    { label: "narrow tablet", viewportWidth: 820, touchInput: true, composerNavigation: false },
    { label: "narrow desktop window", viewportWidth: 899, touchInput: false, composerNavigation: true },
    { label: "desktop breakpoint", viewportWidth: 900, touchInput: false, composerNavigation: false },
    { label: "wide touch screen", viewportWidth: 1280, touchInput: true, composerNavigation: false },
  ])("routes $label navigation to the matching surface", async ({ viewportWidth, touchInput, composerNavigation }) => {
    width = viewportWidth;
    touch = touchInput;
    await act(async () => root.render(<NavigationPosture />));
    const posture = JSON.parse(container.textContent ?? "{}");
    expect(posture.showComposerNavigationButton).toBe(composerNavigation);
    expect(posture.isLargeScreen).toBe(viewportWidth >= 900);
    expect(posture.showTouchBottomDock).toBe(viewportWidth < 900 && touchInput);
    expect(posture.showComposerHomeButton).toBe(false);
    expect(posture.showTopbarHomeButton).toBe(false);
    expect(posture.touchLikeInput).toBe(touchInput);
  });

  it("moves navigation when resizing across the sidebar breakpoint", async () => {
    touch = false;
    await act(async () => root.render(<NavigationPosture />));
    expect(JSON.parse(container.textContent ?? "{}").showComposerNavigationButton).toBe(true);
    width = 1200;
    await act(async () => {
      mediaListeners.forEach((query, listener) => listener({ matches: window.matchMedia(query).matches } as MediaQueryListEvent));
    });
    expect(JSON.parse(container.textContent ?? "{}").showComposerNavigationButton).toBe(false);
  });
});

describe("Studio overview destination policy", () => {
  it("reserves the destination bar for Home, Spaces and the full Chats overview", () => {
    expect(resolveMobileOverviewSection(createTabForPanel("home"), null)).toBe("home");
    expect(resolveMobileOverviewSection(createTabForPanel("projects"), null)).toBe("projects");
    expect(resolveMobileOverviewSection(createTabForPanel("chat"), "history")).toBe("chat");
    expect(resolveMobileOverviewSection(null, "history")).toBe("chat");
  });

  it("never adds a bottom row to an empty chat, conversation, job or editor/detail", () => {
    for (const panel of ["chat", "code", "settings"] as const) {
      expect(resolveMobileOverviewSection(createTabForPanel(panel), null)).toBeNull();
    }
    const shared = { id: "fixture", title: "Fixture", closable: true, dirty: false, badge: null, draggable: true };
    const details: WorkspaceTabState[] = [
      { ...shared, kind: "conversation", conversationId: "chat-a" },
      { ...shared, kind: "jobThread", conversationId: "chat-a", jobId: "job-a" },
      { ...shared, kind: "file", panel: "code", fileId: "file-a", filePath: "a.txt" },
      { ...shared, kind: "explorer", rootPath: "/" },
      { ...shared, kind: "gitDiff", path: "a.txt", commitRange: null },
    ];
    for (const tab of details) expect(resolveMobileOverviewSection(tab, null)).toBeNull();
    expect(resolveMobileOverviewSection(null, null)).toBeNull();
  });

  it("lets the visible drawer override an underlying overview or conversation", () => {
    const home = createTabForPanel("home");
    expect(resolveMobileOverviewSection(home, "history")).toBe("chat");
    expect(resolveMobileOverviewSection(home, "files")).toBeNull();
    expect(resolveMobileOverviewSection(home, "sourceControl")).toBeNull();
    expect(resolveMobileOverviewSection(home, "workspaces")).toBeNull();
  });

});

describe("resolveWorkspaceEmptyState", () => {
  it("paints a quiet frame while a space's conversation tabs are still hydrating", () => {
    expect(
      resolveWorkspaceEmptyState({ hasActiveTab: false, conversationTabsReady: false, projectAccessBlocked: false }),
    ).toBe("hydrating");
  });

  it("keeps the real empty state once tabs are ready and none is open", () => {
    expect(
      resolveWorkspaceEmptyState({ hasActiveTab: false, conversationTabsReady: true, projectAccessBlocked: false }),
    ).toBe("empty");
  });

  it("never applies while a tab is active or access is blocked", () => {
    expect(
      resolveWorkspaceEmptyState({ hasActiveTab: true, conversationTabsReady: false, projectAccessBlocked: false }),
    ).toBeNull();
    expect(
      resolveWorkspaceEmptyState({ hasActiveTab: true, conversationTabsReady: true, projectAccessBlocked: false }),
    ).toBeNull();
    expect(
      resolveWorkspaceEmptyState({ hasActiveTab: false, conversationTabsReady: false, projectAccessBlocked: true }),
    ).toBeNull();
  });
});
