import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { OctoMark } from "../../components/OctoMark";

export interface SessionScenario {
  id: string;
  path: string;
  prompt: string;
  doneLine: string;
  workingAgent: string;
  workingLine: string;
  presenceLine: string;
  artifact: "diff" | "ledger" | "browser";
}

// One shared cast across every scenario, matching the tentacle cursors: Ada
// and Kim are the humans, Octo is the lead agent, and the purple agent takes
// a scenario-specific name so each use case reads as its own little crew.
export const SESSION_SCENARIOS: SessionScenario[] = [
  {
    id: "code",
    path: "release-train / checkout-flow",
    prompt: "Split checkout into its own package and fix that flaky payment test",
    doneLine: "Opened fix/checkout-package, 12 files changed, tests green",
    workingAgent: "Canary",
    workingLine: "Rerunning the payment suite",
    presenceLine: "Kim is typing",
    artifact: "diff",
  },
  {
    id: "books",
    path: "acme-books / february-close",
    prompt: "Close out February: reconcile the bank feed and draft the VAT return",
    doneLine: "Matched 214 of 217 bank transactions, flagged 3 for review",
    workingAgent: "Ledger",
    workingLine: "Drafting the VAT return",
    presenceLine: "Kim is typing",
    artifact: "ledger",
  },
  {
    id: "site",
    path: "studio-site / launch-week",
    prompt: "Build a pricing page with three tiers and wire up the contact form",
    doneLine: "Pricing page is on the preview link, the form posts to your inbox",
    workingAgent: "Pixel",
    workingLine: "Polishing the mobile layout",
    presenceLine: "Kim is clicking through the preview",
    artifact: "browser",
  },
];

const ROTATE_INTERVAL_MS = 6500;
const SWIPE_THRESHOLD_PX = 40;

const AVATAR_BASE = "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white";

function AgentTag() {
  return (
    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">
      agent
    </span>
  );
}

function TypingDots() {
  return (
    <span aria-hidden="true" className="inline-flex items-center gap-0.5">
      {[0, 200, 400].map((delay) => (
        <span
          key={delay}
          style={{ animationDelay: `${delay}ms` }}
          className="h-1 w-1 rounded-full bg-current motion-safe:animate-pulse"
        />
      ))}
    </span>
  );
}

const ARTIFACT_FRAME =
  "ml-11 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950";

const ARTIFACT_HEAD =
  "flex items-center gap-1.5 border-b border-slate-200/70 bg-slate-50 px-2.5 py-1.5 text-[10px] font-medium text-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-500";

// Each scenario ends in a concrete artifact so the deck shows real product
// output, not just chat, and the three cards stay close in height.
function DiffPreview() {
  return (
    <div className={ARTIFACT_FRAME}>
      <div className={ARTIFACT_HEAD}>
        <span className="truncate">checkout/router.ts</span>
        <span className="ml-auto shrink-0 font-semibold text-emerald-600 dark:text-emerald-400">+12</span>
        <span className="shrink-0 font-semibold text-rose-500 dark:text-rose-400">-3</span>
      </div>
      <div className="flex flex-col gap-1.5 p-3">
        <div className="flex items-center gap-2">
          <span className="w-2 text-[9px] font-bold leading-none text-emerald-600 dark:text-emerald-400">+</span>
          <span className="h-1.5 w-3/4 rounded-full bg-emerald-200 dark:bg-emerald-500/30" />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 text-[9px] font-bold leading-none text-emerald-600 dark:text-emerald-400">+</span>
          <span className="h-1.5 w-1/2 rounded-full bg-emerald-200 dark:bg-emerald-500/30" />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 text-[9px] font-bold leading-none text-rose-500 dark:text-rose-400">-</span>
          <span className="h-1.5 w-2/3 rounded-full bg-rose-200 dark:bg-rose-500/30" />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2" />
          <span className="h-1.5 w-5/6 rounded-full bg-slate-200 dark:bg-slate-800" />
        </div>
      </div>
    </div>
  );
}

function LedgerPreview() {
  const rows = [
    { width: "w-24", amount: "+2 140,00", flagged: false },
    { width: "w-16", amount: "-89,90", flagged: false },
    { width: "w-20", amount: "-1 204,50", flagged: true },
  ];
  return (
    <div className={ARTIFACT_FRAME}>
      <div className={ARTIFACT_HEAD}>
        <span className="truncate">Bank feed · February</span>
        <span className="ml-auto shrink-0">217 rows</span>
      </div>
      <div className="flex flex-col">
        {rows.map((row) => (
          <div
            key={row.amount}
            className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 last:border-b-0 dark:border-slate-900"
          >
            <span className={`h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 ${row.width}`} />
            <span className="ml-auto font-mono text-[10px] text-slate-500 dark:text-slate-400">{row.amount}</span>
            {row.flagged ? (
              <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">
                review
              </span>
            ) : (
              <span aria-hidden="true" className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                ✓
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// A miniature of the studio's shared in-app browser: the agent's work shows
// up as a live preview inside the session, and Kim's cursor inside it makes
// the co-browsing story visible.
function SharedBrowserPreview() {
  return (
    <div className={ARTIFACT_FRAME}>
      <div className="flex items-center gap-1.5 border-b border-slate-200/70 bg-slate-50 px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-900">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#f87171]" />
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#fbbf24]" />
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#34d399]" />
        <span className="ml-2 flex-1 truncate rounded bg-white px-2 py-0.5 text-[10px] font-medium text-slate-400 ring-1 ring-slate-200/80 dark:bg-slate-950 dark:text-slate-500 dark:ring-slate-800">
          studio-site.instafy.app/pricing
        </span>
      </div>
      <div className="relative grid grid-cols-3 gap-2 p-3">
        {[0, 1, 2].map((tier) => (
          <div
            key={tier}
            className={`rounded-md border p-2 ${
              tier === 1
                ? "border-primary-300 bg-primary-50/60 dark:border-primary-500/40 dark:bg-primary-500/10"
                : "border-slate-200 dark:border-slate-800"
            }`}
          >
            <div className="h-1.5 w-8 rounded-full bg-slate-300 dark:bg-slate-700" />
            <div className="mt-1.5 h-1 w-full rounded-full bg-slate-200 dark:bg-slate-800" />
            <div className="mt-1 h-1 w-3/4 rounded-full bg-slate-200 dark:bg-slate-800" />
            <div className={`mt-2 h-2.5 w-full rounded-full ${tier === 1 ? "bg-primary-500" : "bg-slate-200 dark:bg-slate-800"}`} />
          </div>
        ))}
        <svg aria-hidden="true" className="absolute left-[53%] top-[72%] h-3.5 w-3.5" viewBox="0 0 18 20">
          <path d="M2 1 L16 10 L9 11.5 L7 19 Z" fill="#8cb93b" stroke="#ffffff" strokeWidth="1.5" />
        </svg>
      </div>
    </div>
  );
}

function SessionCard({ scenario, joinTo }: { scenario: SessionScenario; joinTo: string }) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-slate-200/80 bg-white/95 text-left shadow-card-lg backdrop-blur-md dark:border-slate-800 dark:bg-slate-950/90">
      <div className="flex items-center gap-2 border-b border-slate-200/70 px-5 py-3 dark:border-slate-800">
        <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{scenario.path}</span>
        <span
          aria-hidden="true"
          className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500 motion-safe:animate-pulse"
        />
      </div>

      <div className="flex flex-1 flex-col gap-3.5 px-5 py-4">
        <div className="flex items-start gap-3">
          <span className={`${AVATAR_BASE} bg-[#e93d82]`}>A</span>
          <div className="min-w-0 flex-1">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Ada</span>
            <p className="mt-1 inline-block rounded-2xl rounded-tl-md bg-slate-100 px-3.5 py-2 text-sm leading-snug text-slate-800 dark:bg-slate-900 dark:text-slate-200">
              {scenario.prompt}
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <span className={`${AVATAR_BASE} bg-[#f5960a]`}>
            <OctoMark className="h-5 w-5 text-white" />
          </span>
          <div className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
              Octo <AgentTag />
            </span>
            <p className="mt-1 text-sm leading-snug text-slate-700 dark:text-slate-300">
              <span aria-hidden="true" className="mr-1 font-semibold text-emerald-600 dark:text-emerald-400">
                ✓
              </span>
              {scenario.doneLine}
            </p>
          </div>
        </div>

        {scenario.artifact === "browser" ? (
          <SharedBrowserPreview />
        ) : scenario.artifact === "diff" ? (
          <DiffPreview />
        ) : (
          <LedgerPreview />
        )}

        <div className="flex items-start gap-3">
          <span className={`${AVATAR_BASE} bg-[#7c4dd8]`}>{scenario.workingAgent[0]}</span>
          <div className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400">
              {scenario.workingAgent} <AgentTag />
            </span>
            <p className="mt-1 flex items-center gap-1.5 text-sm leading-snug text-slate-500 dark:text-slate-400">
              {scenario.workingLine}
              <TypingDots />
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 pl-11 text-xs font-medium text-slate-400 dark:text-slate-500">
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#8cb93b] text-[9px] font-bold text-white">
            K
          </span>
          {scenario.presenceLine}
          <TypingDots />
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-slate-200/70 px-5 py-3 dark:border-slate-800">
        <Link
          to={joinTo}
          data-testid="landing-join-session-button"
          className="inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-300/60 dark:focus-visible:ring-primary-500/40"
        >
          Start a session
        </Link>
        <span className="text-xs text-slate-500 dark:text-slate-400">No install, runs in your browser</span>
      </div>
    </div>
  );
}

interface LandingSessionDeckProps {
  joinToFor: (scenario: SessionScenario) => string;
  className?: string;
  onScenarioChange?: (scenario: SessionScenario) => void;
}

export function LandingSessionDeck({ joinToFor, className, onScenarioChange }: LandingSessionDeckProps) {
  const [active, setActive] = useState(0);
  const hoverRef = useRef(false);
  const pointerStartX = useRef<number | null>(null);
  const onScenarioChangeRef = useRef(onScenarioChange);
  onScenarioChangeRef.current = onScenarioChange;

  useEffect(() => {
    onScenarioChangeRef.current?.(SESSION_SCENARIOS[active]);
  }, [active]);

  // Keyed on `active` so any change, including a manual dot click or swipe,
  // restarts the full rotation countdown instead of advancing moments later.
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => {
      if (!hoverRef.current) {
        setActive((current) => (current + 1) % SESSION_SCENARIOS.length);
      }
    }, ROTATE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active]);

  const advance = (delta: number) => {
    setActive((current) => (current + delta + SESSION_SCENARIOS.length) % SESSION_SCENARIOS.length);
  };

  return (
    <div className={["w-full max-w-[32rem]", className ?? ""].filter(Boolean).join(" ")}>
      <div
        data-testid="landing-session-deck"
        className="relative grid touch-pan-y motion-safe:animate-[landing-float_7s_ease-in-out_infinite]"
        onMouseEnter={() => {
          hoverRef.current = true;
        }}
        onMouseLeave={() => {
          hoverRef.current = false;
        }}
        onPointerDown={(event) => {
          pointerStartX.current = event.clientX;
        }}
        onPointerUp={(event) => {
          const startX = pointerStartX.current;
          pointerStartX.current = null;
          if (startX === null) return;
          const delta = event.clientX - startX;
          if (Math.abs(delta) < SWIPE_THRESHOLD_PX) return;
          advance(delta < 0 ? 1 : -1);
        }}
      >
        {SESSION_SCENARIOS.map((scenario, index) => {
          const position = (index - active + SESSION_SCENARIOS.length) % SESSION_SCENARIOS.length;
          const stackClass =
            position === 0
              ? "z-30 translate-y-0 rotate-0 scale-100 opacity-100"
              : position === 1
                ? "z-20 -translate-y-3 rotate-1 scale-[0.96] opacity-60"
                : "z-10 -translate-y-6 -rotate-1 scale-[0.92] opacity-35";
          return (
            <div
              key={scenario.id}
              aria-hidden={position !== 0}
              className={`[grid-area:1/1] transition-all duration-500 ease-out ${stackClass} ${
                position === 0 ? "" : "pointer-events-none select-none"
              }`}
            >
              <SessionCard scenario={scenario} joinTo={joinToFor(scenario)} />
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-center gap-2">
        {SESSION_SCENARIOS.map((scenario, index) => (
          <button
            key={scenario.id}
            type="button"
            aria-label={`Show the ${scenario.id} session`}
            onClick={() => setActive(index)}
            className={`h-1.5 rounded-full transition-all ${
              index === active
                ? "w-6 bg-slate-500 dark:bg-slate-300"
                : "w-1.5 bg-slate-300 hover:bg-slate-400 dark:bg-slate-700 dark:hover:bg-slate-500"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
