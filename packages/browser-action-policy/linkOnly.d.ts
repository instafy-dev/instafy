/** Where a wrapper's address writes the site it serves. */
export type LinkOnlyEmbed = "subdomain" | "subdomain-dashes" | "path" | "query";

/** What a site's terms bar: AI agents and automated access, or only copying and republishing. */
export type LinkOnlyKind = "no-agents" | "no-reuse";

/** The formats a placeholder's values take. */
export type LinkOnlyPlaceholderFormat = "text" | "date" | "count";

export type LinkOnlyPattern = { readonly name: string; readonly anyEnding: boolean };

/** A search link template, checked: each placeholder a whole path segment or a whole query value. */
export type LinkOnlyTemplate = {
  readonly text: string;
  readonly origin: string;
  readonly segments: readonly (string | { readonly name: string })[];
  readonly query: readonly (readonly [string, string | { readonly name: string }])[];
  readonly names: readonly string[];
};

export type LinkOnlySite = {
  readonly name: string;
  readonly why: string;
  readonly kind: LinkOnlyKind;
  readonly patterns: readonly LinkOnlyPattern[];
  readonly home: string | null;
  readonly deepLinks: boolean;
  readonly search: LinkOnlyTemplate | null;
};

export type LinkOnlyWrapper = {
  readonly name: string;
  readonly why: string;
  readonly patterns: readonly LinkOnlyPattern[];
  readonly embeds: readonly LinkOnlyEmbed[];
};

export type LinkOnlyPlaceholder = { readonly format: LinkOnlyPlaceholderFormat; readonly about: string };

/** A compiled link-only list: the sites, the wrappers whose copies of them count as them, and the link placeholders. */
export type LinkOnlyList = {
  readonly sites: readonly LinkOnlySite[];
  readonly wrappers: readonly LinkOnlyWrapper[];
  readonly placeholders: Readonly<Record<string, LinkOnlyPlaceholder>>;
};

/** The site an address is on, the strictest of several; `via` names the wrappers it was found through, outermost first. */
export type LinkOnlyMatch = { site: string; why: string; kind: LinkOnlyKind; via: string[] };

/** Guided mode: the link the person opens in their own tab, and what to type there. */
export type LinkOnlyGuidedLink =
  | {
      ok: true;
      site: string;
      kind: LinkOnlyKind;
      deepLinks: boolean;
      link: string;
      home: string | null;
      typeIn: Array<{ name: string; about: string; value: string }>;
    }
  | { ok: false; error: string };

export declare const LINK_ONLY_SITES_SCHEMA: "instafy.link-only-sites@1";
export declare const EMBEDS: readonly LinkOnlyEmbed[];
export declare const KINDS: readonly LinkOnlyKind[];
export declare const PLACEHOLDER_FORMATS: readonly LinkOnlyPlaceholderFormat[];
export declare function compileLinkOnlyList(
  data: unknown,
  options?: { source?: string; placeholders?: Readonly<Record<string, LinkOnlyPlaceholder>> },
): { list: LinkOnlyList | null; warnings: string[] };
export declare function linkOnlyListFrom(
  bundled: unknown,
  additions?: ReadonlyArray<{ data: unknown; source: string }>,
): { list: LinkOnlyList | null; warnings: string[]; sources: string[] };
export declare function linkOnlyMatch(list: LinkOnlyList | null, address: string | URL): LinkOnlyMatch | null;
/** Whether a match keeps every agent out: any kind but "no-reuse". */
export declare function barsAgents(match: { kind?: string } | null | undefined): boolean;
/** The addresses a response's Memento `Link` header names as the original it copies (`rel="original"`). */
export declare function mementoOriginals(header: string | readonly string[] | undefined | null, base?: string | URL): string[];
/** The link-only site a response says it is a copy of, with the address it names. */
export declare function linkOnlyCopyOf(
  list: LinkOnlyList | null,
  linkHeader: string | readonly string[] | undefined | null,
  base?: string | URL,
): (LinkOnlyMatch & { original: string }) | null;
/** Fills a listed site's search link (or gives its home page and what to type) for the person to open themselves. */
export declare function guidedLink(
  list: LinkOnlyList | null,
  site: string,
  values?: Readonly<Record<string, string | number>>,
): LinkOnlyGuidedLink;
export declare function isWebAddress(address: string | URL): boolean;
