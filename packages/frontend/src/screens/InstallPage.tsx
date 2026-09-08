import { useEffect } from "react";
import { ComputerIcon, PlayIcon } from "../components/marketingIcons";
import { Badge } from "../components/Badge";
import { Heading } from "../components/Heading";
import { MarketingFooter } from "../components/MarketingFooter";
import { MarketingGridSection } from "../components/MarketingGridSection";
import { MarketingHeader } from "../components/MarketingHeader";
import { Text } from "../components/Text";
import { AppStoreIcon } from "../components/IntegrationIcons";
import { useAuth } from "../providers/AuthProvider";
import { theme } from "../styles/theme";
import { useDesktopReleaseLookup } from "../updates/useDesktopReleaseLookup";
import { applyPageMeta } from "../utils/seo";
import { DesktopDownloadActions } from "./install/DesktopDownloadActions";

const HERO_DESCRIPTION = "Pick a surface and keep building in the same repo.";

// One card recipe for the whole page: a single hairline border on a softly
// raised fill, 16px radius, no shadow. Every visual boundary inside a card is
// carried by spacing and type, not by more boxes -- the previous design
// stacked card border + icon ring + badge border + outlined pills + dashed
// chips and read as noise.
const CARD_CLASSNAME =
  "rounded-2xl border border-slate-200 bg-white/80 p-6 dark:border-white/10 dark:bg-white/[0.04]";

export function InstallPage() {
  const auth = useAuth();
  const user = auth.user;

  const {
    lookup: desktopReleaseLookup,
    retry: retryDesktopRelease,
  } = useDesktopReleaseLookup();

  const desktopAppVersion =
    desktopReleaseLookup.status === "available"
      ? desktopReleaseLookup.manifest.version
      : null;

  useEffect(() => {
    applyPageMeta({
      title: "Install Instafy",
      description: HERO_DESCRIPTION,
      image: "/og-image.png",
    });
  }, []);

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
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-[#ffffff] via-white to-[#efefef] text-slate-900 dark:bg-none dark:bg-[var(--color-studio-dark-canvas)] dark:text-slate-100">
      <MarketingHeader
        items={[
          { label: "Home", to: "/", match: "exact" },
          { label: "Install", to: "/install", match: "exact" },
          { label: "News", to: "/news", match: "prefix" },
          {
            label: user ? "Open Studio" : "Get started",
            to: buildDestination(),
            variant: "primary",
          },
        ]}
      />

      <main className="flex w-full flex-1 flex-col">
        <div className="mx-auto w-full max-w-6xl px-6">
          <section className="w-full pt-8">
            <div className="max-w-3xl text-center md:text-left">
              <Heading level={1} variant="section">
                Install Instafy{" "}
                <span className="text-primary-600 dark:text-primary-400">
                  anywhere.
                </span>
              </Heading>
              <Text variant="bodyLg" tone="secondary" className="mt-4">
                {HERO_DESCRIPTION}
              </Text>
            </div>
          </section>
        </div>

        <MarketingGridSection className="flex-1">
          <div className="mx-auto flex w-full max-w-6xl flex-col px-6 pb-12 pt-8">
            <section className="w-full">
              {/*
                The desktop app is the flagship install -- native shell,
                Personal Browser, auto-update -- so it leads at full width
                with the page's one primary button. Native mobile apps are
                coming soon; Studio remains available in a mobile browser.
              */}
              <div id="desktop" className={`scroll-mt-24 ${CARD_CLASSNAME} sm:p-8`}>
                <div className="flex items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <ComputerIcon aria-hidden="true" className="h-5 w-5 shrink-0 text-slate-700 dark:text-slate-200" />
                      <Heading level={2} variant="title">
                        Desktop app
                      </Heading>
                      {desktopAppVersion ? (
                        <Badge size="xs">v{desktopAppVersion}</Badge>
                      ) : null}
                    </div>
                    <Text variant="body" tone="muted" className="mt-1">
                      Install the native desktop Studio with Personal Browser and automatic updates.
                    </Text>

                    <DesktopDownloadActions
                      lookup={desktopReleaseLookup}
                      onRetry={retryDesktopRelease}
                    />
                    <a
                      href="instafy://studio"
                      className="mt-4 inline-flex text-sm font-medium text-slate-500 underline-offset-4 transition hover:text-slate-800 hover:underline dark:text-slate-400 dark:hover:text-slate-100"
                      data-testid="open-desktop-app"
                    >
                      Already installed? Open Desktop
                    </a>
                  </div>
                </div>
              </div>

              <div id="mobile" className="mt-4 grid scroll-mt-24 gap-4 md:grid-cols-2">
                <div className={CARD_CLASSNAME}>
                  <div className="flex items-start gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <AppStoreIcon aria-hidden="true" className="h-5 w-5 shrink-0 text-[#0EA5E9]" />
                        <Heading level={2} variant="title">
                          iOS
                        </Heading>
                        <Badge size="xs">Soon</Badge>
                      </div>
                      <Text variant="body" tone="muted" className="mt-1">
                        The native iOS app is coming soon. You can use Studio in your browser today.
                      </Text>
                      <div className="mt-4">
                        <a className={theme.button.secondary} href={buildDestination()}>
                          Open Studio in browser
                        </a>
                      </div>
                    </div>
                  </div>
                </div>

                <div className={CARD_CLASSNAME}>
                  <div className="flex items-start gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <PlayIcon aria-hidden="true" className="h-5 w-5 shrink-0 text-emerald-600" />
                        <Heading level={2} variant="title">
                          Android
                        </Heading>
                        <Badge size="xs">Soon</Badge>
                      </div>
                      <Text variant="body" tone="muted" className="mt-1">
                        The native Android app is coming soon.
                      </Text>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <MarketingFooter />
          </div>
        </MarketingGridSection>
      </main>
    </div>
  );
}
