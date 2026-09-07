// @vitest-environment jsdom

import { matchRoutes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { studioPerformance, type StudioPerformanceSample } from "../studioPerformance";
import { installStudioPerformanceNavigation } from "../studioPerformanceNavigation";

function routerAt(pathname: string) {
  type State = { location: { pathname: string } };
  const listeners = new Set<(state: State) => void>();
  const router = {
    state: { location: { pathname } },
    subscribe(listener: (state: State) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    navigate(next: string) {
      router.state = { location: { pathname: next } };
      for (const listener of listeners) listener(router.state);
    },
    listeners,
  };
  return router;
}

const complete = () => studioPerformance.observe({ projectId: null, organizationId: null, conversationId: null, messageCount: 0, loading: false, error: false })?.();

describe("Studio navigation measurement lifecycle", () => {
  let samples: StudioPerformanceSample[];
  let unsubscribe: () => void;
  let dispose: (() => void) | undefined;
  let visible: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    visible = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible);
    studioPerformance.clear();
    samples = [];
    unsubscribe = studioPerformance.subscribe((sample) => samples.push(sample));
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    unsubscribe();
    studioPerformance.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["/studio", "/studio/", "/Studio/"])("includes initial document time for the matching route %s", (pathname) => {
    expect(matchRoutes([{ path: "studio" }], pathname)).not.toBeNull();
    vi.advanceTimersByTime(1_200);
    dispose = installStudioPerformanceNavigation(routerAt(pathname));
    complete();
    expect(samples).toMatchObject([{ operation: "studio_startup", outcome: "ready", durationMs: 1_200 }]);
  });

  it("starts on client navigation and ignores subsequent router notifications inside Studio", () => {
    const router = routerAt("/");
    dispose = installStudioPerformanceNavigation(router);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    router.navigate("/studio");
    vi.advanceTimersByTime(300);
    router.navigate("/studio/");
    router.navigate("/Studio");
    complete();
    expect(samples).toMatchObject([{ operation: "studio_startup", outcome: "ready", durationMs: 300 }]);
  });

  it("cancels when leaving Studio and starts a fresh navigation on re-entry", () => {
    const router = routerAt("/studio");
    dispose = installStudioPerformanceNavigation(router);
    router.navigate("/login");
    complete();
    expect(samples).toMatchObject([{ outcome: "superseded" }]);
    expect(vi.getTimerCount()).toBe(0);
    router.navigate("/studio");
    complete();
    expect(samples.map((sample) => sample.outcome)).toEqual(["superseded", "ready"]);
  });

  it("marks hidden navigation without allowing resumed paint to report a false ready result", () => {
    dispose = installStudioPerformanceNavigation(routerAt("/studio"));
    visible = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visible = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    complete();
    expect(samples).toMatchObject([{ outcome: "hidden" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes router and visibility listeners, timers and replay during cleanup", () => {
    const router = routerAt("/studio");
    dispose = installStudioPerformanceNavigation(router);
    complete();
    router.navigate("/login");
    router.navigate("/studio");
    expect(router.listeners.size).toBe(1);
    dispose();
    dispose = undefined;
    expect(router.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const replay = vi.fn();
    const stopReplay = studioPerformance.subscribe(replay, { replay: true });
    expect(replay).not.toHaveBeenCalled();
    router.navigate("/login");
    router.navigate("/studio");
    expect(vi.getTimerCount()).toBe(0);
    studioPerformance.begin("studio_startup");
    visible = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(samples).toHaveLength(1);
    stopReplay();
  });
});
