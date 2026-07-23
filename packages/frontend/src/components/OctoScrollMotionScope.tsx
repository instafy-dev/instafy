import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";

import {
  createOctoScrollPhysicsState,
  getOctoScrollDeformation,
  resetOctoScrollPhysicsState,
  stepOctoScrollPhysics,
  type OctoScrollDeformation,
  type OctoScrollPhysicsResetReason,
} from "./octoScrollPhysics";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const DRIVEN_VELOCITY_THRESHOLD = 4;

export type OctoScrollMotionPhase = "driven" | "settling" | "settled";

export type OctoScrollMotionSnapshot = Readonly<{
  accelerationPxPerSecondSquared: number;
  deformation: OctoScrollDeformation;
  phase: OctoScrollMotionPhase;
  resetReason: OctoScrollPhysicsResetReason | null;
  velocityPxPerSecond: number;
}>;

const NEUTRAL_DEFORMATION = getOctoScrollDeformation(createOctoScrollPhysicsState());
export const NEUTRAL_OCTO_SCROLL_MOTION: OctoScrollMotionSnapshot = Object.freeze({
  accelerationPxPerSecondSquared: 0,
  deformation: NEUTRAL_DEFORMATION,
  phase: "settled",
  resetReason: null,
  velocityPxPerSecond: 0,
});

type OctoScrollMotionStore = {
  getSnapshot: () => OctoScrollMotionSnapshot;
  publish: (snapshot: OctoScrollMotionSnapshot) => void;
  reset: (reason?: OctoScrollPhysicsResetReason | null) => void;
  subscribe: (listener: () => void) => () => void;
};

function createOctoScrollMotionStore(): OctoScrollMotionStore {
  let snapshot = NEUTRAL_OCTO_SCROLL_MOTION;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => snapshot,
    publish: (nextSnapshot) => {
      snapshot = nextSnapshot;
      listeners.forEach((listener) => listener());
    },
    reset: (reason = null) => {
      const next = reason
        ? { ...NEUTRAL_OCTO_SCROLL_MOTION, resetReason: reason }
        : NEUTRAL_OCTO_SCROLL_MOTION;
      if (snapshot === next) {
        return;
      }
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const OctoScrollMotionContext = createContext<OctoScrollMotionStore | null>(null);

function subscribeToNothing(): () => void {
  return () => undefined;
}

function readNeutralSnapshot(): OctoScrollMotionSnapshot {
  return NEUTRAL_OCTO_SCROLL_MOTION;
}

function resolvePhase(
  deformation: OctoScrollDeformation,
  velocityPxPerSecond: number,
): OctoScrollMotionPhase {
  if (!deformation.active) {
    return "settled";
  }
  return Math.abs(velocityPxPerSecond) >= DRIVEN_VELOCITY_THRESHOLD
    ? "driven"
    : "settling";
}

export function OctoScrollMotionScope({
  children,
  enabled = true,
  resetKey,
  sourceRef,
}: {
  children: ReactNode;
  enabled?: boolean;
  resetKey?: string | number | null;
  sourceRef: RefObject<HTMLElement | null>;
}) {
  const storeRef = useRef<OctoScrollMotionStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createOctoScrollMotionStore();
  }
  const store = storeRef.current;

  useEffect(() => {
    const source = sourceRef.current;
    if (!enabled || !source || typeof window === "undefined") {
      store.reset();
      return;
    }

    const reducedMotionQuery = window.matchMedia?.(REDUCED_MOTION_QUERY) ?? null;
    let animationFrame: number | null = null;
    let physicsState = resetOctoScrollPhysicsState({
      kind: "position",
      timeMs: performance.now(),
      scrollPositionPx: source.scrollTop,
    });

    const cancelAnimation = () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
    };

    const resetMotion = (reason: OctoScrollPhysicsResetReason | null = null) => {
      cancelAnimation();
      physicsState = resetOctoScrollPhysicsState({
        kind: "position",
        timeMs: performance.now(),
        scrollPositionPx: source.scrollTop,
      });
      store.reset(reason);
    };

    const tick = (timeMs: number) => {
      animationFrame = null;
      if (reducedMotionQuery?.matches || document.visibilityState === "hidden") {
        resetMotion();
        return;
      }

      const frame = stepOctoScrollPhysics(physicsState, {
        kind: "position",
        timeMs,
        scrollPositionPx: source.scrollTop,
      });
      physicsState = frame.state;
      store.publish({
        accelerationPxPerSecondSquared: frame.scrollAccelerationPxPerSecondSquared,
        deformation: frame.deformation,
        phase: resolvePhase(frame.deformation, frame.scrollVelocityPxPerSecond),
        resetReason: frame.resetReason,
        velocityPxPerSecond: frame.scrollVelocityPxPerSecond,
      });

      const shouldContinue =
        frame.deformation.active ||
        Math.abs(frame.scrollVelocityPxPerSecond) >= DRIVEN_VELOCITY_THRESHOLD;
      if (shouldContinue) {
        animationFrame = window.requestAnimationFrame(tick);
      } else {
        store.reset(frame.resetReason);
      }
    };

    const requestTick = () => {
      if (reducedMotionQuery?.matches) {
        resetMotion();
        return;
      }
      if (animationFrame === null) {
        const previousPosition = physicsState.lastScrollPositionPx ?? source.scrollTop;
        physicsState = resetOctoScrollPhysicsState({
          kind: "position",
          timeMs: performance.now() - 1_000 / 60,
          scrollPositionPx: previousPosition,
        });
        animationFrame = window.requestAnimationFrame(tick);
      }
    };

    const handleVisibilityChange = () => resetMotion();
    const handleReducedMotionChange = () => resetMotion();
    const subscribeToReducedMotionChange = () => {
      if (!reducedMotionQuery) {
        return () => undefined;
      }
      if (typeof reducedMotionQuery.addEventListener === "function") {
        reducedMotionQuery.addEventListener("change", handleReducedMotionChange);
        return () =>
          reducedMotionQuery.removeEventListener("change", handleReducedMotionChange);
      }
      reducedMotionQuery.addListener(handleReducedMotionChange);
      return () => reducedMotionQuery.removeListener(handleReducedMotionChange);
    };
    source.addEventListener("scroll", requestTick, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const unsubscribeReducedMotion = subscribeToReducedMotionChange();

    return () => {
      cancelAnimation();
      source.removeEventListener("scroll", requestTick);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      unsubscribeReducedMotion();
      store.reset();
    };
  }, [enabled, resetKey, sourceRef, store]);

  return (
    <OctoScrollMotionContext.Provider value={store}>
      {children}
    </OctoScrollMotionContext.Provider>
  );
}

export function useOctoScrollMotionSnapshot(enabled = true): OctoScrollMotionSnapshot {
  const store = useContext(OctoScrollMotionContext);
  return useSyncExternalStore(
    enabled && store ? store.subscribe : subscribeToNothing,
    enabled && store ? store.getSnapshot : readNeutralSnapshot,
    readNeutralSnapshot,
  );
}
