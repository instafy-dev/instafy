import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Heading } from "../components/Heading";
import { MarketingHeader } from "../components/MarketingHeader";
import { MarketingFooter } from "../components/MarketingFooter";
import { useAuth } from "../providers/AuthProvider";
import { useMarketingCanvas } from "../theme/useMarketingCanvas";
import { SOCIAL_CARD_IMAGE, applyPageMeta } from "../utils/seo";
import { LandingIntegrationChips } from "./landing/LandingIntegrationChips";
import { LandingFeatures } from "./landing/LandingFeatures";
import { LANDING_GUTTER, LandingHero, PRIMARY_LINK } from "./landing/LandingHero";

export function LandingPage() {
  const { user } = useAuth();
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

  // The whole document takes the paper canvas while the landing is shown, so
  // overscroll matches the page in both themes.
  useMarketingCanvas();

  useEffect(() => {
    applyPageMeta({
      title: "Instafy · The shared studio for your team and its AI agents",
      description:
        "Bring your people, your AI, and your work into one shared studio. Build software, work through the numbers, and launch something together, with real files you control.",
      image: SOCIAL_CARD_IMAGE,
    });
  }, []);

  // Public content can paint while authentication resolves. Studio owns the
  // sign-in decision, including clicks made before a stored session is restored.
  return (
    <div
      className="flex min-h-[100dvh] flex-col bg-[var(--marketing-canvas)] text-slate-900 dark:text-slate-100"
      data-testid="landing-page"
    >
      {/* The header stays outside <main> so it keeps its banner landmark. It
          sits plainly on the paper (no bar, no blur), which is what lets the
          logo carry its crew colours; the raised layer only keeps the phone
          menu above the hero. */}
      <div className="relative z-20">
        <MarketingHeader items={headerItems} markColorway="crew-hidpi" gutterClassName={LANDING_GUTTER} />
      </div>

      <main className="relative z-10 flex w-full flex-1 flex-col">
        <LandingHero entryLabel={entryLabel} />

        <div className={`mx-auto w-full ${LANDING_GUTTER}`}>
          <div className="flex flex-col items-center gap-4 pb-14 pt-6 text-center">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Connects to
            </p>
            <LandingIntegrationChips />
          </div>

          <LandingFeatures />

          <section className="flex flex-col items-start justify-between gap-6 border-t border-slate-200 py-14 dark:border-white/10 sm:flex-row sm:items-center sm:py-20">
            <div>
              <Heading level={2} variant="section" className="text-balance tracking-tight">
                Have an idea? Open a space.
              </Heading>
              <p className="mt-4 max-w-lg text-xs leading-relaxed text-slate-500 dark:text-slate-400" data-testid="landing-sign-in-data-note">
                Sign in with Google, GitHub, or email. Instafy uses only your name, email address, and profile
                picture to create and secure your account.{" "}
                <Link to="/privacy" className="underline underline-offset-2 hover:text-slate-700 dark:hover:text-slate-200">
                  Privacy Policy
                </Link>
                {" · "}
                <Link to="/terms" className="underline underline-offset-2 hover:text-slate-700 dark:hover:text-slate-200">
                  Terms
                </Link>
              </p>
            </div>
            <Link to="/studio" className={`${PRIMARY_LINK} shrink-0`}>
              {entryLabel} <span aria-hidden="true">↗</span>
            </Link>
          </section>
        </div>
      </main>
      <div className="border-t border-slate-200 dark:border-white/10">
        <MarketingFooter />
      </div>
    </div>
  );
}
