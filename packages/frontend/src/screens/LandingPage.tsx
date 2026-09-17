import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Heading } from "../components/Heading";
import { MarketingHeader } from "../components/MarketingHeader";
import { MarketingFooter } from "../components/MarketingFooter";
import { useAuth } from "../providers/AuthProvider";
import { applyPageMeta } from "../utils/seo";
import { LandingIntegrationChips } from "./landing/LandingIntegrationChips";
import { LandingFeatures } from "./landing/LandingFeatures";
import { LandingSessionDeck, SESSION_SCENARIOS } from "./landing/LandingSessionDeck";
import { LandingTentacleScene } from "./landing/LandingTentacleScene";

const PRIMARY_LINK =
  "inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-primary-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-500";

export function LandingPage() {
  const { user } = useAuth();
  const [purpleAgent, setPurpleAgent] = useState(SESSION_SCENARIOS[0].presenceAgent);
  const deckRef = useRef<HTMLDivElement | null>(null);
  const entryLabel = user ? "Open Studio" : "Get started";
  const headerItems = [
    { label: "Install", to: "/install", match: "exact" as const },
    { label: "News", to: "/news", match: "prefix" as const },
    {
      label: entryLabel,
      to: "/studio",
      variant: "primary" as const,
      testId: "landing-launch-button",
    },
  ];

  useEffect(() => {
    applyPageMeta({
      title: "Instafy · The shared studio for your team and its AI agents",
      description:
        "Bring your people, your AI, and your work into one shared studio. Build software, work through the numbers, and launch something together, with real files you control.",
      image: "/og-image.png",
    });
  }, []);

  // Public content can paint while authentication resolves. Studio owns the
  // sign-in decision, including clicks made before a stored session is restored.
  return (
    <div
      className="flex min-h-[100dvh] flex-col bg-white text-slate-900 dark:bg-[var(--color-studio-dark-canvas)] dark:text-slate-100"
      data-testid="landing-page"
    >
      {/* The header stays outside <main> so it keeps its banner landmark; the
          hero section below it holds only the headline, deck and chips. */}
      <div className="relative isolate flex w-full flex-1 flex-col">
        {/* The tentacle artwork and its presence cursors sit behind the hero
            in a viewport-sized box, so the cover crop and the image-space
            cursor anchors match the composition they were tuned for rather
            than stretching over the full-height deck. The box never drops
            below 60rem: on short laptop viewports a shallower box would crop
            the artwork tighter and pull the pink arm and Ada's cursor into
            the hero copy. The bottom fade ends inside the deck region so the
            page flows on. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[max(60rem,min(100dvh,72rem))]"
        >
          <LandingTentacleScene purpleAgentLabel={`${purpleAgent} · agent`} occluderRef={deckRef} />
        </div>

        {/* The artwork runs behind the header, which becomes a translucent
            blur bar instead of a solid band sitting on the page canvas. */}
        <div className="relative z-20 bg-white/40 backdrop-blur-md dark:bg-black/25">
          <MarketingHeader items={headerItems} />
        </div>

        <main className="relative z-10 flex w-full flex-1 flex-col">
          <section aria-labelledby="landing-title" className="mx-auto w-full max-w-6xl px-6 pb-12 pt-10 sm:pt-16 lg:pt-20">
            <div className="grid gap-6 lg:grid-cols-[1.15fr_1fr] lg:items-end lg:gap-12">
              <h1
                id="landing-title"
                className="text-[clamp(2.75rem,6.5vw,5.25rem)] font-semibold leading-[1.03] tracking-[-0.055em]"
                data-testid="landing-hero-heading"
              >
                Good work<br />
                <span className="text-primary-600 dark:text-primary-400">has company.</span>
              </h1>
              <div className="max-w-md lg:pb-1">
                <p className="text-base leading-relaxed text-slate-600 dark:text-slate-300 sm:text-lg">
                  Bring your people, your AI, and your work into one place.
                  Build a feature, work through the numbers, or launch something together.
                </p>
                <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
                  <Link to="/studio" className={PRIMARY_LINK} data-testid="landing-get-started-button">
                    {entryLabel} <span aria-hidden="true">↗</span>
                  </Link>
                  <Link
                    to="/install"
                    className="inline-flex min-h-12 items-center text-sm font-medium text-slate-600 underline-offset-4 hover:text-slate-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-500 dark:text-slate-300 dark:hover:text-white"
                  >
                    Install Instafy
                  </Link>
                </div>
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  Start in your browser. Your files stay yours.
                </p>
              </div>
            </div>

            <LandingSessionDeck
              ref={deckRef}
              joinToFor={(scenario) => `/studio?from=landing-${scenario.id}`}
              className="mt-10 sm:mt-14"
              onScenarioChange={(scenario) => setPurpleAgent(scenario.presenceAgent)}
            />
            <div className="mt-10 flex flex-col items-center gap-4 text-center">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Bring the tools and AI you already use
              </p>
              <LandingIntegrationChips />
            </div>
          </section>

          <div className="mx-auto w-full max-w-6xl px-6">
            <LandingFeatures />

            <section className="flex flex-col items-start justify-between gap-6 border-t border-slate-200 py-14 dark:border-white/10 sm:flex-row sm:items-center sm:py-20">
              <div>
                <Heading level={2} variant="section" className="tracking-tight">
                  Make room for your next idea.
                </Heading>
                <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                  Open a space. Bring your crew. Take it from there.
                </p>
              </div>
              <Link to="/studio" className={`${PRIMARY_LINK} shrink-0`}>
                {entryLabel} <span aria-hidden="true">↗</span>
              </Link>
            </section>
          </div>
        </main>
      </div>
      <div className="border-t border-slate-200 dark:border-white/10">
        <MarketingFooter />
      </div>
    </div>
  );
}
