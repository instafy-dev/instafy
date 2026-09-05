import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Heading } from "../components/Heading";
import { MarketingHeader } from "../components/MarketingHeader";
import { MarketingFooter } from "../components/MarketingFooter";
import { useAuth } from "../providers/AuthProvider";
import { applyPageMeta } from "../utils/seo";
import { LandingIntegrationChips } from "./landing/LandingIntegrationChips";
import { LandingFeatures } from "./landing/LandingFeatures";
import { LandingSessionDeck } from "./landing/LandingSessionDeck";

const PRIMARY_LINK =
  "inline-flex min-h-12 items-center justify-center gap-3 rounded-xl bg-primary-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-500";

export function LandingPage() {
  const { user } = useAuth();
  const entryLabel = user ? "Open Studio" : "Get started";

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
      <MarketingHeader
        items={[
          { label: "Install", to: "/install", match: "exact" },
          { label: "News", to: "/news", match: "prefix" },
          {
            label: entryLabel,
            to: "/studio",
            variant: "primary",
            testId: "landing-launch-button",
          },
        ]}
      />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6">
        <section aria-labelledby="landing-title" className="pb-12 pt-10 sm:pt-16 lg:pt-20">
          <p className="flex items-center gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-primary-600 dark:bg-primary-400" />
            A shared studio for people and AI
          </p>
          <div className="mt-5 grid gap-6 lg:grid-cols-[1.15fr_1fr] lg:items-end lg:gap-12">
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
            joinToFor={(scenario) => `/studio?from=landing-${scenario.id}`}
            className="mt-10 sm:mt-14"
          />
          <div className="mt-10 flex flex-col items-center gap-4 text-center">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Bring the tools and AI you already use
            </p>
            <LandingIntegrationChips />
          </div>
        </section>

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
      </main>
      <div className="border-t border-slate-200 dark:border-white/10">
        <MarketingFooter />
      </div>
    </div>
  );
}
