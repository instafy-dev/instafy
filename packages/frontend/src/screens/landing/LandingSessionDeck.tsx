import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Link } from "react-router-dom";
import { usePrefersReducedMotion } from "../../components/OctoMark";
import { DARK_RAISED_CONTROL_BORDER_CLASS } from "../../theme/darkSurfaces";
import * as chrome from "./landingStudioChrome";
import {
  MiniComposer,
  MiniPhoneBar,
  MiniTabStrip,
  RailCollapsed,
  RailExpanded,
  RosterStack,
  TurnColumn,
} from "./LandingStudioWindow";
import {
  BEAT,
  SESSION_SCENARIOS,
  TURN_BEATS,
  TURN_END_BEAT,
  type SessionScenario,
} from "./landingTurnScript";

export type { SessionScenario };
export { SESSION_SCENARIOS, TURN_BEATS, TURN_END_BEAT };

// Scenarios advance on their own at a reading pace. Rotation waits while a
// visitor is engaging with the deck (pointer over it or focus inside it) and
// holds for a while after a manual selection so the choice is not overridden.
// The interval leaves the finished turn (TURN_END_MS) on screen for about
// 3.6 s: the completed frame is what the card is for, so it holds the longest.
export const ROTATE_INTERVAL_MS = 11_000;
export const MANUAL_HOLD_MS = 20_000;

const FOCUS_STYLE = `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 ${chrome.CANVAS_RING_OFFSET}`;

// Every scenario's copy is laid out in the same grid cell so the deck keeps
// the height of its tallest scenario: rotation swaps visibility, never layout.
function StackedCopy({
  active,
  className,
  cellClassName,
  render,
}: {
  active: number;
  className?: string;
  cellClassName?: string;
  render: (scenario: SessionScenario, isActive: boolean) => ReactNode;
}) {
  return (
    <div className={["grid min-w-0", className ?? ""].filter(Boolean).join(" ")}>
      {SESSION_SCENARIOS.map((scenario, index) => (
        <div
          key={scenario.id}
          aria-hidden={index !== active ? true : undefined}
          data-scenario-copy={index === active ? "active" : "inactive"}
          // min-w-0: a grid item's automatic minimum is its min-content width,
          // so without it the widest scenario's mono block would set the
          // deck's width instead of wrapping inside it.
          className={["[grid-area:1/1] min-w-0", cellClassName ?? "", index === active ? "" : "invisible"].filter(Boolean).join(" ")}
        >
          {render(scenario, index === active)}
        </div>
      ))}
    </div>
  );
}

interface LandingSessionDeckProps {
  joinToFor: (scenario: SessionScenario) => string;
  className?: string;
  onScenarioChange?: (scenario: SessionScenario) => void;
  // The deck root, so the hero can keep presence cursors from sitting behind it.
  ref?: Ref<HTMLDivElement>;
}

export function LandingSessionDeck({ joinToFor, className, onScenarioChange, ref }: LandingSessionDeckProps) {
  const [active, setActive] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const [manualHold, setManualHold] = useState(false);
  // The scheduled beat is remembered together with the scenario it was
  // scheduled for, so a scenario change reads as beat 0 on the very render it
  // happens on: no finished frame of the new scenario flashes before the
  // scheduler effect resets it.
  const [scheduled, setScheduled] = useState({ active: 0, beat: 0 });
  const prefersReducedMotion = usePrefersReducedMotion();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Browsers focus a button on mouse or touch click, so focus alone cannot
  // tell a keyboard visitor from a pointer one. Only keyboard-originated focus
  // holds rotation; pointer focus is already covered while the pointer is
  // inside, and the manual hold covers the choice itself.
  const pointerFocusRef = useRef(false);
  const onScenarioChangeRef = useRef(onScenarioChange);
  onScenarioChangeRef.current = onScenarioChange;
  const scenario = SESSION_SCENARIOS[active];
  const isWorking = isVisible && pageVisible;
  const rotating = isWorking && !prefersReducedMotion && !pointerInside && !focusInside && !manualHold;
  // The scripted turn plays whenever the deck is working and motion is
  // welcome. Hovering or focusing pauses rotation only, so a visitor who
  // hovers watches the turn finish and rest. Whenever it is not playing the
  // beat is END: reduced-motion, offscreen and hidden-tab visitors see the
  // finished turn from the first paint, never a mid-beat freeze.
  const playing = isWorking && !prefersReducedMotion;
  const scheduledBeat = scheduled.active === active ? scheduled.beat : 0;
  const beat = playing ? scheduledBeat : TURN_END_BEAT;

  useEffect(() => {
    onScenarioChangeRef.current?.(scenario);
  }, [scenario]);

  // Any change to the rotation gate restarts a full countdown, so a scenario
  // that just became eligible is never swapped moments later.
  useEffect(() => {
    if (!rotating) return;
    const timer = setInterval(() => {
      setActive((current) => (current + 1) % SESSION_SCENARIOS.length);
    }, ROTATE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [rotating]);

  // One timeout per beat, all cleared together: a rotation, a manual choice,
  // going offscreen, a hidden tab or unmount can never leave a timer that
  // fires into the next scenario. Playback restarts at beat 0 for every
  // scenario and every return to playing.
  useEffect(() => {
    setScheduled({ active, beat: 0 });
    if (!playing) return;
    const timers = TURN_BEATS.map((entry, index) =>
      index === 0 ? null : setTimeout(() => setScheduled({ active, beat: index }), entry.atMs),
    );
    return () => {
      timers.forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
    };
  }, [active, playing]);

  useEffect(() => () => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
  }, []);

  // Any key press anywhere (including a Tab from outside the deck) means the
  // next focus change is keyboard-driven.
  useEffect(() => {
    const markKeyboard = () => {
      pointerFocusRef.current = false;
    };
    document.addEventListener("keydown", markKeyboard, true);
    return () => document.removeEventListener("keydown", markKeyboard, true);
  }, []);

  const selectScenario = (index: number) => {
    setActive(index);
    setManualHold(true);
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      setManualHold(false);
    }, MANUAL_HOLD_MS);
  };

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

  const runLive = playing && beat >= BEAT.THINKING && beat < BEAT.DONE;

  return (
    <div
      ref={ref}
      className={["w-full", className ?? ""].filter(Boolean).join(" ")}
      data-testid="landing-session-deck-root"
      data-rotating={rotating ? "true" : "false"}
      onPointerEnter={() => setPointerInside(true)}
      onPointerLeave={() => setPointerInside(false)}
      onPointerDown={() => {
        pointerFocusRef.current = true;
      }}
      onFocus={() => {
        if (!pointerFocusRef.current) setFocusInside(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusInside(false);
      }}
    >
      <div role="group" aria-label="Choose a workspace example" className="mb-5 flex flex-wrap items-center justify-center gap-2">
        {SESSION_SCENARIOS.map((example, index) => (
          <button
            key={example.id}
            type="button"
            aria-pressed={active === index}
            onClick={() => selectScenario(index)}
            // Dark borders come from the darkSurfaces ladder (raised control
            // at rest, white-alpha on hover), never the cool slate ramp.
            className={`rounded-full border px-4 py-2.5 text-sm font-medium transition-colors ${FOCUS_STYLE} ${active === index
              ? "border-slate-900 bg-slate-900 text-white dark:border-transparent dark:bg-slate-100 dark:text-slate-900"
              : `border-slate-200 bg-transparent text-slate-600 hover:border-slate-400 hover:text-slate-900 ${DARK_RAISED_CONTROL_BORDER_CLASS} dark:text-slate-300 dark:hover:border-white/30 dark:hover:text-white`}`}
          >
            {example.label}
          </button>
        ))}
      </div>

      {/* The window: the studio's own chrome at 1:1 pixels. Everything inside
          is presentational; the only controls are the chips above and the join
          link below. */}
      <div
        ref={frameRef}
        data-testid="landing-session-deck"
        data-example={scenario.id}
        data-beat={TURN_BEATS[beat].id}
        data-playing={playing ? "true" : "false"}
        className={chrome.FRAME}
      >
        <RailExpanded scenarios={SESSION_SCENARIOS} active={active} runLive={runLive} />
        <RailCollapsed />

        <div className={chrome.WORKSPACE}>
          <MiniTabStrip
            title={
              <StackedCopy
                active={active}
                className="min-w-0"
                render={(entry) => <span className="min-w-0 truncate">{entry.title}</span>}
              />
            }
          />
          <MiniPhoneBar
            title={
              <StackedCopy
                active={active}
                className="min-w-0"
                render={(entry) => <span className="block truncate">{entry.title}</span>}
              />
            }
          />

          <RosterStack scenario={scenario} agentVisible={beat >= BEAT.STEP4} />

          <section aria-label={`${scenario.label} conversation`} className={chrome.TRANSCRIPT}>
            {/* Top anchored, unlike the app's bottom-pinned transcript: a card
                is read from the top, so the conversation starts right under the
                roster and grows downward. The deck keeps one height across
                scenarios and beats, so whatever a shorter scenario does not use
                rests below its last message, above the composer. */}
            <StackedCopy
              active={active}
              className="flex-1"
              cellClassName="flex flex-col justify-start"
              render={(entry, isActive) => (
                <TurnColumn
                  scenario={entry}
                  beat={isActive ? beat : TURN_END_BEAT}
                  playing={isActive && playing}
                  withTestIds={isActive}
                />
              )}
            />
          </section>

          <MiniComposer prompt={scenario.prompt} beat={beat} playing={playing} />
        </div>
      </div>

      {/* One link under the window, centered like the chips above it. */}
      <div className="mt-3 flex justify-center px-1">
        <Link to={joinToFor(scenario)} data-testid="landing-join-session-button" className={`inline-flex items-center gap-2 rounded-md py-1 text-sm font-semibold text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 ${FOCUS_STYLE}`}>
          Start your own session <span aria-hidden="true">↗</span>
        </Link>
      </div>
    </div>
  );
}
