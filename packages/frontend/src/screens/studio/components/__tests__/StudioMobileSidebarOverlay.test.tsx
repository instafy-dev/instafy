// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getPlatform, getInfo, setOverlaysWebView, addListener, removeListener } = vi.hoisted(() => ({
  getPlatform: vi.fn(),
  getInfo: vi.fn(),
  setOverlaysWebView: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform } }));
vi.mock("@capacitor/status-bar", () => ({ StatusBar: { getInfo, setOverlaysWebView } }));
vi.mock("@capacitor/app", () => ({ App: { addListener } }));

import { StudioMobileSidebarOverlay } from "../StudioMobileSidebarOverlay";

let container: HTMLDivElement;
let root: Root;

async function renderOverlay() {
  await act(async () => {
    root.render(<StudioMobileSidebarOverlay onClose={() => {}}>Sidebar</StudioMobileSidebarOverlay>);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  getPlatform.mockReturnValue("ios");
  getInfo.mockResolvedValue({ overlays: false });
  setOverlaysWebView.mockResolvedValue(undefined);
  removeListener.mockResolvedValue(undefined);
  addListener.mockResolvedValue({ remove: removeListener });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("mobile sidebar status-bar coverage", () => {
  it("shares a pending native baseline across separate close/reopen mounts", async () => {
    let resolveInfo!: (info: { overlays: boolean }) => void;
    getInfo.mockReturnValue(new Promise((resolve) => { resolveInfo = resolve; }));
    await renderOverlay();
    await vi.waitFor(() => expect(getInfo).toHaveBeenCalledOnce());
    await act(async () => root.render(null));
    await renderOverlay();
    // The new drawer must neither read the temporary mode nor race the old restore.
    expect(getInfo).toHaveBeenCalledOnce();
    resolveInfo({ overlays: false });
    await vi.waitFor(() => expect(setOverlaysWebView).toHaveBeenLastCalledWith({ overlay: true }));
    expect(setOverlaysWebView.mock.calls.every(([options]) => options.overlay === true)).toBe(true);
    await act(async () => root.render(null));
    await vi.waitFor(() => expect(setOverlaysWebView).toHaveBeenLastCalledWith({ overlay: false }));
  });

  it.each(["enable", "restore"])("serializes close/reopen while the native %s write is pending", async (phase) => {
    let nativeOverlay = false;
    let resolveWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => { resolveWrite = resolve; });
    getInfo.mockImplementation(async () => ({ overlays: nativeOverlay }));
    let shouldDelay = true;
    setOverlaysWebView.mockImplementation(async ({ overlay }: { overlay: boolean }) => {
      if (shouldDelay && overlay === (phase === "enable")) {
        shouldDelay = false;
        await pendingWrite;
      }
      nativeOverlay = overlay;
    });
    await renderOverlay();
    await vi.waitFor(() => expect(setOverlaysWebView).toHaveBeenCalledWith({ overlay: true }));
    await act(async () => root.render(null));
    if (phase === "restore") {
      await vi.waitFor(() => expect(setOverlaysWebView).toHaveBeenLastCalledWith({ overlay: false }));
    }
    await renderOverlay();
    expect(getInfo).toHaveBeenCalledOnce();
    resolveWrite();
    await vi.waitFor(() => {
      expect(nativeOverlay).toBe(true);
      expect(setOverlaysWebView).toHaveBeenLastCalledWith({ overlay: true });
    });
    await act(async () => root.render(null));
    await vi.waitFor(() => expect(nativeOverlay).toBe(false));
  });

  it("retains the original baseline through StrictMode effect remounts", async () => {
    await act(async () => {
      root.render(<StrictMode><StudioMobileSidebarOverlay onClose={() => {}}>Sidebar</StudioMobileSidebarOverlay></StrictMode>);
    });
    await vi.waitFor(() => expect(setOverlaysWebView).toHaveBeenLastCalledWith({ overlay: true }));
    expect(getInfo).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    await vi.waitFor(() => expect(setOverlaysWebView).toHaveBeenLastCalledWith({ overlay: false }));
  });

  it("preserves an already-overlaying shell instead of forcing the current startup default", async () => {
    getInfo.mockResolvedValue({ overlays: true });
    await renderOverlay();
    await vi.waitFor(() => expect(setOverlaysWebView).toHaveBeenCalled());
    await act(async () => root.render(null));
    expect(setOverlaysWebView).toHaveBeenLastCalledWith({ overlay: true });
  });

  it("does not enable a late overlay when closing before the native state read completes", async () => {
    let resolveInfo!: (info: { overlays: boolean }) => void;
    getInfo.mockReturnValue(new Promise((resolve) => { resolveInfo = resolve; }));
    await renderOverlay();
    await vi.waitFor(() => expect(getInfo).toHaveBeenCalled());
    await act(async () => root.render(null));
    resolveInfo({ overlays: false });
    await vi.waitFor(() => expect(setOverlaysWebView).toHaveBeenCalled());
    expect(setOverlaysWebView.mock.calls.every(([options]) => options.overlay === false)).toBe(true);
  });

  it("temporarily expands the iOS WebView behind the status bar and restores it on close", async () => {
    await renderOverlay();
    await vi.waitFor(() => expect(setOverlaysWebView).toHaveBeenCalledWith({ overlay: true }));
    await vi.waitFor(() => expect(addListener).toHaveBeenCalled());
    await act(async () => root.render(null));
    await vi.waitFor(() => expect(setOverlaysWebView).toHaveBeenLastCalledWith({ overlay: false }));
    expect(removeListener).toHaveBeenCalledOnce();

    setOverlaysWebView.mockClear();
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(setOverlaysWebView).not.toHaveBeenCalled();
  });

  it("reapplies the overlay when Capacitor resets static chrome on focus or resume", async () => {
    await renderOverlay();
    await vi.waitFor(() => expect(addListener).toHaveBeenCalled());
    const onAppState = addListener.mock.calls[0][1] as (state: { isActive: boolean }) => void;
    setOverlaysWebView.mockClear();
    onAppState({ isActive: false });
    await Promise.resolve();
    expect(setOverlaysWebView).not.toHaveBeenCalled();
    onAppState({ isActive: true });
    await vi.waitFor(() => expect(setOverlaysWebView).toHaveBeenCalledWith({ overlay: true }));
    setOverlaysWebView.mockClear();
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(setOverlaysWebView).toHaveBeenCalledWith({ overlay: true }));
  });

  it.each(["web", "android"])("does not change native chrome on %s", async (platform) => {
    getPlatform.mockReturnValue(platform);
    await renderOverlay();
    expect(setOverlaysWebView).not.toHaveBeenCalled();
    expect(addListener).not.toHaveBeenCalled();
  });

  it("removes a listener that finishes registering after the drawer closes", async () => {
    let resolveListener!: (listener: { remove: typeof removeListener }) => void;
    addListener.mockReturnValue(new Promise((resolve) => { resolveListener = resolve; }));
    await renderOverlay();
    await vi.waitFor(() => expect(addListener).toHaveBeenCalled());
    await act(async () => root.render(null));
    resolveListener({ remove: removeListener });
    await vi.waitFor(() => expect(removeListener).toHaveBeenCalledOnce());
    expect(setOverlaysWebView).toHaveBeenLastCalledWith({ overlay: false });
  });

  it("still dismisses the drawer if the native bridge is unavailable", async () => {
    setOverlaysWebView.mockRejectedValue(new Error("unavailable"));
    const onClose = vi.fn();
    await act(async () => {
      root.render(<StudioMobileSidebarOverlay onClose={onClose}>Sidebar</StudioMobileSidebarOverlay>);
    });
    container.querySelector("button")?.click();
    expect(onClose).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="mobile-sidebar-surface"]')?.textContent).toBe("Sidebar");
  });
});
