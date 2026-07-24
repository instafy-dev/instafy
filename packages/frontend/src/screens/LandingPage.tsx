import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Heading } from "../components/Heading";
import { MarketingHeader } from "../components/MarketingHeader";
import { OctoMark } from "../components/OctoMark";
import { Text } from "../components/Text";
import { TextLink } from "../components/TextLink";
import { useAuth } from "../providers/AuthProvider";
import { applyPageMeta } from "../utils/seo";
import { MarketingFooter } from "../components/MarketingFooter";
import { MarketingGridSection } from "../components/MarketingGridSection";
import { LandingIntegrationChips } from "./landing/LandingIntegrationChips";
import { LandingFeatures } from "./landing/LandingFeatures";

export function LandingPage() {
  const auth = useAuth();
  const authLoading = auth.loading;
  const user = auth.user;

  useEffect(() => {
    applyPageMeta({
      title: "Instafy Studio · Your coding agent, your repo, any device",
      description:
        "Bring your own ChatGPT or Codex subscription. An AI agent edits real files in a local or hosted git repo you own that you can open from any device, including your phone.",
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

      <main className="relative isolate flex w-full flex-1 flex-col">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-[-8%] top-4 z-0 h-[34rem] bg-[radial-gradient(52%_58%_at_72%_22%,rgba(0,122,204,0.10)_0%,rgba(0,122,204,0.04)_45%,transparent_75%)] blur-3xl dark:bg-[radial-gradient(56%_60%_at_74%_24%,rgba(55,148,255,0.12)_0%,rgba(55,148,255,0.05)_45%,transparent_75%)]"
          data-testid="landing-ambient-glow"
        />
        <div className="relative z-10 mx-auto w-full max-w-6xl px-6">
          <section className="w-full pt-10 md:pt-14">
            <div className="mx-auto w-full max-w-6xl">
              <div className="relative pb-10 md:min-h-[30rem] md:pb-0 lg:min-h-[34rem]">
                <div className="relative z-10 max-w-3xl pt-8 text-center md:max-w-[37rem] md:pt-10 md:text-left lg:max-w-[40rem] lg:pt-14">
                  <Heading level={1} variant="hero" className="max-w-[13ch]" data-testid="landing-hero-heading">
                    Your coding agent, in a repo you{" "}
                    <span className="text-primary-600 dark:text-primary-400">own.</span>
                  </Heading>
                  <Text variant="lead" tone="secondary" className="mx-auto mt-6 max-w-2xl md:mx-0">
                    Bring the AI you already pay for. It edits real files in a local or hosted git
                    repo that you own and can open from any device, including your phone.
                  </Text>
                  <Text variant="caption" tone="muted" className="mx-auto mt-4 max-w-2xl md:mx-0">
                    Every change lands as a real, revertible commit. Read our{" "}
                    <TextLink to="/privacy" size="xs" tone="muted">
                      Privacy Policy
                    </TextLink>{" "}
                    and{" "}
                    <TextLink to="/terms" size="xs" tone="muted">
                      Terms of Use
                    </TextLink>
                    .
                  </Text>

                  <div className="mx-auto mt-10 flex max-w-3xl flex-col items-center gap-3 md:mx-0 md:items-start">
                    <div className="flex w-full flex-col items-center gap-3 sm:flex-row sm:justify-center md:justify-start">
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
                  </div>

                  <div className="mx-auto mt-12 flex w-full max-w-3xl flex-col items-center gap-2 md:mx-0 md:items-start">
                    <Text variant="caption" tone="muted" className="text-center md:text-left">
                      Integrates with
                    </Text>
                    <LandingIntegrationChips />
                  </div>
                </div>

                <div className="pointer-events-none relative z-0 mx-auto mt-10 flex w-full justify-center md:absolute md:inset-y-0 md:right-4 md:mt-0 md:w-[42%] md:items-center lg:right-10">
                  <OctoMark
                    className="h-52 w-52 text-brand-ink dark:text-brand-paper sm:h-60 sm:w-60 lg:h-72 lg:w-72"
                    title="Octo, the Instafy agent"
                  />
                </div>
              </div>
            </div>
          </section>
        </div>

        <MarketingGridSection className="flex-1">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 pb-24 pt-24">
            <LandingFeatures />

            <section className="mt-24 flex w-full flex-col items-center rounded-[32px] bg-white/80 px-8 py-12 text-center text-slate-900 dark:bg-slate-950/70 dark:text-white">
              <Heading level={2} variant="section" className="text-slate-900 dark:text-white">
                Start building now.
              </Heading>
              <div className="mt-8 flex flex-row items-center justify-center gap-6">
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
