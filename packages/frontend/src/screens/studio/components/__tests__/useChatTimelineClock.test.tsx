// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatTimelineClock } from "../useChatTimelineClock";

describe("useChatTimelineClock", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let renders: number[];

  function Harness({ advanceBeforeEffect = 0 }: { advanceBeforeEffect?: number }) {
    const now = useChatTimelineClock();
    renders.push(now);
    if (renders.length === 1 && advanceBeforeEffect) {
      vi.setSystemTime(Date.now() + advanceBeforeEffect);
    }
    return <output>{now}</output>;
  }

  const shown = () => Number(container.textContent);
  const mount = (advanceBeforeEffect = 0) => act(async () => { root!.render(<Harness advanceBeforeEffect={advanceBeforeEffect} />); });
  const advance = (milliseconds: number) => act(async () => { vi.advanceTimersByTime(milliseconds); });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    renders = [];
  });

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); });
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("does not rerender the transcript just because the clock advanced during mount", async () => {
    const start = new Date(2026, 10, 2, 12).getTime();
    vi.setSystemTime(start);
    await mount(1);
    expect(renders).toEqual([start]);
    expect(shown()).toBe(start);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("refreshes if midnight passed between initial render and the effect", async () => {
    const start = new Date(2026, 10, 2, 23, 59, 59, 999).getTime();
    vi.setSystemTime(start);
    await mount(1);
    expect(shown()).toBe(new Date(2026, 10, 3).getTime());
    expect(vi.getTimerCount()).toBe(1);
  });

  it("refreshes at the next local midnight without minute-by-minute updates", async () => {
    const start = new Date(2026, 10, 2, 22, 30).getTime();
    const midnight = new Date(2026, 10, 3).getTime();
    vi.setSystemTime(start);
    await mount();
    expect(shown()).toBe(start);
    expect(vi.getTimerCount()).toBe(1);
    const initialRenders = renders.length;
    await advance(midnight - start - 1);
    expect(shown()).toBe(start);
    expect(renders).toHaveLength(initialRenders);
    await advance(1);
    expect(shown()).toBe(midnight);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("refreshes and reschedules when focus returns after a clock jump", async () => {
    vi.setSystemTime(new Date(2026, 10, 2, 12));
    await mount();
    const resumed = new Date(2026, 10, 5, 23, 59, 30).getTime();
    vi.setSystemTime(resumed);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(shown()).toBe(resumed);
    expect(vi.getTimerCount()).toBe(1);
    await advance(30_000);
    expect(shown()).toBe(new Date(2026, 10, 6).getTime());
  });

  it("refreshes on becoming visible, not on becoming hidden", async () => {
    const start = new Date(2026, 10, 2, 12).getTime();
    vi.setSystemTime(start);
    await mount();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    vi.setSystemTime(new Date(2026, 10, 4, 23, 59));
    visibility.mockReturnValue("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(shown()).toBe(start);
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(shown()).toBe(Date.now());
    expect(vi.getTimerCount()).toBe(1);
    await advance(60_000);
    expect(shown()).toBe(new Date(2026, 10, 5).getTime());
  });

  it.each([
    { month: 2, day: 29, hours: 23 },
    { month: 9, day: 25, hours: 25 },
  ])("follows the $hours-hour local day at a daylight-saving change", async ({ month, day, hours }) => {
    vi.stubEnv("TZ", "Europe/Vienna");
    const start = new Date(2026, month, day).getTime();
    const nextMidnight = new Date(2026, month, day + 1).getTime();
    expect(nextMidnight - start).toBe(hours * 60 * 60_000);
    vi.setSystemTime(start);
    await mount();
    await advance(nextMidnight - start - 1);
    expect(shown()).toBe(start);
    await advance(1);
    expect(shown()).toBe(nextMidnight);
  });

  it("removes the timer and focus/visibility listeners on unmount", async () => {
    vi.setSystemTime(new Date(2026, 10, 2, 12));
    const removeFocus = vi.spyOn(window, "removeEventListener");
    const removeVisibility = vi.spyOn(document, "removeEventListener");
    await mount();
    await act(async () => { root!.unmount(); });
    root = null;
    expect(vi.getTimerCount()).toBe(0);
    expect(removeFocus).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeVisibility).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    const renderCount = renders.length;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(renders).toHaveLength(renderCount);
  });
});
