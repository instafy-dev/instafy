export type NewsPostBlock =
  | {
      type: "p";
      text: string;
    }
  | {
      type: "ul";
      items: string[];
    };

export type NewsPost = {
  slug: string;
  title: string;
  excerpt: string;
  publishedAt: string;
  blocks: NewsPostBlock[];
  tags?: string[];
};

export const newsPosts: NewsPost[] = [];

export function getNewsPostBySlug(slug: string): NewsPost | undefined {
  return newsPosts.find((post) => post.slug === slug);
}

export function formatNewsDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
