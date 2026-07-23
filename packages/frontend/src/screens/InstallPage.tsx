import { useEffect, useState } from "react";
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
import { applyPageMeta } from "../utils/seo";

const HERO_DESCRIPTION = "Pick a surface and keep building in the same repo.";

const FALLBACK_DESKTOP_APP_VERSION = "0.2.0";
const DESKTOP_APP_STABLE_BASE_URL = "https://downloads.instafy.dev/desktop-app/stable";
const DESKTOP_APP_LATEST_URL = `${DESKTOP_APP_STABLE_BASE_URL}/latest.json`;

type DesktopAppDownloads = {
  macDmg: string;
  macArch: "arm64" | "x64";
  windowsExe: string;
  linuxAppImage?: string;
};

function parseDesktopArtifactUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "downloads.instafy.dev" ||
      !parsed.pathname.startsWith("/desktop-app/stable/")
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseDesktopAppLatestPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const version = record.version;
  const tag = record.tag;
  const channel = record.channel;
  const feedUrl = record.feedUrl;
  const publishedAt = record.publishedAt;
  const sourceSha = record.sourceSha;
  const artifacts = record.artifacts;
  const architectures = record.architectures;
  if (typeof version !== "string" || tag !== `desktop-app-v${version}`) return null;
  if (
    channel !== "stable" ||
    feedUrl !== DESKTOP_APP_STABLE_BASE_URL ||
    typeof publishedAt !== "string" ||
    Number.isNaN(Date.parse(publishedAt)) ||
    typeof sourceSha !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceSha)
  ) {
    return null;
  }
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return null;
  if (!architectures || typeof architectures !== "object" || Array.isArray(architectures)) return null;
  const artifactRecord = artifacts as Record<string, unknown>;
  const architectureRecord = architectures as Record<string, unknown>;
  const macArchitectures = architectureRecord.mac;
  if (
    !Array.isArray(macArchitectures) ||
    macArchitectures.length !== 1 ||
    !["arm64", "x64"].includes(macArchitectures[0])
  ) {
    return null;
  }
  const macArch = macArchitectures[0] as "arm64" | "x64";
  const macDmg = parseDesktopArtifactUrl(artifactRecord.macDmg);
  const windowsExe = parseDesktopArtifactUrl(artifactRecord.windowsExe);
  const linuxAppImage = parseDesktopArtifactUrl(artifactRecord.linuxAppImage);
  if (!macDmg || !macDmg.includes(`-mac-${macArch}.dmg`) || !windowsExe) return null;
  return {
    version,
    tag,
    channel,
    feedUrl,
    publishedAt,
    artifacts: { macDmg, macArch, windowsExe, ...(linuxAppImage ? { linuxAppImage } : {}) },
  };
}

const SECONDARY_BUTTON_CLASSNAME = [
  theme.button.secondary,
  "dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:text-slate-50",
].join(" ");

export function InstallPage() {
  const auth = useAuth();
  const user = auth.user;

  const [desktopAppVersion, setDesktopAppVersion] = useState(FALLBACK_DESKTOP_APP_VERSION);
  const [desktopAppArtifacts, setDesktopAppArtifacts] = useState<DesktopAppDownloads | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const timer = window.setTimeout(() => controller.abort(), 1500);
    (async () => {
      try {
        const res = await fetch(DESKTOP_APP_LATEST_URL, { signal: controller.signal });
        if (!res.ok) {
          setDesktopAppArtifacts(null);
          return;
        }

        const parsed = parseDesktopAppLatestPayload((await res.json()) as unknown);
        if (!parsed) {
          setDesktopAppArtifacts(null);
          return;
        }

        setDesktopAppVersion(parsed.version);
        setDesktopAppArtifacts(parsed.artifacts);
      } catch {
        // The signed stable feed is authoritative. Do not invent links to an
        // installer version that has not passed the publication workflow.
        setDesktopAppArtifacts(null);
      }
    })();

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, []);

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

  const desktopAppDownloads = desktopAppArtifacts;

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

                <div className="rounded-[28px] border border-slate-200 bg-white/90 p-6 shadow-card-lg dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-modal">
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
                        <Badge size="xs">v{desktopAppVersion}</Badge>
                      </div>
                      <Text variant="body" tone="muted" className="mt-1">
                        Install the native desktop Studio with Personal Browser and automatic updates.
                      </Text>
                    </div>
                  </div>

                  {desktopAppDownloads ? (
                    <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                      <a
                        className={SECONDARY_BUTTON_CLASSNAME}
                        href={desktopAppDownloads.macDmg}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {desktopAppDownloads.macArch === "arm64"
                          ? "macOS Apple silicon (DMG)"
                          : "macOS Intel (DMG)"}
                      </a>
                      <a
                        className={SECONDARY_BUTTON_CLASSNAME}
                        href={desktopAppDownloads.windowsExe}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Windows (EXE)
                      </a>
                      {desktopAppDownloads.linuxAppImage ? (
                        <a
                          className={SECONDARY_BUTTON_CLASSNAME}
                          href={desktopAppDownloads.linuxAppImage}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Linux (AppImage)
                        </a>
                      ) : null}
                    </div>
                  ) : (
                    <Text variant="caption" tone="muted" className="mt-5">
                      Signed desktop installers are not published yet.
                    </Text>
                  )}
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
