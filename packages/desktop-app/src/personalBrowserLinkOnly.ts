// Link-only sites: sites whose terms or robots.txt bar AI agents, which Octo
// links to and never reads or drives. The list is the instafy-web-research
// skill's own data (references/link-only-sites.json). The build bundles that
// same file, the one runtime-agent embeds, so there is one source; Desktop
// only enforces it, on every step the agent drives in the Personal Browser.
//
// Matching is @instafy/browser-action-policy's linkOnly.js, the same code the
// Shared Browser and `instafy web read` run: a site's own hosts however the
// address spells them, and a translator's, cache's or archive's copy of it
// (the list's wrappers).
//
// Desktop enforces the bundled list. A space may add sites to its own copy of
// the list, which the readers running in the space (`instafy web read`, the
// Shared Browser) enforce as well; Desktop has no channel that carries a
// space's files with a Personal Browser turn, so it does not read that copy.
import { isWebAddress, linkOnlyCopyOf, linkOnlyListFrom, linkOnlyMatch } from "@instafy/browser-action-policy/linkOnly";
import bundledLinkOnlySites from "virtual:instafy/link-only-sites";

export const LINK_ONLY_SITES_SCHEMA = "instafy.link-only-sites@1";

/** The list as the build bundled it, before any validation. */
export const BUNDLED_LINK_ONLY_SITES: unknown = bundledLinkOnlySites;

export type PersonalBrowserLinkOnlyRefusal =
  | { code: "link_only_site"; site: string; via?: string[]; copy?: true }
  | { code: "link_only_list_unavailable" };

export type PersonalBrowserLinkOnlyGuard = {
  /** False when the list is missing or malformed: every agent-driven web page is then refused. */
  readonly available: boolean;
  /** Why the agent may not read, open or act on this address, or null. Never refuses a non-web address. */
  refusal(url: string): PersonalBrowserLinkOnlyRefusal | null;
  /**
   * Why the agent may not read a page whose answer says it is a copy of a
   * link-only site (an archive's Memento `Link: <…>; rel="original"`), or null.
   * `headers` are the answer's headers, any case.
   */
  copyRefusal(headers: Record<string, string | string[]> | undefined, url: string): PersonalBrowserLinkOnlyRefusal | null;
};

/**
 * The guard for one copy of the list. A missing, malformed or empty list
 * fails closed: the guard then refuses every web address.
 */
export function createPersonalBrowserLinkOnlyGuard(data: unknown): PersonalBrowserLinkOnlyGuard {
  const { list } = linkOnlyListFrom(data);
  return {
    available: list !== null,
    refusal(url) {
      if (!isWebAddress(url)) return null;
      if (list === null) return { code: "link_only_list_unavailable" };
      const hit = linkOnlyMatch(list, url);
      if (!hit) return null;
      return hit.via.length ? { code: "link_only_site", site: hit.site, via: hit.via } : { code: "link_only_site", site: hit.site };
    },
    copyRefusal(headers, url) {
      if (!isWebAddress(url)) return null;
      if (list === null) return { code: "link_only_list_unavailable" };
      const link = Object.entries(headers ?? {})
        .filter(([name]) => name.toLowerCase() === "link")
        .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));
      const hit = link.length ? linkOnlyCopyOf(list, link, url) : null;
      if (!hit) return null;
      return { code: "link_only_site", site: hit.site, ...(hit.via.length ? { via: hit.via } : {}), copy: true };
    },
  };
}

/** The guard over the bundled list. */
export const PERSONAL_BROWSER_LINK_ONLY_GUARD = createPersonalBrowserLinkOnlyGuard(BUNDLED_LINK_ONLY_SITES);

/** What the agent is told when a step meets a link-only site, or a missing list. */
export function personalBrowserLinkOnlyMessage(refusal: PersonalBrowserLinkOnlyRefusal, action: string): string {
  if (refusal.code === "link_only_list_unavailable") {
    return `The link-only site list is unavailable in this Desktop build, so the agent reads and opens no web page. ${action}`;
  }
  const copy = refusal.copy
    ? " This page says it is a copy of it."
    : refusal.via?.length ? ` This address is its copy on ${refusal.via.join(", then ")}.` : "";
  return `${refusal.site} is link-only: its terms bar AI agents or automated copying, so the agent never reads, opens or uses it.${copy} ${action} ` +
    "Give the person the plain link; they may open it themselves and use Send page to Octo.";
}
