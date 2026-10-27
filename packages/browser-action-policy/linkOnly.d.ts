/** Where a wrapper's address writes the site it serves. */
export type LinkOnlyEmbed = "subdomain" | "subdomain-dashes" | "path" | "query";

export type LinkOnlyPattern = { readonly name: string; readonly anyEnding: boolean };

export type LinkOnlySite = { readonly name: string; readonly why: string; readonly patterns: readonly LinkOnlyPattern[] };

export type LinkOnlyWrapper = {
  readonly name: string;
  readonly why: string;
  readonly patterns: readonly LinkOnlyPattern[];
  readonly embeds: readonly LinkOnlyEmbed[];
};

/** A compiled link-only list: the sites, and the wrappers whose copies of them count as them. */
export type LinkOnlyList = { readonly sites: readonly LinkOnlySite[]; readonly wrappers: readonly LinkOnlyWrapper[] };

/** The site an address is on; `via` names the wrappers it was found through, outermost first. */
export type LinkOnlyMatch = { site: string; why: string; via: string[] };

export declare const LINK_ONLY_SITES_SCHEMA: "instafy.link-only-sites@1";
export declare const EMBEDS: readonly LinkOnlyEmbed[];
export declare function compileLinkOnlyList(
  data: unknown,
  options?: { source?: string },
): { list: LinkOnlyList | null; warnings: string[] };
export declare function linkOnlyListFrom(
  bundled: unknown,
  additions?: ReadonlyArray<{ data: unknown; source: string }>,
): { list: LinkOnlyList | null; warnings: string[]; sources: string[] };
export declare function linkOnlyMatch(list: LinkOnlyList | null, address: string | URL): LinkOnlyMatch | null;
/** The addresses a response's Memento `Link` header names as the original it copies (`rel="original"`). */
export declare function mementoOriginals(header: string | readonly string[] | undefined | null, base?: string | URL): string[];
/** The link-only site a response says it is a copy of, with the address it names. */
export declare function linkOnlyCopyOf(
  list: LinkOnlyList | null,
  linkHeader: string | readonly string[] | undefined | null,
  base?: string | URL,
): (LinkOnlyMatch & { original: string }) | null;
export declare function isWebAddress(address: string | URL): boolean;
