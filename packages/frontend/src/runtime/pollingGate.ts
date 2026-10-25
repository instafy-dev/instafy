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
 * runs each owner's callback once, unless it ran moments ago, so the user
 * never waits a full cadence for fresh data after coming back and a tab whose
 * visibility flips every few seconds does not refetch on every flip.
 *
 * The same state is fed into React Query's focusManager, so every query with
 * `refetchIntervalInBackground: false` pauses while idle and every
 * `refetchOnWindowFocus: true` query refetches on wake without further wiring.
 */
export const POLLING_GATE_CHANGED_EVENT = "instafy:polling-gate-changed";
export const POLLING_IDLE_AFTER_MS = 180_000;
export const POLLING_IDLE_CADENCE_MULTIPLIER = 6;
/**
 * A wake runs an owner's callback only when its last run is at least this old
 * (or its active delay, when that is shorter). Data younger than this is as
 * fresh as the timer would keep it, so refetching it on wake only multiplies
 * requests when visibility or idleness changes quickly.
 */
export const POLLING_WAKE_MIN_GAP_MS = 30_000;

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
  /**
   * A wake runs the callback only if the last run is at least this old;
   * defaults to the active delay, at most {@link POLLING_WAKE_MIN_GAP_MS}.
   */
  wakeAfterMs?: number;
  /** False keeps no timer at all (for owners whose preconditions are unmet). Default true. */
  enabled?: boolean;
}

export interface GatedInterval {
  /** Stops the timer and the wake subscription. */
  stop: () => void;
  /** The owner refreshed by another path: count it as a run and re-arm from now. */
  markRun: () => void;
}

/**
 * A repeating timer that follows the gate, for owners outside React. It
 * never runs the callback on start (owners keep their own first fetch). The
 * next run is due one cadence after the previous one: `activeMs` while
 * active, `idleMs` while idle, never while hidden. A gate transition re-arms
 * the timer against that due time instead of restarting it, so frequent
 * transitions cannot postpone or multiply runs. A wake (leaving hidden or
 * idle) runs the callback at once when the last run is at least
 * `wakeAfterMs` old; with `runOnWake` false it only re-arms a full delay.
 */
export function startGatedInterval(
  callback: () => void,
  activeMs: number,
  {
    idleMs = activeMs * POLLING_IDLE_CADENCE_MULTIPLIER,
    runOnWake = true,
    wakeAfterMs = Math.min(activeMs, POLLING_WAKE_MIN_GAP_MS),
  }: Omit<GatedIntervalOptions, "enabled"> = {},
): GatedInterval {
  if (typeof window === "undefined") return { stop: () => {}, markRun: () => {} };
  let stopped = false;
  let lastRunAt = Date.now();
  let timer: number | null = null;
  const clear = () => { if (timer !== null) window.clearTimeout(timer); timer = null; };
  const schedule = () => {
    clear();
    if (stopped) return;
    const delay = pollingCadence(activeMs, idleMs);
    if (delay === null) return;
    timer = window.setTimeout(run, Math.max(0, lastRunAt + delay - Date.now()));
  };
  const run = () => {
    timer = null;
    lastRunAt = Date.now();
    callback();
    schedule();
  };
  const unsubscribe = subscribePollingGate((state, previous) => {
    if (RANK[state] > RANK[previous]) {
      if (!runOnWake) lastRunAt = Date.now();
      else if (Date.now() - lastRunAt >= wakeAfterMs) { clear(); run(); return; }
    }
    schedule();
  });
  schedule();
  return {
    stop: () => { stopped = true; clear(); unsubscribe(); },
    markRun: () => { if (stopped) return; lastRunAt = Date.now(); schedule(); },
  };
}

/**
 * {@link startGatedInterval} for a component. The callback may change between
 * renders without resetting the timer.
 */
export function useGatedInterval(
  callback: () => void,
  activeMs: number,
  { idleMs, runOnWake, wakeAfterMs, enabled = true }: GatedIntervalOptions = {},
): void {
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    if (typeof window === "undefined" || !enabled) return;
    const interval = startGatedInterval(() => latest.current(), activeMs, { idleMs, runOnWake, wakeAfterMs });
    return interval.stop;
  }, [activeMs, enabled, idleMs, runOnWake, wakeAfterMs]);
}

/**
 * The next delay for a poll that is fast only while something is happening
 * (a run, an agent in control, a pending prompt): `fastMs` while `fast` and
 * the tab is visible (input or not, since someone may be watching), `slowMs`
 * while the gate is active, `slowIdleMs` while it is idle, and null (no
 * timer) while the document is hidden.
 */
export function adaptivePollDelay(fast: boolean, fastMs: number, slowMs: number, slowIdleMs = slowMs): number | null {
  const state = pollingGateState();
  if (state === "hidden") return null;
  if (fast) return fastMs;
  return state === "idle" ? slowIdleMs : slowMs;
}

export interface AdaptivePollOptions {
  enabled: boolean;
  fast: boolean;
  fastMs: number;
  slowMs: number;
  slowIdleMs?: number;
}

/**
 * Runs `callback` at once when enabled (and whenever `callback` changes),
 * then one {@link adaptivePollDelay} after each run. A gate transition
 * re-arms the timer against that due time, so coming back reads at once only
 * when a read is due and quick visibility flips cost nothing extra. A change
 * of `fast` reads at once: speeding up reads now, and slowing down still
 * takes one trailing read before the slow cadence. While the document is
 * hidden that read waits for the return, which then reads at once. `fast` is
 * not part of any scope, so a change never resets the caller's state.
 */
export function useAdaptivePoll(callback: () => unknown, { enabled, fast, fastMs, slowMs, slowIdleMs = slowMs }: AdaptivePollOptions): void {
  const fastRef = useRef(fast);
  const kickRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (typeof window === "undefined" || !enabled) return;
    let timer: number | null = null;
    let cancelled = false;
    let lastRunAt = 0;
    const clear = () => { if (timer !== null) window.clearTimeout(timer); timer = null; };
    const schedule = () => {
      clear();
      if (cancelled) return;
      const delay = adaptivePollDelay(fastRef.current, fastMs, slowMs, slowIdleMs);
      if (delay === null) return;
      const wait = lastRunAt + delay - Date.now();
      if (wait <= 0) tick();
      else timer = window.setTimeout(tick, wait);
    };
    const tick = () => {
      clear();
      lastRunAt = Date.now();
      try { void Promise.resolve(callback()).catch(() => {}); } catch { /* the next tick retries */ }
      schedule();
    };
    kickRef.current = () => {
      if (cancelled) return;
      // Hidden: owe the read to the return instead of reading now.
      if (pollingGateState() === "hidden") { lastRunAt = 0; return; }
      tick();
    };
    const unsubscribe = subscribePollingGate(schedule);
    tick();
    return () => { cancelled = true; clear(); unsubscribe(); kickRef.current = null; };
  }, [callback, enabled, fastMs, slowIdleMs, slowMs]);
  useEffect(() => {
    if (fastRef.current === fast) return;
    fastRef.current = fast;
    kickRef.current?.();
  }, [fast]);
}

installPollingGate();
