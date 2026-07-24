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

const SECONDARY_BUTTON_CLASSNAME = [
  theme.button.secondary,
  "dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:text-slate-50",
].join(" ");

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
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-[#ffffff] via-white to-[#efefef] text-slate-900 dark:bg-none dark:bg-slate-950 dark:text-slate-100">
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
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-[28px] border border-slate-200 bg-white/90 p-6 shadow-card-lg dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-modal">
                  <div className="flex items-start gap-4">
                    <span
                      aria-hidden="true"
                      className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/90 ring-1 ring-black/5 dark:bg-slate-950/40 dark:ring-white/10"
                    >
                      <AppStoreIcon className="h-5 w-5 text-[#0EA5E9]" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <Heading level={2} variant="title">
                        iOS
                      </Heading>
                      <Text variant="body" tone="muted" className="mt-1">
                        Open the Studio on your phone. Add to Home Screen for an app-like feel.
                      </Text>
                    </div>
                  </div>

                  <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    <a className={SECONDARY_BUTTON_CLASSNAME} href={buildDestination()}>
                      Open Studio
                    </a>
                  </div>
                </div>

                <div className="rounded-[28px] border border-slate-200 bg-white/90 p-6 shadow-card-lg dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-modal">
                  <div className="flex items-start gap-4">
                    <span
                      aria-hidden="true"
                      className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/90 ring-1 ring-black/5 dark:bg-slate-950/40 dark:ring-white/10"
                    >
                      <PlayIcon className="h-5 w-5 text-emerald-600" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Heading level={2} variant="title">
                          Android
                        </Heading>
                        <Badge size="xs">Soon</Badge>
                      </div>
                      <Text variant="body" tone="muted" className="mt-1">
                        Google Play install is coming soon.
                      </Text>
                    </div>
                  </div>
                </div>

                <div
                  id="desktop"
                  className="scroll-mt-24 rounded-[28px] border border-slate-200 bg-white/90 p-6 shadow-card-lg dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-modal"
                >
                  <div className="flex items-start gap-4">
                    <span
                      aria-hidden="true"
                      className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/90 ring-1 ring-black/5 dark:bg-slate-950/40 dark:ring-white/10"
                    >
                      <ComputerIcon className="h-5 w-5 text-slate-700 dark:text-slate-200" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
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
                    </div>
                  </div>

                  <DesktopDownloadActions
                    lookup={desktopReleaseLookup}
                    onRetry={retryDesktopRelease}
                  />
                  <a
                    href="instafy://studio"
                    className="mt-4 inline-flex text-sm font-semibold text-primary-700 underline-offset-4 transition hover:text-primary-800 hover:underline dark:text-primary-300 dark:hover:text-primary-200"
                    data-testid="open-desktop-app"
                  >
                    Already installed? Open Desktop
                  </a>
                </div>
              </div>
            </section>

            <MarketingFooter productName="Instafy" />
          </div>
        </MarketingGridSection>
      </main>
    </div>
  );
}
