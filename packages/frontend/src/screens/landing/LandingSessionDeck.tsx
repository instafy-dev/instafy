import { type ReactNode } from "react";
import { Link } from "react-router-dom";
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
import { LandingBrowserView } from "./LandingBrowserView";
import { LandingFileView } from "./LandingFileView";
import { LandingViewsBar, LandingViewsSegmented } from "./LandingViews";
import { useLandingDeckFit, useLandingSplit } from "./landingDeckLayout";
import { paneStateFor, type PaneState } from "./landingPanes";
import {
  BEAT,
  SESSION_SCENARIOS,
  TURN_BEATS,
  TURN_END_BEAT,
  beatId,
  finishedBeat,
  type SessionScenario,
} from "./landingTurnScript";
import {
  MANUAL_HOLD_MS,
  ROTATE_INTERVAL_MS,
  rotateIntervalFor,
  useLandingScenarioDeck,
  type LandingScenarioDeckState,
} from "./useLandingScenarioDeck";

export type { LandingScenarioDeckState, SessionScenario };
export { MANUAL_HOLD_MS, ROTATE_INTERVAL_MS, SESSION_SCENARIOS, TURN_BEATS, TURN_END_BEAT, rotateIntervalFor, useLandingScenarioDeck };

const FOCUS_STYLE = `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 ${chrome.CANVAS_RING_OFFSET}`;

// The chips stack in a column on phones (beside the hero's open cell) and sit
// in a row from md. Inactive chips carry a solid surface fill so the hero's
// dot grid never shows through them; the chosen one is ink.
const CHIP_BASE = `whitespace-nowrap rounded-full border px-3 py-[9px] text-[12.5px] font-medium leading-none transition-colors md:px-4 md:py-[11px] md:text-sm ${FOCUS_STYLE}`;
const CHIP_ACTIVE = "border-brand-ink bg-brand-ink text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900";
// Dark borders come from the darkSurfaces ladder (raised control at rest,
// white-alpha on hover), never the cool slate ramp.
const CHIP_IDLE = `border-slate-200 bg-white text-slate-600 hover:border-slate-400 hover:text-brand-ink ${DARK_RAISED_CONTROL_BORDER_CLASS} dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-300 dark:hover:border-white/30 dark:hover:text-white`;

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

/**
 * The scenario chips. They name the example's three scenarios and are its
 * only selection control; the hero places them under the headline, apart from
 * the window they drive. Pointer or keyboard focus on them holds rotation the
 * same way it does on the window.
 */
export function LandingScenarioChips({ deck, className }: { deck: LandingScenarioDeckState; className?: string }) {
  return (
    <div
      role="group"
      aria-label="Choose a workspace example"
      data-testid="landing-scenario-chips"
      data-cub-anchor="chips"
      data-rotating={deck.rotating ? "true" : "false"}
      className={["flex flex-col items-start gap-1.5 md:flex-row md:flex-wrap md:items-center md:gap-2", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      {...deck.chipsEngagement}
    >
      {SESSION_SCENARIOS.map((example, index) => (
        <button
          key={example.id}
          type="button"
          aria-pressed={deck.active === index}
          aria-controls={deck.conversationId}
          onClick={() => deck.selectScenario(index)}
          className={`${CHIP_BASE} ${deck.active === index ? CHIP_ACTIVE : CHIP_IDLE}`}
        >
          {example.label}
        </button>
      ))}
    </div>
  );
}

interface LandingSessionDeckProps {
  deck: LandingScenarioDeckState;
  joinToFor: (scenario: SessionScenario) => string;
  className?: string;
}

/** What the resource pane shows: the selected file, or the Shared Browser. */
function ResourcePane({ scenario, pane, playing }: { scenario: SessionScenario; pane: PaneState; playing: boolean }) {
  if (pane.browser && pane.selected === "browser" && scenario.browser) {
    return <LandingBrowserView stage={pane.browser} script={scenario.browser} playing={playing} />;
  }
  return pane.file ? <LandingFileView file={pane.file.file} select={pane.file.select} /> : null;
}

/** The example window and the join link under it, drawn from the shared state. */
export function LandingSessionDeck({ deck, joinToFor, className }: LandingSessionDeckProps) {
  const { active, scenario, beat, playing, runLive } = deck;
  // Side by side from a 1184px viewport, where the window's workspace is a
  // real split's 1024px; one view at a time below that (landingDeckLayout.ts).
  const split = useLandingSplit();
  useLandingDeckFit(deck.frameRef);
  const pane = paneStateFor(scenario, beat);
  const browserInFront = !split && pane.single === "browser";

  return (
    <div
      className={["w-full", className ?? ""].filter(Boolean).join(" ")}
      data-testid="landing-session-deck-root"
      data-landing-deck-host=""
      data-rotating={deck.rotating ? "true" : "false"}
      {...deck.deckEngagement}
    >
      {/* The window: the studio's own chrome at 1:1 pixels. Everything inside
          is presentational; the only controls are the chips in the hero and
          the join link below. */}
      <div
        ref={deck.frameRef}
        data-testid="landing-session-deck"
        data-example={scenario.id}
        data-beat={beatId(scenario, beat)}
        data-final-beat={beat === finishedBeat(scenario) ? "true" : "false"}
        data-playing={playing ? "true" : "false"}
        data-run-live={runLive ? "true" : "false"}
        data-layout={split ? "split" : "single"}
        data-view={browserInFront ? "browser" : "chat"}
        data-deck-settled={deck.settled ? "" : undefined}
        data-cub-anchor="window"
        className={chrome.FRAME}
      >
        <RailExpanded scenarios={SESSION_SCENARIOS} active={active} runLive={runLive} split={split} />
        <RailCollapsed split={split} />

        <div data-testid="landing-session-workspace" data-cub-anchor="panel" className={chrome.WORKSPACE}>
          {/* The top bar row: the tab strip (md+) or the phone bar, with the
              roster over its right end, level with the ledge Cub sits on. */}
          <div className={chrome.TOP_BAR}>
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
          </div>

          {/* The conversation's views (md+): Chat and what is open beside it. */}
          <LandingViewsBar pane={pane} split={split} />

          {/* The conversation and its resource. Cub's transcript keep-out is
              this whole area, so his arms and ink never reach the chat, the
              file or the browser beside it. */}
          <div data-testid="landing-session-body" data-cub-anchor="transcript" className="relative flex min-h-0 flex-1">
            <div className={`flex min-h-0 min-w-0 flex-col ${split ? "shrink-0" : "flex-1"}`} style={split ? { width: `${(1 - chrome.SPLIT_RESOURCE_RATIO) * 100}%` } : undefined}>
              <div className="relative flex min-h-0 flex-1 flex-col">
                <section
                  id={deck.conversationId}
                  data-testid="landing-conversation"
                  data-transcript-viewport=""
                  aria-label={`${scenario.label} conversation`}
                  className={`${chrome.TRANSCRIPT}${browserInFront ? " invisible" : ""}`}
                >
                  {/* Top anchored, like a short conversation in the app, and
                      pinned to its newest message once it outgrows the
                      transcript (TurnColumn). The deck keeps one height across
                      scenarios and beats. */}
                  <StackedCopy
                    active={active}
                    className="flex-1"
                    cellClassName="flex flex-col justify-start"
                    render={(entry, isActive) => (
                      <TurnColumn
                        scenario={entry}
                        beat={isActive ? beat : finishedBeat(entry)}
                        playing={isActive && playing}
                        withTestIds={isActive}
                        split={split}
                      />
                    )}
                  />
                </section>
                {/* One view: the press on Octo's browser request brings the
                    browser to the front, until Ada taps Chat once Octo is done. */}
                {!split && pane.browser ? (
                  <div data-testid="landing-resource-pane" className={`absolute inset-0 ${chrome.RESOURCE_PANE}${browserInFront ? "" : " hidden"}`}>
                    <ResourcePane scenario={scenario} pane={pane} playing={playing} />
                  </div>
                ) : null}
              </div>

              <MiniComposer prompt={scenario.prompt} beat={beat} playing={playing} viewNavigation={<LandingViewsSegmented pane={pane} />} />
            </div>

            {split ? (
              <>
                <span aria-hidden="true" className={chrome.SPLIT_DIVIDER} />
                <div data-testid="landing-resource-pane" className={`relative flex-1 ${chrome.RESOURCE_PANE}`}>
                  <ResourcePane scenario={scenario} pane={pane} playing={playing} />
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* One link under the window. */}
      <div className="mt-3 flex justify-center px-1">
        <Link to={joinToFor(scenario)} data-testid="landing-join-session-button" data-cub-anchor="keep-out" className={`inline-flex items-center gap-2 rounded-md py-1 text-sm font-semibold text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 ${FOCUS_STYLE}`}>
          Start your own session <span aria-hidden="true">↗</span>
        </Link>
      </div>
    </div>
  );
}
