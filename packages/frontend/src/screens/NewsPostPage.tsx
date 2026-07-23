import { useEffect, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { Heading } from "../components/Heading";
import { MarketingFooter } from "../components/MarketingFooter";
import { MarketingGridSection } from "../components/MarketingGridSection";
import { MarketingHeader } from "../components/MarketingHeader";
import { Text } from "../components/Text";
import { useAuth } from "../providers/AuthProvider";
import { theme } from "../styles/theme";
import { applyPageMeta } from "../utils/seo";
import { formatNewsDate, getNewsPostBySlug } from "./news/newsPosts";

export function NewsPostPage() {
  const { slug } = useParams<{ slug: string }>();
  const post = useMemo(() => (slug ? getNewsPostBySlug(slug) : undefined), [slug]);

  const auth = useAuth();
  const user = auth.user;

  useEffect(() => {
    if (!post) return;
    applyPageMeta({
      title: `${post.title} · Instafy News`,
      description: post.excerpt,
      type: "article",
      image: "/og-image.png",
    });
  }, [post]);

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
        <div className="mx-auto w-full max-w-3xl px-6 pt-10">
          {!post ? (
            <div className="rounded-[36px] border border-slate-200 bg-white/90 p-10 shadow-card-lg dark:border-slate-800 dark:bg-slate-950/60 dark:shadow-modal">
              <Heading level={1} variant="hero">
                Post not found
              </Heading>
              <Text variant="bodyLg" tone="muted" className="mt-4">
                That link doesn’t match a published update yet.
              </Text>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link to="/news" className={theme.button.primary}>
                  Back to News
                </Link>
                <Link
                  to="/"
                  className={`${theme.button.secondary} dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:text-slate-50`}
                >
                  Home
                </Link>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4 text-left">
              <Text variant="caption" tone="muted">
                {formatNewsDate(post.publishedAt)}
              </Text>

              <Heading level={1} variant="hero" className="mt-2">
                {post.title}
              </Heading>
              <Text variant="lead" tone="secondary" className="mt-2">
                {post.excerpt}
              </Text>
            </div>
          )}
        </div>

        <MarketingGridSection className="flex-1">
          <div className="mx-auto w-full max-w-3xl px-6 pb-24 pt-16">
            {post ? (
              <>
                <article className="space-y-6">
                  {post.blocks.map((block, index) => {
                    if (block.type === "ul") {
                      return (
                        <ul key={index} className="space-y-2 pl-6 text-slate-700 dark:text-slate-200">
                          {block.items.map((item) => (
                            <li key={item} className="list-disc">
                              <Text variant="body" tone="secondary" className="text-slate-700 dark:text-slate-200">
                                {item}
                              </Text>
                            </li>
                          ))}
                        </ul>
                      );
                    }
                    return (
                      <Text key={index} variant="bodyLg" tone="secondary">
                        {block.text}
                      </Text>
                    );
                  })}
                </article>

                <div className="mt-16 flex flex-col gap-3 rounded-[32px] bg-white/80 px-8 py-10 text-center text-slate-900 shadow-sm dark:bg-slate-950/70 dark:text-white">
                  <Heading level={2} variant="section" className="text-slate-900 dark:text-white">
                    Get the next update in your inbox
                  </Heading>
                  <Text variant="bodyLg" tone="muted" className="mt-2">
                    Subscribe on the news page and we’ll email you when something ships.
                  </Text>
                  <div className="mt-6 flex flex-row flex-wrap justify-center gap-3">
                    <Link to="/news#subscribe" className={theme.button.primary}>
                      Subscribe
                    </Link>
                    <Link
                      to="/install"
                      className={`${theme.button.secondary} dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:text-slate-50`}
                    >
                      Install
                    </Link>
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <MarketingFooter />
        </MarketingGridSection>
      </main>
    </div>
  );
}
