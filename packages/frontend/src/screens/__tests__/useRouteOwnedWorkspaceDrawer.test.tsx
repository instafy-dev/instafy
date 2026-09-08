// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStudioHistory } from "../../navigation/useStudioHistory";
import { registerNativeBackAction } from "../../native/nativeBackButtonCoordinator";
import { useRouteOwnedWorkspaceDrawer } from "../useRouteOwnedWorkspaceDrawer";

const native = vi.hoisted(() => ({
  back: null as null | (() => void),
  remove: vi.fn(async () => {}),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android" } }));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(async (_event: string, listener: () => void) => {
  native.back = listener;
  return { remove: native.remove };
}) } }));

describe("route-owned mobile workspace drawer", () => {
  let root: Root;
  let container: HTMLDivElement;
  let enabled: boolean;
  let api: ReturnType<typeof useRouteOwnedWorkspaceDrawer>;
  let location: ReturnType<typeof useLocation>;
  let navigate: ReturnType<typeof useNavigate>;
  function Harness() {
    location = useLocation();
    navigate = useNavigate();
    api = useRouteOwnedWorkspaceDrawer({ enabled, history: useStudioHistory() });
    return null;
  }
  const render = () => act(async () => root.render(<BrowserRouter><Harness /></BrowserRouter>));
  const move = async (action: () => void) => {
    const oldKey = location.key;
    await act(async () => {
      action();
      await vi.waitFor(() => expect(window.history.state.key).not.toBe(oldKey));
    });
    expect(location.key).not.toBe(oldKey);
  };
  const visit = () => ({ index: window.history.state.idx, length: window.history.length,
    key: location.state?.instafyVisitKey ?? location.key });

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    enabled = true;
    window.history.replaceState({ idx: 0, key: "direct", usr: { instafyVisitKey: "original", retained: "inert" } }, "",
      "/studio?projectId=fixture&conversationId=chat-a&workspaceTab=workspaces&panel=chat#section");
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await render();
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("replaces only the drawer parameter at direct entry while preserving the logical visit", async () => {
    const before = visit();
    await act(async () => api.dismiss());
    expect(location.search).toBe("?projectId=fixture&conversationId=chat-a&panel=chat");
    expect(location.hash).toBe("#section");
    expect(location.state).toEqual({ instafyVisitKey: "original", retained: "inert" });
    expect(visit()).toEqual(before);
  });

  it("assigns the original entry key when the direct visit has not been canonicalized", async () => {
    await act(async () => navigate("/studio?workspaceTab=workspaces", { replace: true, state: null }));
    const before = visit();
    await act(async () => api.dismiss());
    expect(location.search).toBe("");
    expect(visit()).toEqual(before);
  });

  it("uses actual Back for an app visit and can dismiss the same entry again after Forward", async () => {
    await act(async () => api.dismiss());
    const baseKey = location.key;
    await act(async () => navigate("/studio?projectId=fixture&workspaceTab=workspaces"));
    const drawerKey = location.key, length = window.history.length;
    await move(api.dismiss);
    expect(location.key).toBe(baseKey);
    expect(window.history.state.idx).toBe(0);
    expect(window.history.length).toBe(length);
    await move(() => window.history.forward());
    expect(location.key).toBe(drawerKey);
    await move(api.dismiss);
    expect(location.key).toBe(baseKey);
  });

  it("never adds history when a desktop workspace URL becomes mobile or returns to desktop", async () => {
    enabled = false; await render();
    const before = visit(), search = location.search, staleDismiss = api.dismiss;
    enabled = true; await render();
    expect(visit()).toEqual(before);
    expect(location.search).toBe(search);
    enabled = false; await render();
    await act(async () => { staleDismiss(); api.dismiss(); });
    expect(visit()).toEqual(before);
    expect(location.search).toBe(search);
  });

  it("rejects an old action after another browser entry commits before Router publishes it", async () => {
    const staleDismiss = api.dismiss;
    window.history.pushState({ idx: 1, key: "unrendered" }, "", "/studio?panel=settings");
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    await act(async () => staleDismiss());
    expect(window.location.search).toBe("?panel=settings");
    expect(go).not.toHaveBeenCalled();
  });

  it("rejects a saved callback after an acknowledged route change or unmount", async () => {
    const staleDismiss = api.dismiss;
    await act(async () => navigate("/studio?panel=settings"));
    const before = window.location.href;
    await act(async () => staleDismiss());
    expect(window.location.href).toBe(before);
    await act(async () => navigate("/studio?workspaceTab=workspaces"));
    const unmountedDismiss = api.dismiss, beforeUnmount = window.location.href;
    await act(async () => root.render(null));
    await act(async () => unmountedDismiss());
    expect(window.location.href).toBe(beforeUnmount);
  });

  it("does not pop twice while an asynchronous Back is pending", async () => {
    await act(async () => navigate("/studio?workspaceTab=workspaces"));
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    await act(async () => { api.dismiss(); api.dismiss(); });
    expect(go).toHaveBeenCalledExactlyOnceWith(-1);
  });

  it("lets a higher-priority native modal close before the route-owned drawer", async () => {
    const nestedBack = vi.fn();
    const unregister = registerNativeBackAction(nestedBack, 100);
    const before = visit();
    try {
      await act(async () => native.back?.());
      expect(nestedBack).toHaveBeenCalledTimes(1);
      expect(visit()).toEqual(before);
      expect(location.search).toContain("workspaceTab=workspaces");
    } finally { unregister(); }
    await act(async () => native.back?.());
    expect(location.search).not.toContain("workspaceTab");
    expect(visit()).toEqual(before);
  });

  it("respects a nested surface's prevented Escape and handles the next unclaimed Escape", async () => {
    const prevented = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    prevented.preventDefault();
    await act(async () => window.dispatchEvent(prevented));
    expect(location.search).toContain("workspaceTab=workspaces");
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => window.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(location.search).not.toContain("workspaceTab");
  });

  it("does nothing when enabled outside the exact workspace drawer route", async () => {
    await act(async () => navigate("/studio?workspaceTab=history", { replace: true }));
    const before = visit();
    await act(async () => api.dismiss());
    expect(location.search).toBe("?workspaceTab=history");
    expect(visit()).toEqual(before);
  });
});
