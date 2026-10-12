// @vitest-environment jsdom

import { StrictMode, act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../../../theme/ThemeProvider";
import { LandingCub } from "../LandingCub";
import { BEAT, SESSION_SCENARIOS, TURN_END_BEAT } from "../landingTurnScript";
import type { LandingScenarioDeckState } from "../useLandingScenarioDeck";

// The engine chunk: jsdom has no WebGL, and the host must never touch the
// engine itself, only the controller mountLandingCub returns.
const engine = vi.hoisted(() => ({
  imported: 0,
  mount: vi.fn(),
  controllers: [] as Record<string, ReturnType<typeof vi.fn>>[],
}));
vi.mock("../cub/landingCub", () => {
  engine.imported++;
  return { mountLandingCub: engine.mount };
});

let reduced = false;
const reducedListeners = new Set<() => void>();

function deckState(patch: Partial<LandingScenarioDeckState> = {}): LandingScenarioDeckState {
  const noop = { onPointerEnter() {}, onPointerLeave() {}, onPointerDown() {}, onFocus() {}, onBlur() {} };
  return {
    active: 0,
    scenario: SESSION_SCENARIOS[0],
    beat: TURN_END_BEAT,
    playing: false,
    runLive: false,
    turnStartedAt: null,
    picks: 0,
    rotating: false,
    selectScenario: vi.fn(),
    frameRef: { current: null },
    chipsEngagement: noop,
    deckEngagement: noop,
    conversationId: "conversation",
    settled: true,
    releaseFirstTurn: vi.fn(),
    ...patch,
  };
}

function Hero({ deck }: { deck: LandingScenarioDeckState }) {
  const heroRef = useRef<HTMLElement | null>(null);
  return (
    <section ref={heroRef} data-testid="hero" className="relative overflow-hidden">
      <LandingCub deck={deck} heroRef={heroRef} />
      <a href="/studio" data-cub-anchor="cta">
        Get started
      </a>
    </section>
  );
}

describe("LandingCub (the hero's creature layer)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: FrameRequestCallback[];
  let idles: (() => void)[];

  const flushPaintAndIdle = async () => {
    await act(async () => {
      frames.splice(0).forEach((cb) => cb(0));
      idles.splice(0).forEach((cb) => cb());
    });
    // The dynamic import and its .then.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const render = async (deck: LandingScenarioDeckState, strict = false) => {
    const tree = (
      <ThemeProvider>
        <Hero deck={deck} />
      </ThemeProvider>
    );
    await act(async () => root.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    reduced = false;
    reducedListeners.clear();
    frames = [];
    idles = [];
    engine.imported = 0;
    engine.controllers = [];
    engine.mount.mockReset();
    engine.mount.mockImplementation(() => {
      const controller = {
        handle: { setTurn: vi.fn() },
        destroy: vi.fn(),
        setTheme: vi.fn(),
        setReducedMotion: vi.fn(),
        setTurnStartedAt: vi.fn(),
        setCoinPop: vi.fn(),
        relayout: vi.fn(),
        noticeChip: vi.fn(),
      };
      engine.controllers.push(controller as unknown as Record<string, ReturnType<typeof vi.fn>>);
      return controller;
    });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames[id - 1] = () => undefined;
    });
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => idles.push(cb));
    vi.stubGlobal("cancelIdleCallback", (id: number) => {
      idles[id - 1] = () => undefined;
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        get matches() {
          return query.includes("reduce") ? reduced : false;
        },
        media: query,
        addEventListener: (_: string, cb: () => void) => reducedListeners.add(cb),
        removeEventListener: (_: string, cb: () => void) => reducedListeners.delete(cb),
        addListener: () => undefined,
        removeListener: () => undefined,
      })),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("renders an empty, inert layer and imports the engine only after a paint and an idle moment", async () => {
    await render(deckState());
    const layer = container.querySelector('[data-testid="landing-cub-layer"]') as HTMLElement;
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.childElementCount).toBe(0);
    for (const name of ["pointer-events-none", "absolute", "inset-0", "overflow-hidden"]) {
      expect(layer.classList.contains(name)).toBe(true);
    }
    // No z-index of its own: Cub's canvases carry theirs into the hero's
    // stacking context, so his light ink multiplies with the page.
    expect(Array.from(layer.classList).some((name) => /^z-/.test(name))).toBe(false);
    // Nothing is loaded on the first paint.
    expect(engine.imported).toBe(0);
    expect(engine.mount).not.toHaveBeenCalled();

    await flushPaintAndIdle();
    expect(engine.imported).toBe(1);
    expect(engine.mount).toHaveBeenCalledTimes(1);
    const [{ layer: mountedLayer, hero, settings }] = engine.mount.mock.calls[0];
    expect(mountedLayer).toBe(layer);
    expect(hero).toBe(container.querySelector('[data-testid="hero"]'));
    expect(settings).toEqual({ theme: "light", reducedMotion: false, turnStartedAt: null, coinPop: false });
  });

  it("releases the deck's first turn once Cub is ready, and when he cannot come", async () => {
    const deck = deckState();
    await render(deck);
    await flushPaintAndIdle();
    expect(deck.releaseFirstTurn).not.toHaveBeenCalled();
    engine.mount.mock.calls[0][0].onReady();
    expect(deck.releaseFirstTurn).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    root = createRoot(container);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    engine.mount.mockImplementation(() => {
      throw new Error("engine bug");
    });
    const next = deckState();
    await render(next);
    await flushPaintAndIdle();
    expect(next.releaseFirstTurn).toHaveBeenCalledTimes(1);
  });

  it("follows the turn, the scenario, a visitor's pick and Octo's coin, then disposes on unmount", async () => {
    await render(deckState());
    await flushPaintAndIdle();
    const controller = engine.controllers[0];

    await render(deckState({ playing: true, beat: BEAT.STEP2, turnStartedAt: 1234 }));
    expect(controller.setTurnStartedAt).toHaveBeenLastCalledWith(1234);
    expect(controller.setCoinPop).toHaveBeenLastCalledWith(true);

    await render(deckState({ playing: true, beat: BEAT.COUNTS, turnStartedAt: 1234 }));
    expect(controller.setCoinPop).toHaveBeenLastCalledWith(false);

    controller.relayout.mockClear();
    await render(deckState({ active: 1, scenario: SESSION_SCENARIOS[1], playing: true, beat: 0, turnStartedAt: 5000, picks: 1 }));
    expect(controller.relayout).toHaveBeenCalledTimes(1);
    expect(controller.noticeChip).toHaveBeenCalledTimes(1);
    expect(controller.setTurnStartedAt).toHaveBeenLastCalledWith(5000);

    await act(async () => root.unmount());
    expect(controller.destroy).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });

  it("leaves the hero without Cub, nothing half-mounted, and says why in dev when mounting throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    engine.mount.mockImplementation(({ layer }: { layer: HTMLElement }) => {
      layer.append(document.createElement("canvas"));
      throw new Error("engine bug");
    });
    await render(deckState());
    await flushPaintAndIdle();
    const layer = container.querySelector('[data-testid="landing-cub-layer"]') as HTMLElement;
    expect(layer.childElementCount).toBe(0);
    expect(error).toHaveBeenCalledWith("Cub could not mount on the landing hero", expect.any(Error));
    // The page goes on: later deck changes reach no controller.
    await render(deckState({ playing: true, beat: BEAT.STEP2, turnStartedAt: 1 }));
    expect(engine.mount).toHaveBeenCalledTimes(1);
  });

  it("starts calm under reduced motion and follows the preference when it changes", async () => {
    reduced = true;
    await render(deckState());
    await flushPaintAndIdle();
    expect(engine.mount.mock.calls[0][0].settings.reducedMotion).toBe(true);

    reduced = false;
    await act(async () => reducedListeners.forEach((cb) => cb()));
    expect(engine.controllers[0].setReducedMotion).toHaveBeenLastCalledWith(false);
  });

  it("never mounts a second engine under StrictMode, and never mounts one after an early unmount", async () => {
    await render(deckState(), true);
    await flushPaintAndIdle();
    expect(engine.mount).toHaveBeenCalledTimes(1);
    expect(engine.controllers[0].destroy).not.toHaveBeenCalled();

    // A visitor who leaves before the browser is idle never loads the engine.
    await act(async () => root.unmount());
    root = createRoot(container);
    engine.mount.mockClear();
    await render(deckState());
    await act(async () => root.unmount());
    root = createRoot(container);
    await flushPaintAndIdle();
    expect(engine.mount).not.toHaveBeenCalled();
  });
});
