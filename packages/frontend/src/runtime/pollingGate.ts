import { focusManager } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/**
 * One shared answer to "is anyone looking at this tab right now?".
 *
 * Timer-driven refreshes (notifications, support reports, inbox, git status)
 * used to run at their active cadence for as long as the tab stayed open,
 * hidden or not. The gate folds document visibility and recent input into a
 * single state so every owner backs off the same way: full cadence while the
 * user is active, a slower cadence after three minutes without input, and no
 * timer at all while the document is hidden. Leaving the hidden or idle state
 * runs each owner's callback once so the user never waits a full cadence for
 * fresh data after coming back.
 *
 * The same state is fed into React Query's focusManager, so every query with
 * `refetchIntervalInBackground: false` pauses while idle and every
 * `refetchOnWindowFocus: true` query refetches on wake without further wiring.
 */
export const POLLING_GATE_CHANGED_EVENT = "instafy:polling-gate-changed";
export const POLLING_IDLE_AFTER_MS = 180_000;
export const POLLING_IDLE_CADENCE_MULTIPLIER = 6;

export type PollingGateState = "active" | "idle" | "hidden";
export type PollingGateListener = (state: PollingGateState, previous: PollingGateState) => void;

let lastInputAt = Date.now();
let lastState: PollingGateState | null = null;
let idleTimer: number | null = null;
let installed = false;

function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export function pollingGateState(now = Date.now()): PollingGateState {
  if (!documentVisible()) return "hidden";
  return now - lastInputAt < POLLING_IDLE_AFTER_MS ? "active" : "idle";
}

/** Visible and touched within the last three minutes. */
export function isPollingActive(now = Date.now()): boolean {
  return pollingGateState(now) === "active";
}

/**
 * The delay a timer should use right now: `activeMs` while active, `idleMs`
 * while idle and `null` while hidden (do not schedule).
 */
export function pollingCadence(activeMs: number, idleMs = activeMs * POLLING_IDLE_CADENCE_MULTIPLIER): number | null {
  switch (pollingGateState()) {
    case "hidden": return null;
    case "idle": return idleMs;
    default: return activeMs;
  }
}

function armIdleTimer() {
  if (typeof window === "undefined") return;
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  idleTimer = null;
  if (!documentVisible()) return;
  const remaining = lastInputAt + POLLING_IDLE_AFTER_MS - Date.now();
  if (remaining <= 0) return;
  idleTimer = window.setTimeout(() => { idleTimer = null; evaluate(); }, remaining);
}

function evaluate() {
  const previous = lastState;
  const next = pollingGateState();
  lastState = next;
  armIdleTimer();
  if (previous !== null && previous !== next && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<{ state: PollingGateState; previous: PollingGateState }>(POLLING_GATE_CHANGED_EVENT, { detail: { state: next, previous } }));
  }
}

function handleInput() {
  lastInputAt = Date.now();
  evaluate();
}

/** Idempotent; runs on import in a DOM and is exported for tests. */
export function installPollingGate() {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;
  // Same listener set as useWorkspaceActivity: anything that proves a person is here.
  window.addEventListener("pointerdown", handleInput, true);
  window.addEventListener("keydown", handleInput, true);
  window.addEventListener("focus", handleInput, true);
  window.addEventListener("wheel", handleInput, { capture: true, passive: true });
  document.addEventListener("visibilitychange", evaluate, true);
  evaluate();
  // focusManager.isFocused() now mirrors the gate, so interval queries with
  // refetchIntervalInBackground:false pause while idle or hidden and
  // refetchOnWindowFocus:true queries refresh when the user comes back.
  focusManager.setEventListener((setFocused) => {
    setFocused(isPollingActive());
    return subscribePollingGate(() => setFocused(isPollingActive()));
  });
}

/** Called on every transition; returns the unsubscribe function. */
export function subscribePollingGate(listener: PollingGateListener): () => void {
  if (typeof window === "undefined") return () => {};
  installPollingGate();
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<{ state: PollingGateState; previous: PollingGateState }>).detail;
    if (detail) listener(detail.state, detail.previous);
  };
  window.addEventListener(POLLING_GATE_CHANGED_EVENT, handle);
  return () => window.removeEventListener(POLLING_GATE_CHANGED_EVENT, handle);
}

const RANK: Record<PollingGateState, number> = { hidden: 0, idle: 1, active: 2 };

export interface GatedIntervalOptions {
  /** Delay while idle; defaults to six times the active delay. */
  idleMs?: number;
  /** Run the callback once when the gate leaves hidden or idle. Default true. */
  runOnWake?: boolean;
}

/**
 * A repeating timer that follows the gate. It never runs the callback on
 * mount (owners keep their own first fetch), fires every `activeMs` while
 * active, every `idleMs` while idle, not at all while hidden, and once
 * immediately on wake unless `runOnWake` is false. The callback may change
 * between renders without resetting the timer.
 */
export function useGatedInterval(
  callback: () => void,
  activeMs: number,
  { idleMs = activeMs * POLLING_IDLE_CADENCE_MULTIPLIER, runOnWake = true }: GatedIntervalOptions = {},
): void {
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    if (typeof window === "undefined") return;
    let timer: number | null = null;
    const clear = () => { if (timer !== null) window.clearTimeout(timer); timer = null; };
    const schedule = () => {
      clear();
      const delay = pollingCadence(activeMs, idleMs);
      if (delay === null) return;
      timer = window.setTimeout(() => { timer = null; latest.current(); schedule(); }, delay);
    };
    const unsubscribe = subscribePollingGate((state, previous) => {
      if (runOnWake && RANK[state] > RANK[previous]) latest.current();
      schedule();
    });
    schedule();
    return () => { clear(); unsubscribe(); };
  }, [activeMs, idleMs, runOnWake]);
}

installPollingGate();
