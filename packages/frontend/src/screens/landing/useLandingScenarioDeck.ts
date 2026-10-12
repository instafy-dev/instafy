import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type MutableRefObject, type RefObject } from "react";
import { usePrefersReducedMotion } from "../../components/OctoMark";
import {
  BEAT,
  SESSION_SCENARIOS,
  WORKSPACE_TURN,
  beatReached,
  finishedBeat,
  turnPlanFor,
  type SessionScenario,
  type TurnBeat,
} from "./landingTurnScript";

// Scenarios advance on their own at a reading pace. Rotation waits while a
// visitor is engaging with the example (pointer over the chips or the window,
// or keyboard focus inside either) and holds for a while after a manual
// selection so the choice is not overridden. Each scenario stays for its own
// turn plan's dwell (rotateIntervalFor), which leaves its finished frame on
// screen for about 3.6 s: the completed frame is what the card is for, so it
// holds the longest. A workspace turn stays 11 s; the site scenario, a turn
// plus the browser handoff it asks for, stays 19.4 s.
export const ROTATE_INTERVAL_MS = WORKSPACE_TURN.dwellMs;

/** How long the deck stays on a scenario before rotating on. */
export function rotateIntervalFor(scenario: SessionScenario): number {
  return turnPlanFor(scenario).dwellMs;
}
export const MANUAL_HOLD_MS = 20_000;
/**
 * The longest the first turn waits for releaseFirstTurn() (see
 * useLandingScenarioDeck's holdFirstTurn): a last resort, the hero's Cub
 * releases it much sooner, or at once when he cannot come.
 */
export const FIRST_TURN_HOLD_MS = 8_000;

/** Pointer and focus handlers for one region a visitor can engage with. */
export interface EngagementHandlers {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onFocus: () => void;
  onBlur: (event: FocusEvent<HTMLElement>) => void;
}

/**
 * The example's whole state, owned above both of its parts: the scenario chips
 * (in the hero) and the studio window (below it). Both render from it, and the
 * hero can read the turn (beat, playing, scenario) for anything that follows
 * the example.
 */
export interface LandingScenarioDeckState {
  /** Index into SESSION_SCENARIOS. */
  active: number;
  scenario: SessionScenario;
  /** Index into the scenario's turn plan (turnPlanFor); its finished frame (finishedBeat) whenever the turn is not playing. */
  beat: number;
  /** The scripted turn plays: the window is on screen, the tab is visible and motion is welcome. */
  playing: boolean;
  /** One of Octo's runs is live (thinking through the last step, or its browser run before it is done). */
  runLive: boolean;
  /**
   * performance.now() when the playing turn reached beat 0 (the clock its beat
   * timers count from), or null while the turn is not playing. Anything that
   * follows the turn (the hero's creature) reads its own time from here.
   */
  turnStartedAt: number | null;
  /** Counts a visitor's scenario choices (selectScenario calls). */
  picks: number;
  /** Scenarios advance on their own right now. */
  rotating: boolean;
  /** A visitor's choice: shows that scenario and holds it for MANUAL_HOLD_MS. */
  selectScenario: (index: number) => void;
  /** Attach to the window frame: its visibility gates rotation and playback. */
  frameRef: RefObject<HTMLDivElement | null>;
  /** Spread on the chips group so hovering or keyboard focus there holds rotation. */
  chipsEngagement: EngagementHandlers;
  /** Spread on the window's root so hovering or keyboard focus there holds rotation. */
  deckEngagement: EngagementHandlers;
  /** id of the conversation the chips control. */
  conversationId: string;
  /**
   * The window has painted its first frame: from here beat changes fade and
   * lift (Reveal's transitions), never on the first paint itself.
   */
  settled: boolean;
  /** The first turn may start (see holdFirstTurn); a no-op once it has. */
  releaseFirstTurn: () => void;
}

export interface LandingScenarioDeckOptions {
  /**
   * Hold the first turn on its opener (beat 0, no turn clock) until
   * releaseFirstTurn() or FIRST_TURN_HOLD_MS after the turn could first play,
   * whichever comes first. The hero holds it for Cub, so a first visit reads
   * idle, hello, then the turn; every later turn and every pick plays at once.
   */
  holdFirstTurn?: boolean;
}

/**
 * The window's composer (data-landing-composer) lies wholly outside the
 * viewport, so nobody would see a prompt typed into it.
 */
function composerOutOfView(frame: HTMLElement | null): boolean {
  if (!frame || typeof window === "undefined") return false;
  const composer = frame.querySelector("[data-landing-composer]");
  if (!composer) return false;
  const r = composer.getBoundingClientRect();
  return r.height > 0 && (r.top >= window.innerHeight || r.bottom <= 0);
}

/**
 * When each beat of a plan lands (ms after the turn starts). A turn that opens
 * on the sent prompt (skipTyping) sends at once and shows the prompt 140 ms
 * later; every beat from Octo's thinking on keeps its time, so anything that
 * follows the turn clock (Cub's lent arm, his hello before it) keeps its order.
 */
export function turnBeatTimes(beats: readonly TurnBeat[], skipTyping: boolean): number[] {
  const send = beats[BEAT.SEND].atMs;
  return beats.map((entry, index) => {
    if (!skipTyping) return entry.atMs;
    if (index < BEAT.SEND) return 0;
    return index <= BEAT.OWN ? entry.atMs - send : entry.atMs;
  });
}

function useEngagementRegion(pointerFocusRef: MutableRefObject<boolean>) {
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const handlers: EngagementHandlers = {
    onPointerEnter: () => setPointerInside(true),
    onPointerLeave: () => setPointerInside(false),
    onPointerDown: () => {
      pointerFocusRef.current = true;
    },
    onFocus: () => {
      if (!pointerFocusRef.current) setFocusInside(true);
    },
    onBlur: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusInside(false);
    },
  };
  return { engaged: pointerInside || focusInside, handlers };
}

export function useLandingScenarioDeck({ holdFirstTurn = false }: LandingScenarioDeckOptions = {}): LandingScenarioDeckState {
  const [active, setActive] = useState(0);
  const [firstHeld, setFirstHeld] = useState(holdFirstTurn);
  const [settled, setSettled] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const [manualHold, setManualHold] = useState(false);
  // The scheduled beat is remembered together with the scenario it was
  // scheduled for, so a scenario change reads as beat 0 on the very render it
  // happens on: no finished frame of the new scenario flashes before the
  // scheduler effect resets it.
  const [scheduled, setScheduled] = useState<{ active: number; beat: number; startedAt: number | null }>({
    active: 0,
    beat: 0,
    startedAt: null,
  });
  const [picks, setPicks] = useState(0);
  const prefersReducedMotion = usePrefersReducedMotion();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Browsers focus a button on mouse or touch click, so focus alone cannot
  // tell a keyboard visitor from a pointer one. Only keyboard-originated focus
  // holds rotation; pointer focus is already covered while the pointer is
  // inside, and the manual hold covers the choice itself.
  const pointerFocusRef = useRef(false);
  const chips = useEngagementRegion(pointerFocusRef);
  const deck = useEngagementRegion(pointerFocusRef);
  const conversationId = useId();
  const scenario = SESSION_SCENARIOS[active];
  const isWorking = isVisible && pageVisible;
  const engaged = chips.engaged || deck.engaged;
  // The scripted turn plays whenever the window is working and motion is
  // welcome. Hovering or focusing pauses rotation only, so a visitor who
  // hovers watches the turn finish and rest. Whenever it is not playing the
  // beat is END: reduced-motion, offscreen and hidden-tab visitors see the
  // finished turn from the first paint, never a mid-beat freeze.
  const playing = isWorking && !prefersReducedMotion;
  // A held first turn shows its opener with no turn clock yet.
  const turnHeld = playing && firstHeld;
  const rotating = isWorking && !prefersReducedMotion && !engaged && !manualHold && !turnHeld;
  const scheduledBeat = scheduled.active === active ? scheduled.beat : 0;
  const beat = playing ? scheduledBeat : finishedBeat(scenario);
  const turnStartedAt = playing && scheduled.active === active ? scheduled.startedAt : null;
  const runLive =
    playing &&
    ((beat >= BEAT.THINKING && beat < BEAT.DONE) ||
      (beatReached(scenario, beat, "browse") && !beatReached(scenario, beat, "browseDone")));

  // Any change to the rotation gate, and every new scenario, restarts a full
  // countdown of that scenario's own dwell, so a scenario that just became
  // eligible is never swapped moments later.
  useEffect(() => {
    if (!rotating) return;
    const timer = setTimeout(() => {
      setActive((current) => (current + 1) % SESSION_SCENARIOS.length);
    }, rotateIntervalFor(SESSION_SCENARIOS[active]));
    return () => clearTimeout(timer);
  }, [rotating, active]);

  // One timeout per beat, all cleared together: a rotation, a manual choice,
  // going offscreen, a hidden tab or unmount can never leave a timer that
  // fires into the next scenario. Playback restarts at beat 0 for every
  // scenario and every return to playing. With the composer below the fold
  // (a laptop's first view) the 1.4 s of typing would play to nobody: the turn
  // opens on the sent prompt instead, so the conversation starts moving as
  // soon as the turn does (turnBeatTimes).
  useEffect(() => {
    const startedAt = playing && !turnHeld ? performance.now() : null;
    const skipTyping = startedAt != null && composerOutOfView(frameRef.current);
    const from = skipTyping ? BEAT.SEND : 0;
    setScheduled({ active, beat: from, startedAt });
    if (!playing || turnHeld) return;
    const { beats } = turnPlanFor(SESSION_SCENARIOS[active]);
    const times = turnBeatTimes(beats, skipTyping);
    const timers = beats.map((_, index) =>
      index <= from ? null : setTimeout(() => setScheduled({ active, beat: index, startedAt }), times[index]),
    );
    return () => {
      timers.forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
    };
  }, [active, playing, turnHeld]);

  const releaseFirstTurn = useCallback(() => setFirstHeld(false), []);

  // The first turn never waits on releaseFirstTurn() for long.
  useEffect(() => {
    if (!turnHeld) return;
    const timer = setTimeout(releaseFirstTurn, FIRST_TURN_HOLD_MS);
    return () => clearTimeout(timer);
  }, [turnHeld, releaseFirstTurn]);

  // Two frames after the first paint the window counts as settled: beat
  // changes before then (the first visibility check) apply instantly, so the
  // finished turn never fades out behind the opener on load.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      setSettled(true);
      return;
    }
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => setSettled(true));
    });
    return () => {
      window.cancelAnimationFrame(first);
      if (second) window.cancelAnimationFrame(second);
    };
  }, []);

  useEffect(() => () => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
  }, []);

  // Any key press anywhere (including a Tab from outside the example) means
  // the next focus change is keyboard-driven.
  useEffect(() => {
    const markKeyboard = () => {
      pointerFocusRef.current = false;
    };
    document.addEventListener("keydown", markKeyboard, true);
    return () => document.removeEventListener("keydown", markKeyboard, true);
  }, []);

  const selectScenario = (index: number) => {
    setFirstHeld(false);
    setActive(index);
    setPicks((count) => count + 1);
    setManualHold(true);
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      setManualHold(false);
    }, MANUAL_HOLD_MS);
  };

  // A window already on screen at first paint starts at beat 0 from that very
  // paint: waiting for the observer's first callback would paint the finished
  // turn and then fade it back to the opener.
  useLayoutEffect(() => {
    const node = frameRef.current;
    if (!node || typeof window === "undefined") return;
    const r = node.getBoundingClientRect();
    const seen = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    if (r.height > 0 && seen >= 0.1 * r.height && r.right > 0 && r.left < window.innerWidth) setIsVisible(true);
  }, []);

  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setIsVisible(Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.1));
    }, { threshold: 0.1 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return {
    active,
    scenario,
    beat,
    playing,
    runLive,
    turnStartedAt,
    picks,
    rotating,
    selectScenario,
    frameRef,
    chipsEngagement: chips.handlers,
    deckEngagement: deck.handlers,
    conversationId,
    settled,
    releaseFirstTurn,
  };
}
