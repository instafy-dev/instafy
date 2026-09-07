// @vitest-environment jsdom
import { QueryClient, QueryObserver, focusManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ native: true, addListener: vi.fn(), getState: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => mocks.native, getPlatform: () => mocks.native ? "android" : "web" } }));
vi.mock("@capacitor/app", () => ({ App: { addListener: mocks.addListener, getState: mocks.getState } }));

import { installNativeAppForegroundBridge, isAppForeground, subscribeAppForeground } from "../appForeground";
import { isAppInForeground } from "../../notifications/assistantMessageNotifications";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("native application foreground", () => {
  let visibility: DocumentVisibilityState;
  let handlers: Array<(state: { isActive: boolean }) => void>;
  let disposers: Array<() => void>;
  let removes: Array<ReturnType<typeof vi.fn>>;
  const start = () => { const dispose = installNativeAppForegroundBridge(); disposers.push(dispose); return dispose; };
  const settle = () => vi.dynamicImportSettled();

  beforeEach(() => {
    mocks.native = true;
    handlers = []; disposers = []; removes = [];
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    mocks.addListener.mockReset(); mocks.getState.mockReset();
    mocks.getState.mockResolvedValue({ isActive: true });
    mocks.addListener.mockImplementation((_event, handler) => {
      handlers.push(handler);
      const remove = vi.fn().mockResolvedValue(undefined); removes.push(remove);
      return Promise.resolve({ remove });
    });
    focusManager.setFocused(undefined);
  });
  afterEach(() => {
    disposers.reverse().forEach((dispose) => dispose());
    focusManager.setFocused(undefined);
    vi.restoreAllMocks(); vi.useRealTimers();
  });

  it("requires confirmed native activity even when the background WebView reports visible", async () => {
    const initial = deferred<{ isActive: boolean }>(); mocks.getState.mockReturnValue(initial.promise);
    start();
    expect(isAppForeground()).toBe(false);
    expect(focusManager.isFocused()).toBe(false);
    expect(document.documentElement.dataset.instafyNativeAppState).toBe("unknown");
    await settle();
    initial.resolve({ isActive: true }); await settle();
    expect(isAppForeground()).toBe(true);
    expect(isAppInForeground()).toBe(true); // A native WebView need not have DOM focus.
    handlers[0]({ isActive: false });
    expect(document.visibilityState).toBe("visible");
    expect(isAppForeground()).toBe(false);
    expect(isAppInForeground()).toBe(false);
    expect(focusManager.isFocused()).toBe(false);
    expect(document.documentElement.dataset.instafyNativeAppState).toBe("inactive");
  });

  it("does not overwrite a newer native event with a stale initial getState result", async () => {
    const initial = deferred<{ isActive: boolean }>(); mocks.getState.mockReturnValue(initial.promise);
    start(); await settle();
    handlers[0]({ isActive: false });
    initial.resolve({ isActive: true }); await settle();
    expect(isAppForeground()).toBe(false);
    expect(focusManager.isFocused()).toBe(false);
    handlers[0]({ isActive: true });
    expect(isAppForeground()).toBe(true);
  });

  it("shares one listener and removes a late registration without reviving a disposed session", async () => {
    const registration = deferred<{ remove: () => Promise<void> }>();
    const oldRemove = vi.fn().mockResolvedValue(undefined);
    mocks.addListener.mockImplementationOnce((_event, handler) => { handlers.push(handler); return registration.promise; });
    const first = start(); const second = start(); await settle();
    expect(mocks.addListener).toHaveBeenCalledOnce();
    first(); first(); expect(oldRemove).not.toHaveBeenCalled();
    second();
    expect(document.documentElement.dataset.instafyNativeAppState).toBeUndefined();
    const third = start(); await settle();
    expect(isAppForeground()).toBe(true);
    registration.resolve({ remove: oldRemove }); await settle();
    handlers[0]({ isActive: false });
    expect(oldRemove).toHaveBeenCalledOnce();
    expect(mocks.getState).toHaveBeenCalledOnce();
    expect(isAppForeground()).toBe(true);
    third(); expect(removes[0]).toHaveBeenCalledOnce();
  });

  it("ignores late initial state after disposal and recovers from an initial read error through events", async () => {
    const initial = deferred<{ isActive: boolean }>(); mocks.getState.mockReturnValueOnce(initial.promise);
    const stop = start(); await settle(); stop();
    initial.resolve({ isActive: true }); await settle();
    expect(isAppForeground()).toBe(false);
    mocks.getState.mockRejectedValueOnce(new Error("Native state unavailable"));
    start(); await settle();
    expect(isAppForeground()).toBe(false);
    handlers.at(-1)!({ isActive: true });
    expect(isAppForeground()).toBe(true);
  });

  it("pauses focused polling and refreshes a stale active query exactly once per native resume", async () => {
    vi.useFakeTimers();
    start(); await settle();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.mount();
    const fetchPage = vi.fn().mockResolvedValue("latest page");
    const observer = new QueryObserver(client, {
      queryKey: ["native-foreground-latest"], queryFn: fetchPage, staleTime: 0,
      refetchInterval: 10_000, refetchIntervalInBackground: false, refetchOnWindowFocus: true,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchPage).toHaveBeenCalledOnce();
      handlers[0]({ isActive: false });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchPage).toHaveBeenCalledOnce();
      expect(document.visibilityState).toBe("visible");
      handlers[0]({ isActive: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchPage).toHaveBeenCalledTimes(2);
      handlers[0]({ isActive: true });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchPage).toHaveBeenCalledTimes(2);
      visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
      expect(focusManager.isFocused()).toBe(false);
      visibility = "visible"; document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchPage).toHaveBeenCalledTimes(3);
    } finally {
      unsubscribe(); client.unmount(); client.clear();
    }
  });

  it("leaves browser focus semantics and TanStack focus installation unchanged", () => {
    mocks.native = false;
    const setFocused = vi.spyOn(focusManager, "setFocused");
    start();
    expect(setFocused).not.toHaveBeenCalled();
    expect(mocks.addListener).not.toHaveBeenCalled();
    expect(isAppForeground()).toBe(true);
    expect(isAppInForeground()).toBe(false);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    expect(isAppInForeground()).toBe(true);
    const listener = vi.fn(); const unsubscribe = subscribeAppForeground(listener);
    visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledOnce();
    expect(isAppInForeground()).toBe(false);
    unsubscribe(); document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledOnce();
  });
});
