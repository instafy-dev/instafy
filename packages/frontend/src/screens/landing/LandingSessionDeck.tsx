import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { OctoMark } from "../../components/OctoMark";

export interface SessionScenario {
  id: string;
  label: string;
  title: string;
  path: string;
  prompt: string;
  response: string;
  doneLine: string;
  workingAgent: string;
  workingLine: string;
  presenceLine: string;
  artifact: "diff" | "ledger" | "browser";
}

export const SESSION_SCENARIOS: SessionScenario[] = [
  {
    id: "code",
    label: "Build a feature",
    title: "Checkout flow",
    path: "launch-week / checkout-flow",
    prompt: "Give checkout its own package, and make sure the payment flow still works.",
    response: "The checkout code is in its own package. The existing routes use it, and the changes are ready to review.",
    doneLine: "Checkout package extracted",
    workingAgent: "Octo",
    workingLine: "Checking the payment flow",
    presenceLine: "Ada and Kim",
    artifact: "diff",
  },
  {
    id: "books",
    label: "Close the books",
    title: "February close",
    path: "launch-week / february-close",
    prompt: "Reconcile February's transactions and set aside anything that needs a second look.",
    response: "I've matched 214 transactions to the bank statement. Three need your review; I've marked them in the ledger.",
    doneLine: "214 transactions reconciled",
    workingAgent: "Octo",
    workingLine: "Preparing the month-end summary",
    presenceLine: "Ada and Kim",
    artifact: "ledger",
  },
  {
    id: "site",
    label: "Launch a site",
    title: "Pricing page",
    path: "launch-week / pricing-page",
    prompt: "Build a simple pricing page for our new plans. Make it feel good on a phone, too.",
    response: "The pricing page is ready to look through. The plans share one layout, with a clear next step for each team.",
    doneLine: "Pricing page created",
    workingAgent: "Octo",
    workingLine: "Checking the mobile layout",
    presenceLine: "Ada and Kim",
    artifact: "browser",
  },
];

const FOCUS_STYLE = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900";

function Checkmark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" fill="none">
      <path d="m3.5 8 3 3 6-6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DiffPreview() {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div className="border-b border-slate-200 px-4 py-3 font-mono text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
        checkout/router.ts
      </div>
      <pre className="overflow-x-auto py-4 text-xs leading-7" aria-label="Example code changes">
        <code>
          <span className="block px-4 text-slate-500 dark:text-slate-400">  // One place for checkout</span>
          <span className="block bg-emerald-50 px-4 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">+ import checkout from "./checkout";</span>
          <span className="block px-4 text-slate-600 dark:text-slate-300">  </span>
          <span className="block bg-emerald-50 px-4 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">+ router.use("/checkout", checkout);</span>
        </code>
      </pre>
      <div className="flex items-center gap-2 border-t border-slate-200 px-4 py-3 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
        <Checkmark /> Typecheck passed
        <span className="ml-auto font-mono text-emerald-700 dark:text-emerald-400">+12 −3</span>
      </div>
    </div>
  );
}

function LedgerPreview() {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div className="border-b border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 dark:border-slate-700 dark:text-slate-200">
        February reconciliation
      </div>
      <table className="w-full text-left text-xs">
        <thead className="text-slate-500 dark:text-slate-400">
          <tr><th className="px-4 py-3 font-medium">Transaction</th><th className="px-4 py-3 text-right font-medium">Amount</th></tr>
        </thead>
        <tbody className="text-slate-700 dark:text-slate-200">
          <tr className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-3">Acme invoice</td><td className="px-4 py-3 text-right font-mono">+2,140.00</td></tr>
          <tr className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-3">Software</td><td className="px-4 py-3 text-right font-mono">−89.90</td></tr>
          <tr className="border-t border-slate-100 dark:border-slate-800"><td className="px-4 py-3">Bank charge <span className="mt-1 block text-amber-700 dark:text-amber-300">Review needed</span></td><td className="px-4 py-3 text-right font-mono">−24.00</td></tr>
        </tbody>
      </table>
      <div className="flex items-center gap-2 border-t border-slate-200 px-4 py-3 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
        <Checkmark /> 214 matched <span className="ml-auto">3 to review</span>
      </div>
    </div>
  );
}

function SitePreview() {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
        <span className="h-2 w-2 rounded-full bg-slate-300 dark:bg-slate-600" aria-hidden="true" />
        /pricing
      </div>
      <div className="px-4 py-6">
        <p className="text-xs font-medium uppercase tracking-widest text-slate-500 dark:text-slate-400">Forma</p>
        <h4 className="mt-3 text-lg font-semibold tracking-tight text-slate-900 dark:text-white">Room for your next idea.</h4>
        <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">Simple plans. Space to grow.</p>
        <div className="mt-5 grid grid-cols-2 gap-3">
          {[{ name: "Starter", price: "$19" }, { name: "Team", price: "$49" }].map((plan) => (
            <div key={plan.name} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p className="text-xs font-medium text-slate-600 dark:text-slate-300">{plan.name}</p>
              <p className="mt-3 text-xl font-semibold text-slate-900 dark:text-white">{plan.price}<span className="text-xs font-normal text-slate-500 dark:text-slate-400"> / mo</span></p>
            </div>
          ))}
        </div>
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
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [isVisible, setIsVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const frameRef = useRef<HTMLDivElement | null>(null);
  const onScenarioChangeRef = useRef(onScenarioChange);
  onScenarioChangeRef.current = onScenarioChange;
  const scenario = SESSION_SCENARIOS[active];
  const isWorking = motionEnabled && isVisible && pageVisible;

  useEffect(() => {
    onScenarioChangeRef.current?.(scenario);
  }, [scenario]);

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

  return (
    <div className={["w-full", className ?? ""].filter(Boolean).join(" ")}>
      <div role="group" aria-label="Choose a workspace example" className="mb-5 flex flex-wrap items-center justify-center gap-2">
        {SESSION_SCENARIOS.map((example, index) => (
          <button
            key={example.id}
            type="button"
            aria-pressed={active === index}
            onClick={() => setActive(index)}
            className={`rounded-full border px-4 py-2.5 text-sm font-medium transition-colors ${FOCUS_STYLE} ${active === index
              ? "border-slate-900 bg-slate-900 text-white dark:border-slate-200 dark:bg-slate-100 dark:text-slate-900"
              : "border-slate-200 bg-transparent text-slate-600 hover:border-slate-400 hover:text-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-white"}`}
          >
            {example.label}
          </button>
        ))}
      </div>

      <div ref={frameRef} data-testid="landing-session-deck" data-example={scenario.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white text-left shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-700 sm:px-6">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="grid h-7 w-7 grid-cols-2 gap-1 rounded-md border border-slate-200 p-1.5 dark:border-slate-600">
              {[0, 1, 2, 3].map((cell) => <span key={cell} className="rounded-[1px] bg-slate-400 dark:bg-slate-500" />)}
            </span>
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">Launch week</span>
            <span className="hidden text-xs text-slate-500 dark:text-slate-400 sm:inline">Workspace</span>
          </div>
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Interactive example</span>
        </div>

        <div className="grid lg:grid-cols-[10rem_minmax(0,1fr)] xl:grid-cols-[10rem_minmax(0,1fr)_21rem]">
          <aside aria-label="Example workspace navigation" className="hidden border-r border-slate-200 bg-slate-50/70 px-3 py-6 dark:border-slate-700 dark:bg-slate-950/35 lg:row-span-2 lg:block xl:row-span-1">
            <p className="px-3 text-xs font-medium text-slate-500 dark:text-slate-400">SPACES</p>
            <p className="mt-3 rounded-lg bg-white px-3 py-2 text-sm font-medium text-slate-800 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700">Launch week</p>
            <p className="mt-7 px-3 text-xs font-medium text-slate-500 dark:text-slate-400">CHATS</p>
            <p className="mt-3 rounded-lg bg-slate-200/60 px-3 py-2 text-sm font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">{scenario.title}</p>
            <p className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">Ideas & notes</p>
            <div className="mt-16 px-3">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">IN THIS SPACE</p>
              <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">{scenario.presenceLine}</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Octo</p>
            </div>
          </aside>

          <section aria-label={`${scenario.label} conversation`} className="min-w-0 px-5 py-6 sm:px-7">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100">{scenario.title}</h3>
              <span className="text-xs text-slate-500 dark:text-slate-400">Shared chat</span>
            </div>
            <div className="mt-7 flex items-start gap-3">
              <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">AD</span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">Ada</p>
                <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{scenario.prompt}</p>
              </div>
            </div>
            <div className="mt-7 flex items-start gap-3">
              <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white" data-testid="landing-octo-working">
                <OctoMark className="h-[85%] w-[85%] text-brand-ink" motion={isWorking ? "thinking" : "idle"} title="Octo" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">Octo</p>
                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-400">Agent</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{scenario.response}</p>
                <p className="mt-5 border-l-2 border-slate-200 pl-3 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">{scenario.workingLine}…</p>
              </div>
            </div>
            <div className="mt-8 flex items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
              <p className="text-xs text-slate-500 dark:text-slate-400">Your team. Your agents. One conversation.</p>
              <button
                type="button"
                onClick={() => setMotionEnabled((enabled) => !enabled)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white ${FOCUS_STYLE}`}
              >
                <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
                  {motionEnabled ? <path d="M4 3h3v10H4zM9 3h3v10H9z" /> : <path d="m5 3 8 5-8 5z" />}
                </svg>
                {motionEnabled ? "Pause motion" : "Play motion"}
              </button>
            </div>
          </section>

          <section aria-label={`${scenario.label} output`} className="min-w-0 border-t border-slate-200 bg-slate-50/70 p-5 dark:border-slate-700 dark:bg-slate-950/35 sm:p-6 xl:border-l xl:border-t-0">
            <div className="mb-5 flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
              <span>WORKSPACE OUTPUT</span>
              <span className="ml-auto rounded-md border border-slate-200 bg-white px-2 py-1 normal-case dark:border-slate-700 dark:bg-slate-900">Saved</span>
            </div>
            {scenario.artifact === "diff" ? <DiffPreview /> : scenario.artifact === "ledger" ? <LedgerPreview /> : <SitePreview />}
            <div className="mt-4 flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300"><Checkmark /><p>{scenario.doneLine}</p></div>
            <p className="mt-2 pl-6 text-xs leading-5 text-slate-500 dark:text-slate-400">Real files, ready for your review.</p>
          </section>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-4 dark:border-slate-700 sm:px-6">
          <p className="text-xs text-slate-500 dark:text-slate-400">An example of what you can do together.</p>
          <Link to={joinToFor(scenario)} data-testid="landing-join-session-button" className={`inline-flex items-center gap-2 rounded-md py-1 text-sm font-semibold text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 ${FOCUS_STYLE}`}>
            Start your own session <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
