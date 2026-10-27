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
  POLLING_WAKE_MIN_GAP_MS,
  quietPollDelay,
  startGatedInterval,
  subscribePollingGate,
  useAdaptivePoll,
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

    function Harness({ runOnWake, enabled, activeMs = 20_000, idleMs = 120_000, wakeAfterMs }: {
      runOnWake?: boolean; enabled?: boolean; activeMs?: number; idleMs?: number; wakeAfterMs?: number;
    }) {
      useGatedInterval(callback, activeMs, { idleMs, runOnWake, enabled, wakeAfterMs });
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

    it("keeps no timer and no wake run while disabled", async () => {
      await act(async () => root.render(createElement(Harness, { enabled: false })));
      await advance(60_000);
      await act(async () => setVisibility("hidden"));
      await act(async () => setVisibility("visible"));
      expect(callback).not.toHaveBeenCalled();
      await act(async () => root.render(createElement(Harness, { enabled: true })));
      await advance(20_000);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    // Measurement A: something flipped the tab hidden and back every 4.6 s, and
    // every flip ran every owner's wake. A run that is not yet stale is not
    // repeated, and a flip no longer restarts (or doubles) the cadence.
    it("runs a wake only when the last run is stale and keeps the cadence through quick flips", async () => {
      await act(async () => root.render(createElement(Harness, { activeMs: 60_000, idleMs: 300_000 })));
      for (let flip = 0; flip < 14; flip += 1) {
        await act(async () => setVisibility("hidden"));
        await advance(2_300);
        await act(async () => setVisibility("visible"));
        await advance(2_300);
      }
      // Over 64.4 s only the flip at 34.5 s found the last run (mount) older
      // than the 30 s wake gap; it ran once and moved the next tick to 94.5 s.
      // Before, each of the 14 flips ran it.
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("keeps a short cadence through quick flips without wake runs before it is due", async () => {
      await act(async () => root.render(createElement(Harness)));
      for (let flip = 0; flip < 14; flip += 1) {
        await act(async () => setVisibility("hidden"));
        await advance(2_300);
        await act(async () => setVisibility("visible"));
        await advance(2_300);
      }
      // Due at 20 s, 41.4 s (the first visible moment after 40.2 s, 20 s
      // after the last run) and 62.4 s.
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it("runs at once on wake once the last run is older than the wake gap", async () => {
      await act(async () => root.render(createElement(Harness, { activeMs: 60_000, idleMs: 300_000 })));
      await advance(POLLING_WAKE_MIN_GAP_MS - 1_000);
      await act(async () => setVisibility("hidden"));
      await act(async () => setVisibility("visible"));
      expect(callback).not.toHaveBeenCalled();
      await advance(1_000);
      await act(async () => setVisibility("hidden"));
      await act(async () => setVisibility("visible"));
      expect(callback).toHaveBeenCalledTimes(1);
      // The run re-anchors the cadence.
      await advance(59_999);
      expect(callback).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("honours a longer wake gap so a slow fallback wakes only when a tick is due", async () => {
      await act(async () => root.render(createElement(Harness, { activeMs: 120_000, idleMs: 600_000, wakeAfterMs: 120_000 })));
      await advance(100_000);
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

  describe("quiet backoff", () => {
    it("doubles the delay after each read that found nothing, up to the cap, and never past a longer cadence", () => {
      expect([0, 1, 2, 3, 4].map((reads) => quietPollDelay(1_000, reads, 4_000))).toEqual([1_000, 2_000, 4_000, 4_000, 4_000]);
      expect(quietPollDelay(10_000, 5, 4_000)).toBe(10_000);
      expect(quietPollDelay(1_000, 5, undefined)).toBe(1_000);
    });

    it("backs off while reads find nothing and returns to the fast cadence when one finds something", async () => {
      const container = document.createElement("div");
      const root = createRoot(container);
      let news = false;
      const callback = vi.fn(async () => news);
      function Harness() {
        useAdaptivePoll(callback, { enabled: true, fast: true, fastMs: 1_000, slowMs: 10_000, quietMaxMs: 4_000 });
        return null;
      }
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      try {
        await act(async () => root.render(createElement(Harness)));
        const readsIn = async (ms: number) => {
          callback.mockClear();
          for (let elapsed = 0; elapsed < ms; elapsed += 100) {
            await act(async () => { await vi.advanceTimersByTimeAsync(100); });
          }
          return callback.mock.calls.length;
        };
        // Reads at 0, then 2, 6, 10, 14, 18 s: 2, 4, 4 … s apart.
        expect(await readsIn(20_000)).toBe(5);
        news = true;
        await readsIn(4_000);
        expect(await readsIn(5_000)).toBe(5);
      } finally {
        await act(async () => root.unmount());
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
      }
    });
  });

  describe("startGatedInterval", () => {
    it("re-anchors on markRun and stops cleanly", () => {
      const callback = vi.fn();
      const interval = startGatedInterval(callback, 60_000);
      vi.advanceTimersByTime(50_000);
      interval.markRun();
      vi.advanceTimersByTime(59_999);
      expect(callback).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(callback).toHaveBeenCalledTimes(1);
      interval.stop();
      vi.advanceTimersByTime(600_000);
      setVisibility("hidden");
      setVisibility("visible");
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });
});
