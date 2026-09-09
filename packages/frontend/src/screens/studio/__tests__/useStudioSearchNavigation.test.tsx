// @vitest-environment jsdom

import { act, useCallback, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStudioNavigation } from "../../../navigation/useStudioNavigation";
import { useStudioSearchNavigation, type StudioSearchNavigationOptions } from "../useStudioSearchNavigation";
import type { StudioSearchTarget } from "../useStudioSearchRecords";

describe("useStudioSearchNavigation with real Studio routing", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useStudioSearchNavigation>;
  let navigate: NavigateFunction;
  let options: Omit<StudioSearchNavigationOptions, "location" | "navigateToDestination">;
  const file: StudioSearchTarget = { kind: "file", projectId: "space-b", path: "src/repair.ts", fileId: "file-b" };
  function Harness() {
    const location = useLocation();
    navigate = useNavigate();
    const cancelRef = useRef<() => void>(() => {});
    const beforeNavigation = useCallback((action: () => void) => { cancelRef.current(); action(); }, []);
    const go = useStudioNavigation(beforeNavigation);
    current = useStudioSearchNavigation({ ...options, location, navigateToDestination: go });
    cancelRef.current = current.cancelPending;
    return <div>{location.search}</div>;
  }
  async function render(patch: Partial<typeof options> = {}) {
    options = { ...options, ...patch };
    await act(async () => root.render(<BrowserRouter><Harness /></BrowserRouter>));
  }
  async function activate(target: StudioSearchTarget = file) {
    await act(async () => current.activateTarget(target));
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState(null, "", "/studio?projectId=space-a&conversationId=chat-a&conversationControllerId=controller-a&panel=home&teamId=team-a");
    options = { viewerUserId: "viewer", activeProjectId: "space-a", projectReady: true, projectAccessBlocked: false, conversationsProjectKey: "space-a", openFileTab: vi.fn() };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("opens the exact cross-space chat and removes the previous team and panel", async () => {
    await render();
    await activate({ kind: "conversation", projectId: "space-b", conversationId: "chat-b", conversationControllerId: "controller-b" });
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({ projectId: "space-b", conversationId: "chat-b", conversationControllerId: "controller-b" });
    expect(options.openFileTab).not.toHaveBeenCalled();
  });

  it("routes space settings and automations with their target project rather than the working space", async () => {
    await render();
    await activate({ kind: "space-panel", projectId: "space-b", panel: "settings" });
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({ projectId: "space-b", panel: "settings", settingsTab: "project" });
    await activate({ kind: "space-panel", projectId: "space-c", panel: "automations" });
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({ projectId: "space-c", panel: "automations" });
    await activate({ kind: "org-settings", orgId: "team-b" });
    expect(new URLSearchParams(window.location.search).get("settingsOrgId")).toBe("team-b");
  });

  it("waits for project authorization and matching conversation/tab ownership before opening a file", async () => {
    await render();
    await activate();
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({ projectId: "space-b", panel: "code" });
    expect(options.openFileTab).not.toHaveBeenCalled();
    await render({ activeProjectId: "space-b", projectReady: false });
    expect(options.openFileTab).not.toHaveBeenCalled();
    await render({ projectReady: true });
    expect(options.openFileTab).not.toHaveBeenCalled();
    await render({ conversationsProjectKey: "space-b" });
    expect(options.openFileTab).toHaveBeenCalledExactlyOnceWith({ id: "file-b", path: "src/repair.ts", label: "repair.ts" });
    await render();
    expect(options.openFileTab).toHaveBeenCalledTimes(1);
  });

  it("opens a file immediately when already in the authorized destination space", async () => {
    await render({ activeProjectId: "space-b", conversationsProjectKey: "space-b" });
    await activate();
    expect(options.openFileTab).toHaveBeenCalledExactlyOnceWith({ id: "file-b", path: "src/repair.ts", label: "repair.ts" });
  });

  it("does not apply a pending file after another route supersedes it during a slow project switch", async () => {
    await render();
    await activate();
    await act(async () => { await navigate("/studio?projectId=space-c&panel=home"); });
    await render({ activeProjectId: "space-b", conversationsProjectKey: "space-b" });
    expect(options.openFileTab).not.toHaveBeenCalled();
    await act(async () => { await navigate("/studio?projectId=space-b&panel=code"); });
    expect(options.openFileTab).not.toHaveBeenCalled();
  });

  it("binds a pending file to one visit even when a later visit has the same project and Files URL", async () => {
    await render();
    await activate();
    await act(async () => { await navigate(window.location.search); });
    await render({ activeProjectId: "space-b", conversationsProjectKey: "space-b" });
    expect(options.openFileTab).not.toHaveBeenCalled();
  });

  it("drops a blocked or different account's pending file instead of opening it after recovery", async () => {
    await render();
    await activate();
    await render({ activeProjectId: "space-b", conversationsProjectKey: "space-b", projectAccessBlocked: true });
    await render({ projectAccessBlocked: false });
    expect(options.openFileTab).not.toHaveBeenCalled();
    await render({ activeProjectId: "space-a", conversationsProjectKey: "space-a" });
    await activate();
    await render({ viewerUserId: "other-viewer", activeProjectId: "space-b", conversationsProjectKey: "space-b" });
    expect(options.openFileTab).not.toHaveBeenCalled();
  });

  it("lets normal navigation cancel an earlier selection while preserving its own new file selection", async () => {
    await render();
    await activate();
    await activate({ kind: "file", projectId: "space-c", path: "README.md", fileId: "file-c" });
    await render({ activeProjectId: "space-c", conversationsProjectKey: "space-c" });
    expect(options.openFileTab).toHaveBeenCalledExactlyOnceWith({ id: "file-c", path: "README.md", label: "README.md" });
  });

  it("does not navigate for a signed-out user or an unsafe file target", async () => {
    await render({ viewerUserId: null });
    const before = window.location.search;
    await activate();
    expect(window.location.search).toBe(before);
    await render({ viewerUserId: "viewer" });
    for (const path of ["../secret", "/etc/passwd", "C:\\secret", "src//main.ts"]) await activate({ ...file, path });
    expect(window.location.search).toBe(before);
    expect(options.openFileTab).not.toHaveBeenCalled();
  });
});
