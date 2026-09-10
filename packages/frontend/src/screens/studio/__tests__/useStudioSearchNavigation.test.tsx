// @vitest-environment jsdom

import { act, useCallback, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStudioNavigation } from "../../../navigation/useStudioNavigation";
import { useStudioSearchNavigation, type StudioSearchNavigationOptions } from "../useStudioSearchNavigation";
import type { StudioSearchTarget } from "../useStudioSearchRecords";
import type { OpenWorkspaceFileEventDetail } from "../components/useFilesPanelViewerState";

describe("useStudioSearchNavigation with real Studio routing", () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useStudioSearchNavigation>;
  let navigate: NavigateFunction;
  let deferNavigation = false;
  let deferredNavigation: (() => void) | null = null;
  let options: Omit<StudioSearchNavigationOptions, "location" | "navigateToDestination">;
  const accepted: OpenWorkspaceFileEventDetail[] = [];
  const runtimeWindow = window as typeof window & {
    __INSTAFY_PENDING_OPEN_WORKSPACE_FILE__?: OpenWorkspaceFileEventDetail | null;
    __INSTAFY_OPEN_WORKSPACE_FILE_ACK__?: string | null;
  };
  const acceptFile = (event: Event) => {
    const detail = (event as CustomEvent<OpenWorkspaceFileEventDetail>).detail;
    accepted.push(detail);
    runtimeWindow.__INSTAFY_OPEN_WORKSPACE_FILE_ACK__ = detail.handoffId;
    runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__ = null;
  };
  const file: StudioSearchTarget = { kind: "file", projectId: "space-b", path: "src/repair.ts", fileId: "file-b" };
  function Harness() {
    const location = useLocation();
    navigate = useNavigate();
    const cancelRef = useRef<() => void>(() => {});
    const beforeNavigation = useCallback((action: () => void) => {
      cancelRef.current();
      if (deferNavigation) deferredNavigation = action;
      else action();
    }, []);
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
  async function commitDeferredNavigation() {
    await act(async () => {
      const action = deferredNavigation;
      deferredNavigation = null;
      deferNavigation = false;
      action?.();
    });
  }
  beforeEach(() => {
    accepted.length = 0;
    deferNavigation = false;
    deferredNavigation = null;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState(null, "", "/studio?projectId=space-a&conversationId=chat-a&conversationControllerId=controller-a&panel=home&teamId=team-a");
    options = { viewerUserId: "viewer", activeProjectId: "space-a", projectReady: true, projectAccessBlocked: false, conversationsProjectKey: "space-a", openFileTab: vi.fn() };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    window.removeEventListener("instafy:open-workspace-file", acceptFile);
    delete runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__;
    delete runtimeWindow.__INSTAFY_OPEN_WORKSPACE_FILE_ACK__;
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

  it("hands an unopened result to the real file opener only after the destination is authorized", async () => {
    window.addEventListener("instafy:open-workspace-file", acceptFile);
    await render();
    await activate({ ...file, requiresLoad: true });
    expect(accepted).toHaveLength(0);
    await render({ activeProjectId: "space-b", conversationsProjectKey: "space-b" });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ projectId: "space-b", path: "src/repair.ts", source: "studio-search" });
    expect(accepted[0].signal?.aborted).toBe(false);
    expect(options.openFileTab).not.toHaveBeenCalled();
    await render();
    expect(accepted).toHaveLength(1);
  });

  it("waits for a deferred same-space Files visit before dispatch and survives its canonical replacement", async () => {
    window.history.replaceState(null, "", "/studio?projectId=space-b&panel=code&conversationId=chat-b");
    window.addEventListener("instafy:open-workspace-file", acceptFile);
    await render({ activeProjectId: "space-b", conversationsProjectKey: "space-b" });
    deferNavigation = true;
    await activate({ ...file, requiresLoad: true });
    expect(accepted).toHaveLength(0);
    expect(runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__).toBeUndefined();

    await commitDeferredNavigation();
    expect(window.location.search).toBe("?projectId=space-b&panel=code");
    expect(accepted).toHaveLength(1);
    expect(accepted[0].signal?.aborted).toBe(false);
    const destinationVisit = window.history.state.key;
    await act(async () => {
      await navigate("?projectId=space-b&panel=code&conversationId=chat-b", { replace: true, state: { instafyVisitKey: destinationVisit } });
    });
    expect(accepted).toHaveLength(1);
    expect(accepted[0].signal?.aborted).toBe(false);
  });

  it("does not revive a dismissed file request when its deferred route commits", async () => {
    window.history.replaceState(null, "", "/studio?projectId=space-b&panel=code&conversationId=chat-b");
    window.addEventListener("instafy:open-workspace-file", acceptFile);
    await render({ activeProjectId: "space-b", conversationsProjectKey: "space-b" });
    deferNavigation = true;
    await activate({ ...file, requiresLoad: true });
    await act(async () => current.cancelPending());
    await commitDeferredNavigation();
    expect(accepted).toHaveLength(0);
    expect(runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__).toBeUndefined();
    expect(options.openFileTab).not.toHaveBeenCalled();
  });

  it("waits for a fresh same-URL visit so Back can restore search results", async () => {
    window.history.replaceState(null, "", "/studio?projectId=space-b&panel=code");
    window.addEventListener("instafy:open-workspace-file", acceptFile);
    await render({ activeProjectId: "space-b", conversationsProjectKey: "space-b" });
    deferNavigation = true;
    await activate({ ...file, requiresLoad: true });
    expect(accepted).toHaveLength(0);
    await commitDeferredNavigation();
    expect(accepted).toHaveLength(1);
    expect(accepted[0].signal?.aborted).toBe(false);
  });

  it("keeps an unopened result pending for a lazy file panel and removes it when navigation cancels", async () => {
    await render({ activeProjectId: "space-b", conversationsProjectKey: "space-b" });
    await activate({ ...file, requiresLoad: true });
    const pending = runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__;
    expect(pending).toMatchObject({ projectId: "space-b", path: "src/repair.ts" });
    await act(async () => { await navigate("/studio?projectId=space-a&panel=home"); });
    expect(pending?.signal?.aborted).toBe(true);
    expect(runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__).toBeNull();
  });

  it.each(["navigation", "account", "project", "access", "superseded", "unmount"] as const)(
    "cancels accepted file reads after %s, not merely the initial handoff", async reason => {
      window.addEventListener("instafy:open-workspace-file", acceptFile);
      await render({ activeProjectId: "space-b", conversationsProjectKey: "space-b" });
      await activate({ ...file, requiresLoad: true });
      const first = accepted[0];
      expect(first.signal?.aborted).toBe(false);
      // Acknowledgement accepts the request; the read can still be pending.
      expect(runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__).toBeNull();
      if (reason === "navigation") await act(async () => { await navigate(window.location.search); });
      if (reason === "account") await render({ viewerUserId: "other-viewer" });
      if (reason === "project") await render({ activeProjectId: "space-c", conversationsProjectKey: "space-c" });
      if (reason === "access") await render({ projectAccessBlocked: true });
      if (reason === "superseded") await activate({ ...file, path: "README.md", requiresLoad: true });
      if (reason === "unmount") await act(async () => root.render(<div />));
      expect(first.signal?.aborted).toBe(true);
      expect(options.openFileTab).not.toHaveBeenCalled();
      if (reason === "superseded") {
        expect(accepted).toHaveLength(2);
        expect(accepted[1].path).toBe("README.md");
        expect(accepted[1].signal?.aborted).toBe(false);
      }
    },
  );

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

  it("drops an unopened selection when access is denied before tab hydration completes", async () => {
    window.addEventListener("instafy:open-workspace-file", acceptFile);
    await render();
    await activate({ ...file, requiresLoad: true });
    await render({ activeProjectId: "space-b", projectReady: false, projectAccessBlocked: true });
    await render({ projectReady: true, projectAccessBlocked: false, conversationsProjectKey: "space-b" });
    expect(accepted).toHaveLength(0);
    expect(options.openFileTab).not.toHaveBeenCalled();
    expect(runtimeWindow.__INSTAFY_PENDING_OPEN_WORKSPACE_FILE__).toBeUndefined();
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
