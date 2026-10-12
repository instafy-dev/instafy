import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { usePrefersReducedMotion } from "../../components/OctoMark";
import { useTheme } from "../../theme/ThemeProvider";
import type { LandingCubController, LandingCubDevOptions } from "./cub/landingCub";
import { OCTO_COIN_POP_BEATS } from "./landingTurnScript";
import type { LandingScenarioDeckState } from "./useLandingScenarioDeck";

// Cub, the pen-drawn octopus perched on the example window's top-right corner
// (docs/Brand.md, "Cub"). This eager part is only the empty layer and the
// wiring: the WebGL engine is a separate chunk, imported once the page has
// painted and the browser is idle, so it never delays the landing's first
// paint. Until it loads (or if it never does) the hero simply has no Cub.

/** The engine chunk: its own lazily loaded file, never part of the page's entry. */
const loadLandingCubEngine = () => import("./cub/landingCub");

/** How long the deck's first turn waits for the engine to mount (then the engine's own LANDING_CUB_WAIT applies). */
const CUB_MOUNT_WAIT_MS = 3_000;

// The owner's playground (dev builds only; never part of a production build,
// and kept out of unit tests).
const CubDevPanel = import.meta.env.DEV && import.meta.env.MODE !== "test" ? lazy(() => import("./cub/CubDevPanel")) : null;

/** Runs fn after the next paint, once the browser is idle (or soon after). Returns a cancel. */
function afterPaintAndIdle(fn: () => void): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  let raf = 0;
  let idle = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const whenIdle = () => {
    raf = 0;
    if (w.requestIdleCallback) idle = w.requestIdleCallback(fn, { timeout: 1500 });
    else timer = setTimeout(fn, 200);
  };
  if (typeof w.requestAnimationFrame === "function") raf = w.requestAnimationFrame(whenIdle);
  else timer = setTimeout(whenIdle, 0);
  return () => {
    if (raf) w.cancelAnimationFrame(raf);
    if (idle) w.cancelIdleCallback?.(idle);
    if (timer) clearTimeout(timer);
  };
}

function readDevParam(name: string): string | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

/**
 * The hero's creature layer. Mount it as a direct child of the hero section
 * (position: relative, overflow: hidden); it fills the section and never takes
 * pointer events: Cub reacts to the pointer through his own hit test and never
 * blocks a link or button. The layer itself has no z-index: his canvases carry
 * z-index 3 (above the content, under the window's roster at z-[4]) straight
 * into the hero's stacking context, so his ink multiplies with the page.
 */
export function LandingCub({ deck, heroRef }: { deck: LandingScenarioDeckState; heroRef: RefObject<HTMLElement | null> }) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<LandingCubController | null>(null);
  const { resolvedTheme } = useTheme();
  const reducedMotion = usePrefersReducedMotion();
  const coinPop = deck.playing && deck.beat >= OCTO_COIN_POP_BEATS[0] && deck.beat < OCTO_COIN_POP_BEATS[1];
  const [mounted, setMounted] = useState(0);
  const [devParam] = useState(() => readDevParam("cub-dev"));
  // Playground switches that need a fresh engine (dev builds). ?cub-pose=fallback
  // starts in the pose the fallback sprites are captured in.
  const [devOptions, setDevOptions] = useState<LandingCubDevOptions>(() =>
    import.meta.env.DEV && readDevParam("cub-pose") === "fallback" ? { fallbackPose: true } : {},
  );
  const [scrubTd, setScrubTd] = useState<number | null>(null);

  // The latest values, read when the engine is created (updated after every
  // committed render, never during one).
  const latest = useRef({ resolvedTheme, reducedMotion, turnStartedAt: deck.turnStartedAt, coinPop });
  // The deck holds its first turn until Cub has said hello, or will not.
  const release = useRef(deck.releaseFirstTurn);
  useLayoutEffect(() => {
    latest.current = { resolvedTheme, reducedMotion, turnStartedAt: deck.turnStartedAt, coinPop };
    release.current = deck.releaseFirstTurn;
  });

  useEffect(() => {
    const layer = layerRef.current;
    const hero = heroRef.current;
    if (!layer || !hero) return;
    let cancelled = false;
    let controller: LandingCubController | null = null;
    const releaseFirstTurn = () => release.current();
    // An engine that is slow to arrive does not hold the deck's first turn
    // (the same 3 s the engine itself allows for his first frame).
    const slow = setTimeout(releaseFirstTurn, CUB_MOUNT_WAIT_MS);
    const cancelIdle = afterPaintAndIdle(() => {
      loadLandingCubEngine().then(
        ({ mountLandingCub }) => {
          if (cancelled) return;
          clearTimeout(slow);
          const now = latest.current;
          try {
            controller = mountLandingCub({
              layer,
              hero,
              settings: {
                theme: now.resolvedTheme,
                reducedMotion: now.reducedMotion,
                turnStartedAt: now.turnStartedAt,
                coinPop: now.coinPop,
              },
              dev: import.meta.env.DEV ? devOptions : null,
              onReady: releaseFirstTurn,
            });
          } catch (error) {
            // A bug, not a missing chunk: the hero goes on without Cub, with
            // nothing half-mounted left in the layer, and a dev build says why.
            layer.replaceChildren();
            releaseFirstTurn();
            if (import.meta.env.DEV) console.error("Cub could not mount on the landing hero", error);
            return;
          }
          controllerRef.current = controller;
          // Dev builds: QA scripts and the playground reach the engine here.
          if (import.meta.env.DEV) (window as Window & { __cub?: unknown }).__cub = controller.handle;
          setMounted((count) => count + 1);
        },
        () => {
          // The engine chunk did not load (offline, a stale deploy): the hero
          // stays as it is, without Cub, and the deck plays on.
          if (!cancelled) releaseFirstTurn();
        },
      );
    });
    return () => {
      cancelled = true;
      clearTimeout(slow);
      cancelIdle();
      controller?.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
      if (import.meta.env.DEV && controller) {
        const w = window as Window & { __cub?: unknown };
        if (w.__cub === controller.handle) delete w.__cub;
      }
    };
  }, [heroRef, devOptions]);

  useEffect(() => {
    controllerRef.current?.setTheme(resolvedTheme);
  }, [resolvedTheme, mounted]);

  useEffect(() => {
    controllerRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion, mounted]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    if (scrubTd != null) controller.handle.setTurn({ live: true, td: scrubTd });
    else controller.setTurnStartedAt(deck.turnStartedAt);
  }, [deck.turnStartedAt, scrubTd, mounted]);

  useEffect(() => {
    controllerRef.current?.setCoinPop(coinPop);
  }, [coinPop, mounted]);

  // A new scenario swaps the copy Cub's eyes and keep-outs follow.
  useEffect(() => {
    controllerRef.current?.relayout();
  }, [deck.active]);

  // A visitor's pick: Cub glances at the new opener.
  const picks = useRef(deck.picks);
  const getController = useCallback(() => controllerRef.current, []);
  useEffect(() => {
    if (deck.picks === picks.current) return;
    picks.current = deck.picks;
    controllerRef.current?.noticeChip();
  }, [deck.picks]);

  return (
    <>
      <div
        ref={layerRef}
        aria-hidden="true"
        data-testid="landing-cub-layer"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      />
      {CubDevPanel && devParam !== "0" ? (
        <Suspense fallback={null}>
          <CubDevPanel
            initiallyOpen={devParam === "1"}
            controller={getController}
            generation={mounted}
            options={devOptions}
            onOptionsChange={setDevOptions}
            scrubTd={scrubTd}
            onScrubChange={setScrubTd}
          />
        </Suspense>
      ) : null}
    </>
  );
}
