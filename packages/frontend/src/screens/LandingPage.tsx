import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Heading } from "../components/Heading";
import { MarketingHeader } from "../components/MarketingHeader";
import { Text } from "../components/Text";
import { TextLink } from "../components/TextLink";
import { useAuth } from "../providers/AuthProvider";
import { applyPageMeta } from "../utils/seo";
import { MarketingFooter } from "../components/MarketingFooter";
import { MarketingGridSection } from "../components/MarketingGridSection";
import { LandingIntegrationChips } from "./landing/LandingIntegrationChips";
import { LandingFeatures } from "./landing/LandingFeatures";
import { LandingSessionDeck, SESSION_SCENARIOS } from "./landing/LandingSessionDeck";
import { LandingTentacleScene } from "./landing/LandingTentacleScene";

export function LandingPage() {
  const auth = useAuth();
  const [purpleAgent, setPurpleAgent] = useState(SESSION_SCENARIOS[0].workingAgent);
  const authLoading = auth.loading;
  const user = auth.user;

  useEffect(() => {
    applyPageMeta({
      title: "Instafy · The shared studio for your team and its AI agents",
      description:
        "Ship code, close the books, launch the site: your team and its AI agents work side by side in one live session. Bring the AI you already pay for; every change lands as a real, revertible commit in files you own.",
      image: "/og-image.png",
    });
  }, []);

  if (authLoading) {
    return (
      <div className="flex min-h-screen min-h-[100dvh] items-center justify-center bg-gradient-to-br from-slate-100 via-white to-[#efefef] dark:bg-none dark:bg-[var(--color-studio-dark-canvas)]">
        <div className="rounded-3xl border border-white/60 bg-white/90 px-8 py-6 shadow-xl dark:border-slate-800 dark:bg-slate-950/70">
          <Text variant="bodyStrong" tone="secondary">
            Loading Instafy…
          </Text>
        </div>
      </div>
    );
  }

  const buildDestination = (query?: string | null) => {
    const trimmedQuery = typeof query === "string" && query.length > 0 ? `?${query}` : "";
    const target = `/studio${trimmedQuery}`;
    if (user) {
      return target;
    }
    const params = new URLSearchParams();
    params.set("redirect", target);
    return `/login?${params.toString()}`;
  };

  return (
    <div
      className="flex min-h-screen min-h-[100dvh] flex-col overflow-x-hidden bg-gradient-to-b from-[#ffffff] via-white to-[#efefef] text-slate-900 dark:bg-none dark:bg-[var(--color-studio-dark-canvas)] dark:text-slate-100"
      data-testid="landing-page"
    >
      <main className="relative isolate flex w-full flex-1 flex-col">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-[-8%] top-4 z-0 h-[34rem] bg-[radial-gradient(52%_58%_at_72%_22%,rgba(0,122,204,0.10)_0%,rgba(0,122,204,0.04)_45%,transparent_75%)] blur-3xl dark:bg-[radial-gradient(56%_60%_at_74%_24%,rgba(55,148,255,0.12)_0%,rgba(55,148,255,0.05)_45%,transparent_75%)]"
          data-testid="landing-ambient-glow"
        />
        <section className="relative z-10 flex min-h-[min(100dvh,72rem)] w-full flex-col overflow-hidden">
          <LandingTentacleScene purpleAgentLabel={`${purpleAgent} · agent`} />

          {/* The artwork runs behind the header, which becomes a translucent
              blur bar instead of a solid band sitting on the page canvas. */}
          <div className="relative z-20 bg-white/40 backdrop-blur-md dark:bg-black/25">
            <MarketingHeader
              items={[
                { label: "Home", to: "/", match: "exact" },
                { label: "Install", to: "/install", match: "exact" },
                { label: "News", to: "/news", match: "prefix" },
                {
                  label: user ? "Open Studio" : "Get started",
                  to: buildDestination(),
                  variant: "primary",
                  testId: "landing-launch-button",
                },
              ]}
            />
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-6 pb-10 pt-6 text-center md:pt-8">
            <Heading level={1} variant="hero" className="max-w-[16ch]" data-testid="landing-hero-heading">
              Ship it together,{" "}
              <span className="text-primary-600 dark:text-primary-400">all arms on deck.</span>
            </Heading>
            <Text variant="lead" tone="secondary" className="mt-5 max-w-2xl">
              Instafy is the shared studio where your team and its AI agents get real work done
              together: ship code, close the books, launch the site. Bring the AI you already pay
              for, and every change lands as a real, revertible commit in files you own.
            </Text>
            <Text variant="caption" tone="muted" className="mt-3 max-w-2xl">
              Read our{" "}
              <TextLink to="/privacy" size="xs" tone="muted">
                Privacy Policy
              </TextLink>{" "}
              and{" "}
              <TextLink to="/terms" size="xs" tone="muted">
                Terms of Use
              </TextLink>
              .
            </Text>

            <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
              <Link
                to={buildDestination()}
                className="inline-flex items-center justify-center whitespace-nowrap rounded-full bg-primary-600 px-8 py-4 text-base font-semibold text-white shadow-md shadow-primary-900/10 transition hover:bg-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 dark:shadow-black/30 dark:focus-visible:ring-primary-500/40 md:px-6 md:py-3.5 md:text-sm lg:px-8 lg:py-4 lg:text-base"
                data-testid="landing-get-started-button"
              >
                Get started
              </Link>
              <Link
                to="/install"
                className="inline-flex items-center justify-center whitespace-nowrap px-2 py-2 text-sm font-semibold text-slate-600 underline-offset-4 transition hover:text-slate-900 hover:underline dark:text-slate-300 dark:hover:text-white"
              >
                Install Instafy
              </Link>
            </div>

            <LandingSessionDeck
              joinToFor={(scenario) => buildDestination(`from=landing-${scenario.id}`)}
              className="mt-8"
              onScenarioChange={(scenario) => setPurpleAgent(scenario.workingAgent)}
            />

            <div className="mt-8 flex w-full max-w-3xl flex-col items-center gap-2">
              <Text variant="caption" tone="muted">
                Works with the subscriptions you already pay for
              </Text>
              <LandingIntegrationChips />
            </div>
          </div>
        </section>

        <MarketingGridSection className="flex-1">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 pb-24 pt-24">
            <LandingFeatures />

            <section className="mt-20 flex w-full flex-col items-center text-center">
              <Heading level={2} variant="section" className="text-slate-900 dark:text-white">
                All arms on deck?
              </Heading>
              <Text variant="body" tone="secondary" className="mt-2">
                Start a session and bring your crew.
              </Text>
              <div className="mt-6 flex flex-row items-center justify-center gap-6">
                <Link
                  to={user ? "/studio" : buildDestination()}
                  className="inline-flex items-center justify-center rounded-full bg-primary-600 px-6 py-3 text-sm font-semibold text-white shadow-md shadow-primary-900/10 transition hover:bg-primary-700 dark:shadow-black/30"
                >
                  {user ? "Open Studio" : "Get started"}
                </Link>
                {!user ? (
                  <Link
                    to={buildDestination()}
                    className="text-sm font-semibold text-slate-600 underline-offset-4 transition hover:text-slate-900 hover:underline dark:text-slate-300 dark:hover:text-white"
                  >
                    Sign in
                  </Link>
                ) : null}
              </div>
            </section>
          </div>

          <MarketingFooter />
        </MarketingGridSection>
      </main>
    </div>
  );
}
