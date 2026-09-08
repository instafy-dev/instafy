// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { resolveMobileOverviewSection, useStudioNavigationPosture } from "../useStudioNavigationPosture";
import { createTabForPanel, type WorkspaceTabState } from "../../../workspace/workspaceTabFactories";

const posture = vi.hoisted(() => ({ large: false, touch: true }));
vi.mock("../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => posture.large }));
vi.mock("../../../hooks/useTouchLikeInput", () => ({ useTouchLikeInput: () => posture.touch }));

describe("Studio navigation placement", () => {
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
  });

  it.each([
    { large: false, touch: true, dock: true, topHome: false },
    { large: false, touch: false, dock: false, topHome: true },
    { large: true, touch: true, dock: false, topHome: false },
    { large: true, touch: false, dock: false, topHome: false },
  ])("keeps navigation out of composer for $large desktop/$touch touch", async ({ large, touch, dock, topHome }) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.assign(posture, { large, touch });
    let actual: ReturnType<typeof useStudioNavigationPosture> | undefined;
    function Fixture() { actual = useStudioNavigationPosture(); return null; }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(<Fixture />));
      expect(actual).toEqual({ isLargeScreen: large, touchLikeInput: touch,
        showTouchBottomDock: dock, showTopbarHomeButton: topHome, showComposerHomeButton: false });
    } finally { await act(async () => root.unmount()); }
  });
});
