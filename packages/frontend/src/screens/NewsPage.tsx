import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { PostgrestError } from "@supabase/supabase-js";
import { BellIcon } from "../components/marketingIcons";
import { Heading } from "../components/Heading";
import { MarketingFooter } from "../components/MarketingFooter";
import { MarketingGridSection } from "../components/MarketingGridSection";
import { MarketingHeader } from "../components/MarketingHeader";
import { Text } from "../components/Text";
import { hasSupabaseConfig, supabase } from "../lib/supabaseClient";
import { useAuth } from "../providers/AuthProvider";
import { theme } from "../styles/theme";
import { applyPageMeta } from "../utils/seo";
import { formatNewsDate, newsPosts } from "./news/newsPosts";

function isPlausibleEmail(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.length > 320) return false;
  const [local, domain] = trimmed.split("@");
  if (!local || !domain) return false;
  if (!domain.includes(".")) return false;
  return true;
}

function describeSubscribeError(error: unknown) {
  const postgrest = error as PostgrestError | undefined;
  const code = typeof postgrest?.code === "string" ? postgrest.code : "";
  if (code === "42P01") {
    return "Newsletter storage is not set up yet.";
  }
  if (code === "42501") {
    return "Newsletter storage is locked down right now.";
  }
  return "Something went wrong. Please try again in a moment.";
}

export function NewsPage() {
  const auth = useAuth();
  const user = auth.user;

  const heroDescription = useMemo(
    () =>
      "Product updates, release notes, and what we’re shipping next. Subscribe for email updates so you don’t miss the next release.",
    [],
  );

  useEffect(() => {
    applyPageMeta({
      title: "News & Updates · Instafy Studio",
      description: heroDescription,
      image: "/og-image.png",
    });
  }, [heroDescription]);

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

  const sortedPosts = useMemo(
    () => [...newsPosts].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),
    [],
  );

  const [email, setEmail] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [subscribeStatus, setSubscribeStatus] = useState<"idle" | "loading" | "success" | "error">(
    "idle",
  );
  const [subscribeMessage, setSubscribeMessage] = useState<string | null>(null);

  const handleSubscribe = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (subscribeStatus === "loading") return;

    const normalizedEmail = email.trim().toLowerCase();
    if (!isPlausibleEmail(normalizedEmail)) {
      setSubscribeStatus("error");
      setSubscribeMessage("Enter a valid email address.");
      return;
    }

    if (honeypot.trim().length > 0) {
      setSubscribeStatus("success");
      setSubscribeMessage("Thanks! You’re on the list.");
      return;
    }

    if (!hasSupabaseConfig) {
      setSubscribeStatus("error");
      setSubscribeMessage("Newsletter signups aren’t configured in this environment yet.");
      return;
    }

    setSubscribeStatus("loading");
    setSubscribeMessage(null);

    const payload = {
      email: normalizedEmail,
      source: "marketing-news",
      referrer: typeof window === "undefined" ? null : window.location.href,
      user_agent: typeof navigator === "undefined" ? null : navigator.userAgent,
    };

    try {
      const { error } = await supabase.from("newsletter_subscribers").insert(payload);

      if (error) {
        if (error.code === "23505") {
          setSubscribeStatus("success");
          setSubscribeMessage("You’re already subscribed — we’ll keep you posted.");
          return;
        }
        throw error;
      }

      setSubscribeStatus("success");
      setSubscribeMessage("Thanks! You’re on the list.");
      setEmail("");
    } catch (error) {
      setSubscribeStatus("error");
      setSubscribeMessage(describeSubscribeError(error));
    }
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
          <section className="w-full pt-10">
            <div className="max-w-3xl text-center md:text-left">
              <Heading level={1} variant="hero" className="mt-6">
                News &{" "}
                <span className="text-primary-600 dark:text-primary-400">
                  updates
                </span>
              </Heading>

              <Text variant="lead" tone="secondary" className="mx-auto mt-6 max-w-3xl md:mx-0">
                {heroDescription}
              </Text>

              <div id="subscribe" className="mx-auto mt-10 max-w-3xl md:mx-0">
                <form onSubmit={handleSubscribe} className="w-full">
                  <label className="sr-only" htmlFor="newsletter-email">
                    Email address
                  </label>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className="relative w-full">
                      <BellIcon
                        aria-hidden="true"
                        className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400 dark:text-slate-500"
                      />
                      <input
                        id="newsletter-email"
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        placeholder="Email for updates"
                        className="w-full rounded-full border border-slate-200 bg-white/80 py-3 pl-12 pr-4 text-base font-semibold text-slate-800 shadow-sm outline-none transition focus:border-indigo-300 focus:ring-2 focus:ring-indigo-200 sm:text-sm dark:border-slate-700 dark:bg-slate-950/50 dark:text-slate-100 dark:focus:border-indigo-400 dark:focus:ring-indigo-500/30"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        disabled={subscribeStatus === "loading"}
                      />
                    </div>
                    <button
                      type="submit"
                      className={`${theme.button.primary} px-6 py-3 text-sm`}
                      disabled={subscribeStatus === "loading"}
                    >
                      {subscribeStatus === "loading" ? "Subscribing…" : "Subscribe"}
                    </button>
                  </div>

                  <label className="sr-only" htmlFor="newsletter-company">
                    Company
                  </label>
                  <input
                    id="newsletter-company"
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                    className="hidden"
                    value={honeypot}
                    onChange={(event) => setHoneypot(event.target.value)}
                  />

                  {subscribeMessage ? (
                    <div className="mt-3">
                      <Text
                        variant="caption"
                        tone={
                          subscribeStatus === "success"
                            ? "primary"
                            : subscribeStatus === "error"
                              ? "danger"
                              : "muted"
                        }
                      >
                        {subscribeMessage}
                      </Text>
                    </div>
                  ) : null}
                </form>
              </div>
            </div>
          </section>
        </div>

        <MarketingGridSection className="flex-1">
          <div className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 pb-24 pt-24">
            <section id="latest" className="w-full">
              <div className="max-w-3xl">
                <Heading level={2} variant="section">
                  Latest posts
                </Heading>
                <Text variant="bodyLg" tone="muted" className="mt-2">
                  Shipping notes and progress updates from the Instafy team.
                </Text>
              </div>

              <div className="mt-10 grid gap-6 md:grid-cols-2">
                {sortedPosts.map((post) => (
                  <article
                    key={post.slug}
                    className="flex flex-col justify-between rounded-3xl border border-slate-200 bg-white/80 p-6 shadow-sm transition hover:border-indigo-200 hover:bg-white dark:border-slate-800 dark:bg-slate-950/70 dark:hover:border-indigo-500/40"
                  >
                    <div>
                      <Text variant="caption" tone="muted">
                        {formatNewsDate(post.publishedAt)}
                      </Text>
                      <Heading level={3} variant="title" className="mt-3">
                        {post.title}
                      </Heading>
                      <Text variant="body" tone="secondary" className="mt-3">
                        {post.excerpt}
                      </Text>
                    </div>

                    <div className="mt-8">
                      <Link
                        to={`/news/${post.slug}`}
                        className="text-sm font-semibold text-slate-700 underline decoration-slate-300 underline-offset-4 transition hover:text-slate-900 hover:decoration-slate-500 dark:text-slate-200 dark:decoration-slate-700 dark:hover:text-slate-50"
                      >
                        Read more →
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="mt-24 flex w-full flex-col items-center rounded-[32px] bg-white/80 px-8 py-12 text-center text-slate-900 dark:bg-slate-950/70 dark:text-white">
              <Heading level={2} variant="section" className="text-slate-900 dark:text-white">
                Want to try Instafy now?
              </Heading>
              <Text variant="bodyLg" tone="muted" className="mt-2 max-w-2xl">
                Install the extension, open Studio, and start shipping.
              </Text>
              <div className="mt-8 flex flex-row flex-wrap justify-center gap-4">
                <Link to="/install" className={theme.button.secondary}>
                  Install
                </Link>
                <Link to={buildDestination()} className={theme.button.primary}>
                  {user ? "Open Studio" : "Get started"}
                </Link>
              </div>
            </section>
          </div>

          <MarketingFooter />
        </MarketingGridSection>
      </main>
    </div>
  );
}
