// @vitest-environment jsdom
import { focusManager } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installPollingGate,
  isPollingActive,
  POLLING_IDLE_AFTER_MS,
  pollingCadence,
  pollingGateState,
  subscribePollingGate,
  useGatedInterval,
} from "../pollingGate";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

function touch() {
  window.dispatchEvent(new Event("pointerdown"));
}

describe("polling gate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installPollingGate();
    setVisibility("visible");
    touch();
  });

  afterEach(() => {
    setVisibility("visible");
    vi.useRealTimers();
  });

  it("reports the active cadence while visible with recent input", () => {
    expect(isPollingActive()).toBe(true);
    expect(pollingGateState()).toBe("active");
    expect(pollingCadence(20_000)).toBe(20_000);
    expect(pollingCadence(20_000, 90_000)).toBe(20_000);
  });

  it("backs off to the idle cadence after three minutes without input and tells subscribers once", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePollingGate(listener);
    vi.advanceTimersByTime(POLLING_IDLE_AFTER_MS - 1);
    expect(isPollingActive()).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(isPollingActive()).toBe(false);
    expect(pollingGateState()).toBe("idle");
    expect(pollingCadence(20_000)).toBe(120_000);
    expect(pollingCadence(20_000, 90_000)).toBe(90_000);
    expect(listener).toHaveBeenCalledExactlyOnceWith("idle", "active");
    unsubscribe();
  });

  it("returns no cadence while the document is hidden and resumes on visibility", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePollingGate(listener);
    setVisibility("hidden");
    expect(pollingGateState()).toBe("hidden");
    expect(isPollingActive()).toBe(false);
    expect(pollingCadence(20_000)).toBeNull();
    expect(listener).toHaveBeenLastCalledWith("hidden", "active");
    setVisibility("visible");
    expect(pollingGateState()).toBe("active");
    expect(listener).toHaveBeenLastCalledWith("active", "hidden");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("mirrors the gate into React Query's focusManager", () => {
    const unsubscribe = focusManager.subscribe(() => {});
    expect(focusManager.isFocused()).toBe(true);
    vi.advanceTimersByTime(POLLING_IDLE_AFTER_MS);
    expect(focusManager.isFocused()).toBe(false);
    touch();
    expect(focusManager.isFocused()).toBe(true);
    setVisibility("hidden");
    expect(focusManager.isFocused()).toBe(false);
    setVisibility("visible");
    expect(focusManager.isFocused()).toBe(true);
    unsubscribe();
  });

  describe("useGatedInterval", () => {
    let root: Root;
    let container: HTMLDivElement;
    const callback = vi.fn();

    function Harness({ runOnWake }: { runOnWake?: boolean }) {
      useGatedInterval(callback, 20_000, { idleMs: 120_000, runOnWake });
      return null;
    }

    beforeEach(async () => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      callback.mockClear();
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    });

    afterEach(async () => {
      await act(async () => root.unmount());
      container.remove();
    });

    async function advance(ms: number) {
      await act(async () => { vi.advanceTimersByTime(ms); });
    }

    it("fires at the active cadence, never on mount, and re-arms after each run", async () => {
      await act(async () => root.render(createElement(Harness)));
      expect(callback).not.toHaveBeenCalled();
      await advance(19_999);
      expect(callback).not.toHaveBeenCalled();
      await advance(1);
      expect(callback).toHaveBeenCalledTimes(1);
      await advance(40_000);
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it("slows to the idle cadence after three minutes without input", async () => {
      await act(async () => root.render(createElement(Harness)));
      await act(async () => touch());
      await advance(POLLING_IDLE_AFTER_MS + 5_000);
      const beforeIdle = callback.mock.calls.length;
      await advance(60_000);
      expect(callback).toHaveBeenCalledTimes(beforeIdle);
      await advance(60_000);
      expect(callback).toHaveBeenCalledTimes(beforeIdle + 1);
    });

    it("does not fire while hidden and runs once when the tab becomes visible", async () => {
      await act(async () => root.render(createElement(Harness)));
      await act(async () => setVisibility("hidden"));
      await advance(300_000);
      expect(callback).not.toHaveBeenCalled();
      await act(async () => setVisibility("visible"));
      expect(callback).toHaveBeenCalledTimes(1);
      // No input arrived while hidden, so the tab wakes into the idle cadence.
      await advance(20_000);
      expect(callback).toHaveBeenCalledTimes(1);
      await advance(100_000);
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("runs once on input while idle and returns to the active cadence", async () => {
      await act(async () => root.render(createElement(Harness)));
      await advance(POLLING_IDLE_AFTER_MS);
      expect(isPollingActive()).toBe(false);
      callback.mockClear();
      await act(async () => touch());
      expect(callback).toHaveBeenCalledTimes(1);
      await act(async () => touch());
      expect(callback).toHaveBeenCalledTimes(1);
      await advance(20_000);
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("skips the wake run when runOnWake is false", async () => {
      await act(async () => root.render(createElement(Harness, { runOnWake: false })));
      await act(async () => setVisibility("hidden"));
      await act(async () => setVisibility("visible"));
      expect(callback).not.toHaveBeenCalled();
      await advance(20_000);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("stops the timer on unmount", async () => {
      await act(async () => root.render(createElement(Harness)));
      await act(async () => root.unmount());
      root = createRoot(container);
      await advance(60_000);
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
