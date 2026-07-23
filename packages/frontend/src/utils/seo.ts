export type PageMeta = {
  title: string;
  description: string;
  type?: "website" | "article";
  /**
   * Absolute URL preferred; relative paths will be resolved against window.location.origin.
   */
  image?: string;
  /**
   * Absolute URL preferred; relative paths will be resolved against window.location.origin.
   */
  url?: string;
};

function resolveUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  if (typeof window !== "undefined" && window.location?.origin) {
    return new URL(trimmed, window.location.origin).toString();
  }
  return trimmed;
}

function ensureMetaTag(attr: "name" | "property", key: string): HTMLMetaElement {
  const selector = `meta[${attr}="${key}"]`;
  let tag = document.head.querySelector<HTMLMetaElement>(selector);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute(attr, key);
    document.head.appendChild(tag);
  }
  return tag;
}

function ensureLink(rel: string): HTMLLinkElement {
  const selector = `link[rel="${rel}"]`;
  let tag = document.head.querySelector<HTMLLinkElement>(selector);
  if (!tag) {
    tag = document.createElement("link");
    tag.setAttribute("rel", rel);
    document.head.appendChild(tag);
  }
  return tag;
}

export function applyPageMeta(meta: PageMeta) {
  if (typeof document === "undefined") return;

  const title = meta.title.trim();
  const description = meta.description.trim();
  const type = meta.type ?? "website";
  const url = meta.url ? resolveUrl(meta.url) : typeof window !== "undefined" ? window.location.href : "";
  const image = meta.image ? resolveUrl(meta.image) : "";

  if (title) {
    document.title = title;
    ensureMetaTag("property", "og:title").setAttribute("content", title);
    ensureMetaTag("name", "twitter:title").setAttribute("content", title);
  }

  if (description) {
    ensureMetaTag("name", "description").setAttribute("content", description);
    ensureMetaTag("property", "og:description").setAttribute("content", description);
    ensureMetaTag("name", "twitter:description").setAttribute("content", description);
  }

  if (url) {
    ensureMetaTag("property", "og:url").setAttribute("content", url);
    ensureLink("canonical").setAttribute("href", url);
  }

  ensureMetaTag("property", "og:type").setAttribute("content", type);
  ensureMetaTag("name", "twitter:card").setAttribute("content", "summary_large_image");

  if (image) {
    ensureMetaTag("property", "og:image").setAttribute("content", image);
    ensureMetaTag("name", "twitter:image").setAttribute("content", image);
  }
}
