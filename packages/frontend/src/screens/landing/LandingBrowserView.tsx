import { useLayoutEffect, useRef, useState } from "react";
import { Check, Globe, Lock, MoreHoriz, NavArrowDown, NavArrowRight } from "iconoir-react";
import { Spinner } from "../../components/Spinner";
import { Surface } from "../../components/Surface";
import { Text } from "../../components/Text";
import { StudioDialogFooter } from "../../components/aria/StudioDialogLayout";
import { StudioDialogGutterContext } from "../../components/aria/StudioDialogSpacing";
import { BrowserChromeShell } from "../studio/components/BrowserChromeShell";
import { browserApprovalSentence } from "../studio/components/browserApprovalWords";
// The studio's own edge glow (RemoteControlSurface.tsx): its classes and CSS.
import "../studio/components/RemoteControlSurface.css";
import { LANDING_CREW, type CrewColor } from "./landingCrew";
import type { BrowserStage } from "./landingPanes";
import * as chrome from "./landingStudioChrome";
import type { BrowserScript } from "./landingTurnScript";

// The Shared Browser open in the conversation's resource pane: the fill
// container BrowserSessionModal (ChatPanel.tsx:5915-5925) with its compact
// toolbar (every landing pane is under 900px, browserSessionLayout.ts), the
// stage, and what the studio overlays on a live page (BrowserSessionModal.tsx
// 2783-2815): the edge glow while Octo controls it, Octo's cursor at a click,
// a teammate's named pointer and the action ticker, plus the site approval
// prompt. The page is a stand-in for the remote screencast, so like the real
// stage it carries no readable DOM text (the whole view is aria-hidden).

const ADA = LANDING_CREW.ada;
const KIM = LANDING_CREW.kim;

// How far the page scrolls on Octo's "Scroll" at most: it scrolls the plans
// up to the top of the stage, less when the page is short.
const PAGE_SCROLL_PX = 132;
// Where the plans come to rest under the stage's top edge after the scroll.
const PLANS_SCROLL_MARGIN_PX = 8;
// A named pointer's pill hangs 12px under and right of its tip and is about
// 18px tall; the ticker takes the stage's bottom 40px. A spot for Kim is in
// view when her pill clears the ticker.
const PILL_REACH_PX = 32;
const TICKER_ZONE_PX = 40;

type Point = { x: number; y: number };
type Spot = { x: number | string; y: number | string };
interface StageGeometry {
  /** Octo's click on the page's Choose Team button (stage px, once the page has scrolled). */
  click: Point | null;
  /** Where Kim's pointer rests when she comes onto the scrolled page (stage px). */
  rest: Point | null;
  /** Kim's pointer beside the Team column of the plan comparison (stage px, on the scrolled page). */
  compare: Point | null;
  scroll: number;
}

const EMPTY_GEOMETRY: StageGeometry = { click: null, rest: null, compare: null, scroll: 0 };

function sameGeometry(a: StageGeometry, b: StageGeometry): boolean {
  const pt = (p: Point | null, q: Point | null) => (p === null || q === null ? p === q : Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5);
  return pt(a.click, b.click) && pt(a.rest, b.rest) && pt(a.compare, b.compare) && Math.abs(a.scroll - b.scroll) < 0.5;
}

/**
 * Measures the page's anchors in the page's own coordinates, so the result
 * does not depend on how far a scroll transition has run: a stage point is the
 * page point less the scroll it is seen at. Every pointer here lands once Octo
 * has scrolled (the studio draws pointers over the screencast, fixed on the
 * screen), so each is the page point less the scroll. Kim's points sit beside
 * text, never on it, so her name pill hangs into whitespace.
 *
 * The scroll is clamped to the stage's height (stageMax).
 */
function measureStage(stageMax: number, content: HTMLElement): StageGeometry | null {
  const contentRect = content.getBoundingClientRect();
  // A hidden pane (one view showing the chat) keeps what it measured last.
  if (contentRect.width === 0) return null;
  const anchor = (name: string) => content.querySelector<HTMLElement>(`[data-page-anchor="${name}"]`)?.getBoundingClientRect() ?? null;
  const plans = anchor("plans");
  const button = anchor("team-button");
  const compare = anchor("team-compare");
  const rest = anchor("rest");
  const starter = anchor("starter-note");
  const plansTop = plans ? plans.top - contentRect.top - PLANS_SCROLL_MARGIN_PX : PAGE_SCROLL_PX;
  const scroll = Math.max(0, Math.min(PAGE_SCROLL_PX, plansTop, content.offsetHeight - stageMax));
  const at = (x: number, y: number): Point => ({ x: x - contentRect.left, y: y - contentRect.top - scroll });
  // In a short stage the comparison is below the visible page: Kim's pointer
  // then rests just after the Starter plan's note instead, still off the
  // button Octo clicked.
  const inView = (point: Point | null) => (point && point.y + PILL_REACH_PX <= stageMax - TICKER_ZONE_PX ? point : null);
  const fallback = starter ? at(starter.right + 6, starter.top + starter.height * 0.5) : null;
  return {
    // The runtime clicks the centre of the target's box (shared-browser-cli.js
    // click), and the studio draws Octo's cursor exactly there.
    click: button ? at(button.left + button.width / 2, button.top + button.height / 2) : null,
    // The whitespace right of the "Compare plans" heading.
    rest: inView(rest ? at(rest.left + rest.width * 0.78, rest.top + rest.height * 0.5) : null) ?? fallback,
    // Just right of the Team column's first value, so her pill hangs into the
    // column's whitespace, well away from the button Octo clicked.
    compare: inView(compare ? at(compare.right + 8, compare.top + compare.height * 0.5) : null) ?? fallback,
    scroll,
  };
}

function PlanCard({
  name,
  price,
  note,
  cta,
  featured = false,
  selected = false,
}: {
  name: string;
  price: string;
  note: string;
  cta: string;
  featured?: boolean;
  selected?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-3 transition-shadow duration-300 motion-reduce:transition-none ${
        featured ? "border-slate-900" : "border-slate-200"
      } ${selected ? "ring-4 ring-slate-900/10" : ""}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-slate-700">{name}</span>
        <span className="flex items-baseline gap-0.5">
          <span className="text-lg font-bold leading-none tracking-tight">
            {price}
          </span>
          <span className="text-3xs text-slate-500">/month</span>
        </span>
      </div>
      <span
        data-page-anchor={featured ? "team-button" : undefined}
        className={`mt-2.5 flex h-7 items-center justify-center gap-1 rounded-lg text-xxs font-semibold ${
          featured ? "bg-slate-900 text-white" : "border border-slate-300 text-slate-800"
        }`}
      >
        {selected ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
        {selected ? `${name} selected` : cta}
      </span>
      <p className="mt-2 text-3xs leading-snug text-slate-500">
        <span data-page-anchor={featured ? undefined : "starter-note"}>{note}</span>
      </p>
    </div>
  );
}

// Only what notes/pricing.md says (landingTurnScript.ts PRICING_NOTES).
const COMPARE_ROWS: readonly [string, string, string][] = [
  ["Members", "1", "Up to 20"],
  ["Shared spaces", "None", "Included"],
  ["Support", "Email", "Priority"],
];

const QUESTIONS: readonly [string, string][] = [
  ["Can we change plans later?", "Yes, at any time."],
  ["Do you offer yearly billing?", "Yes, with two months free."],
];

// The page Octo built (site/pricing.html from notes/pricing.md), laid out for
// whatever width the pane gives it: a pane under 640px is screencast through
// CDP at its own width, so the page reflows to it (ChatPanel.tsx:847-850) and
// the plans stack in a narrow one.
// A pane of one view (md up to the split) is wide and tall, so the page takes
// a roomier rhythm there (@[40rem]), as a real page does on a wide screen, and
// is tall enough for Octo's scroll to read as one.
function PricingPage({ teamSelected }: { teamSelected: boolean }) {
  return (
    <div className="@container bg-white text-slate-900">
      <div className="px-4 pb-8 pt-3 @[28rem]:px-5 @[40rem]:px-8 @[40rem]:pb-12 @[40rem]:pt-5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold tracking-tight">Forma</span>
          <span className="flex items-center gap-3 text-3xs text-slate-500">
            <span>Product</span>
            <span className="font-semibold text-slate-900">Pricing</span>
            <span>Sign in</span>
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-2 @[40rem]:mt-8">
          <span className="text-lg font-bold tracking-tight">Pricing</span>
          <span className="text-xxs text-slate-500">Simple plans. Room to grow.</span>
        </div>
        <div className="mt-3 grid gap-2.5 @[28rem]:grid-cols-2 @[40rem]:mt-5 @[40rem]:gap-4" data-page-anchor="plans">
          <PlanCard name="Starter" price="$19" note="For one person getting started." cta="Choose Starter" />
          <PlanCard name="Team" price="$49" note="Everything in Starter, plus shared spaces." cta="Choose Team" featured selected={teamSelected} />
        </div>
        <div className="mt-6 @[40rem]:mt-10">
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold">Compare plans</p>
            <span className="h-4 min-w-0 flex-1" data-page-anchor="rest" />
          </div>
          <div className="mt-2 divide-y divide-slate-100 border-y border-slate-100 text-3xs">
            <div className="grid grid-cols-3 py-1.5 font-semibold text-slate-700">
              <span />
              <span>Starter</span>
              <span>Team</span>
            </div>
            {COMPARE_ROWS.map(([label, starter, team], row) => (
              <div key={label} className="grid grid-cols-3 py-1.5 text-slate-600 @[40rem]:py-2">
                <span className="text-slate-500">{label}</span>
                <span>{starter}</span>
                <span>
                  <span data-page-anchor={row === 0 ? "team-compare" : undefined}>{team}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-6 @[40rem]:mt-10">
          <p className="text-xs font-semibold">Questions</p>
          {QUESTIONS.map(([question, answer]) => (
            <div key={question} className="mt-2.5">
              <p className="text-xxs font-medium text-slate-700">{question}</p>
              <p className="mt-0.5 text-3xs leading-snug text-slate-500">{answer}</p>
            </div>
          ))}
        </div>
        <p className="mt-6 text-3xs text-slate-400 @[40rem]:mt-10">Forma, 2026</p>
      </div>
    </div>
  );
}

function PointerArrow({ fill, stroke, strokeWidth }: { fill: string; stroke: string; strokeWidth: number }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className={chrome.POINTER_SVG}>
      <path d={chrome.POINTER_PATH} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
    </svg>
  );
}

function Participant({ crew, initial }: { crew: CrewColor; initial: string }) {
  return (
    <span className={chrome.BROWSER_PARTICIPANT} style={{ backgroundColor: crew.fill, color: crew.on }}>
      {initial}
    </span>
  );
}

// SharedBrowserApprovalPrompt.tsx with active={false}: Ask mode's first site
// prompt for the preview's origin, in the chat row's words ("Octo wants to use
// …"), and Ada presses Allow site. landingStudioParity.test.tsx keeps its copy
// equal to the studio's.
function ApprovalSheet({ origin, pressed }: { origin: string; pressed: boolean }) {
  const sentence = browserApprovalSentence("Octo", {
    kind: "origin", operation: "approve-origin", sourceOrigin: null, destinationOrigin: origin,
    display: { label: "", destinationOrigin: origin },
  });
  return (
    <div
      className={chrome.APPROVAL_SCRIM}
      data-testid="landing-browser-approval"
      data-pressed={pressed ? "true" : "false"}
    >
      <Surface tone="floating" shadow="lg" className={chrome.APPROVAL_SHEET}>
        <StudioDialogGutterContext.Provider value="responsive">
          <div data-testid="landing-browser-approval-content" className={chrome.APPROVAL_CONTENT}>
            <div className="flex items-start gap-3">
              <Lock aria-hidden="true" className={chrome.APPROVAL_LOCK} />
              <Text as="p" variant="subtitle" tone="primary" className={chrome.APPROVAL_SENTENCE}>
                {sentence}
              </Text>
            </div>
          </div>
          <StudioDialogFooter padding="default" divider className={chrome.APPROVAL_ACTIONS}>
            <span className={chrome.APPROVAL_BUTTON_SECONDARY}>Deny</span>
            <span
              data-testid="landing-browser-allow"
              className={`${chrome.APPROVAL_BUTTON_PRIMARY}${pressed ? ` ${chrome.BUTTON_PRIMARY_PRESSED}` : ""}`}
            >
              Allow site
            </span>
          </StudioDialogFooter>
        </StudioDialogGutterContext.Provider>
      </Surface>
    </div>
  );
}

export function LandingBrowserView({ stage, script, playing }: { stage: BrowserStage; script: BrowserScript; playing: boolean }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<StageGeometry>(EMPTY_GEOMETRY);

  // The page's anchors move with the pane's width (the page reflows), so they
  // are measured again whenever the stage or the page resizes.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || !stage.page) return;
    const update = () => {
      const next = measureStage(viewport.clientHeight, content);
      if (next) setGeometry((current) => (sameGeometry(current, next) ? current : next));
    };
    update();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [stage.page]);

  // Until the page has been measured (never on a laid-out page, whose layout
  // effect measures it before the first paint) the pointers take a rough spot.
  const kimAt: Spot | null =
    stage.kim === "compare"
      ? (geometry.compare ?? { x: "80%", y: "60%" })
      : stage.kim === "rest"
        ? (geometry.rest ?? { x: "80%", y: "40%" })
        : null;
  const clickAt: Spot = geometry.click ?? { x: "75%", y: "24%" };
  const location = (
    <span className={chrome.BROWSER_LOCATION}>
      <Globe className="h-3.5 w-3.5" aria-hidden="true" />
      <NavArrowDown className="h-3 w-3" aria-hidden="true" />
    </span>
  );
  const address = (
    <span className={chrome.ADDRESS_FIELD} data-testid="landing-browser-address">
      {stage.address ?? <span className={chrome.ADDRESS_PLACEHOLDER}>{stage.placeholder}</span>}
      <span className={chrome.ADDRESS_GO}>
        <NavArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </span>
  );
  const actions = (
    <>
      {stage.connected ? (
        <span className={chrome.BROWSER_PARTICIPANTS} data-testid="landing-browser-participants">
          <span className={chrome.BROWSER_PARTICIPANT_STACK}>
            <Participant crew={ADA} initial="A" />
            {stage.participants.length > 1 ? <span className={chrome.BROWSER_PARTICIPANT_MORE}>+{stage.participants.length - 1}</span> : null}
          </span>
        </span>
      ) : null}
      <span className={chrome.BROWSER_OPTIONS}>
        <MoreHoriz className="h-4 w-4" aria-hidden="true" />
      </span>
    </>
  );

  return (
    <div
      aria-hidden="true"
      data-testid="landing-browser-dock"
      data-browser-connected={stage.connected ? "true" : "false"}
      data-browser-page={stage.page ? "true" : "false"}
      className="flex min-h-0 flex-1 flex-col"
    >
      <BrowserChromeShell compact label="Shared browser controls" leading={location} navigation={null} address={address} actions={actions} />
      <div
        ref={viewportRef}
        data-testid="landing-browser-stage"
        className={`${chrome.BROWSER_VIEWPORT} ${stage.connected ? chrome.BROWSER_VIEWPORT_LIVE : chrome.BROWSER_VIEWPORT_STARTING}`}
      >
        {stage.connected ? (
          <div className={chrome.BROWSER_PAGE}>
            {stage.page ? (
              <div
                ref={contentRef}
                data-testid="landing-browser-page"
                data-scrolled={stage.scrolled ? "true" : "false"}
                className={chrome.BROWSER_PAGE_SCROLL}
                style={{ transform: `translateY(-${stage.scrolled ? geometry.scroll : 0}px)` }}
              >
                <PricingPage teamSelected={stage.teamSelected} />
              </div>
            ) : null}
          </div>
        ) : (
          <div className={chrome.BROWSER_STATE_WRAP}>
            <div className={chrome.BROWSER_STATE_CARD} data-testid="landing-browser-starting">
              <div className="flex items-start gap-3">
                {playing ? <Spinner aria-hidden="true" tone="slate" size="sm" /> : <span className="h-3.5 w-3.5 shrink-0" />}
                <div className="min-w-0 space-y-1">
                  <Text as="p" variant="bodyStrong" tone="primary">
                    Starting Shared Browser
                  </Text>
                  <Text as="p" variant="body" tone="secondary" className="leading-snug">
                    Preparing a secure browser session…
                  </Text>
                </div>
              </div>
            </div>
          </div>
        )}

        {stage.glow ? (
          <div className="pointer-events-none absolute inset-0 z-10" data-testid="landing-browser-glow">
            <div className="browser-agent-surface" data-working="true">
              <div className="browser-agent-glow" />
            </div>
          </div>
        ) : null}

        {stage.cursor ? (
          <div className={`${chrome.POINTER_LAYER} z-20`}>
            <div className={chrome.AI_CURSOR} data-testid="landing-browser-cursor" style={{ left: clickAt.x, top: clickAt.y }}>
              {/* The ripple pings while the cursor shows (motion-safe only). */}
              {playing ? <span className={chrome.AI_CURSOR_RIPPLE} /> : null}
              <PointerArrow fill="#ffffff" stroke="#0f172a" strokeWidth={1.1} />
            </div>
          </div>
        ) : null}

        {kimAt ? (
          <div className={`${chrome.POINTER_LAYER} z-30`}>
            <div className={chrome.PARTICIPANT_POINTER} data-testid="landing-browser-kim" data-at={stage.kim} style={{ left: kimAt.x, top: kimAt.y }}>
              <PointerArrow fill={KIM.fill} stroke="#ffffff" strokeWidth={1.2} />
              <span data-testid="landing-dock-cursor" className={chrome.PARTICIPANT_LABEL} style={{ backgroundColor: KIM.fill, color: KIM.on }}>
                Kim
              </span>
            </div>
          </div>
        ) : null}

        {stage.ticker ? (
          <div className={chrome.TICKER_OVERLAY}>
            <span className={chrome.TICKER_PILL} data-testid="landing-browser-ticker" data-action={stage.ticker.type}>
              <span className={`${chrome.TICKER_DOT} ${chrome.TICKER_DOT_TONE[stage.ticker.type]}`} />
              <span className="truncate">{stage.ticker.label}</span>
            </span>
          </div>
        ) : null}

        {stage.approval !== "none" ? <ApprovalSheet origin={script.origin} pressed={stage.allowPressed} /> : null}
      </div>
    </div>
  );
}
