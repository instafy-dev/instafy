// Link-only sites: sites whose terms or robots.txt bar AI agents, which Octo
// links to and never reads or drives. The list is the instafy-web-research
// skill's own data (references/link-only-sites.json). The build bundles that
// same file, the one runtime-agent embeds, so there is one source; Desktop
// only enforces it, on every step the agent drives in the Personal Browser.
import bundledLinkOnlySites from "virtual:instafy/link-only-sites";

export const LINK_ONLY_SITES_SCHEMA = "instafy.link-only-sites@1";

/** The list as the build bundled it, before any validation. */
export const BUNDLED_LINK_ONLY_SITES: unknown = bundledLinkOnlySites;

export type PersonalBrowserLinkOnlyRefusal =
  | { code: "link_only_site"; site: string }
  | { code: "link_only_list_unavailable" };

export type PersonalBrowserLinkOnlyGuard = {
  /** False when the list is missing or malformed: every agent-driven web page is then refused. */
  readonly available: boolean;
  /** Why the agent may not read, open or act on this address, or null. Never refuses a non-web address. */
  refusal(url: string): PersonalBrowserLinkOnlyRefusal | null;
};

type LinkOnlySite = { name: string; exact: string[]; stems: string[] };

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const PATTERN = new RegExp(`^${LABEL}(?:\\.${LABEL})*(?:\\.\\*)?$`);
const SHORT_SUFFIX_LABEL = /^[a-z]{2,3}$/;
const MAX_SITES = 500;

// Lower case, no trailing dots: "Booking.com." names the same host.
function hostOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  let host = parsed.hostname.toLowerCase();
  while (host.endsWith(".")) host = host.slice(0, -1);
  return host || null;
}

// "example.*": the label followed by one or two public-suffix labels of two
// or three letters (example.de, www.example.co.uk), as the list's own `about`
// says and the Shared Browser's guard matches.
function stemMatches(host: string, stem: string): boolean {
  const labels = host.split(".");
  for (const suffixLength of [1, 2]) {
    if (labels.length <= suffixLength) continue;
    if (!labels.slice(-suffixLength).every((label) => SHORT_SUFFIX_LABEL.test(label))) continue;
    const rest = labels.slice(0, -suffixLength).join(".");
    if (rest === stem || rest.endsWith(`.${stem}`)) return true;
  }
  return false;
}

function sitesFrom(data: unknown): LinkOnlySite[] | null {
  const list = data as { schema?: unknown; sites?: unknown } | null;
  if (!list || typeof list !== "object" || list.schema !== LINK_ONLY_SITES_SCHEMA || !Array.isArray(list.sites)) {
    return null;
  }
  const sites: LinkOnlySite[] = [];
  for (const entry of list.sites.slice(0, MAX_SITES)) {
    const site = entry as { name?: unknown; match?: unknown; domains?: unknown } | null;
    const patterns = Array.isArray(site?.match) ? site.match : Array.isArray(site?.domains) ? site.domains : [];
    const exact: string[] = [];
    const stems: string[] = [];
    for (const raw of patterns) {
      if (typeof raw !== "string") continue;
      let pattern = raw.trim().toLowerCase();
      while (pattern.endsWith(".")) pattern = pattern.slice(0, -1);
      if (pattern.startsWith("*.")) pattern = pattern.slice(2);
      if (pattern.length > 253 || !PATTERN.test(pattern)) continue;
      if (pattern.endsWith(".*")) stems.push(pattern.slice(0, -2));
      else exact.push(pattern);
    }
    if (exact.length === 0 && stems.length === 0) continue;
    const name = typeof site?.name === "string" && site.name.trim() ? site.name.trim() : (exact[0] ?? `${stems[0]}.*`);
    sites.push({ name: name.slice(0, 80), exact, stems });
  }
  return sites.length > 0 ? sites : null;
}

/**
 * The guard for one copy of the list. A missing, malformed or empty list
 * fails closed: the guard then refuses every web address.
 */
export function createPersonalBrowserLinkOnlyGuard(data: unknown): PersonalBrowserLinkOnlyGuard {
  const sites = sitesFrom(data);
  return {
    available: sites !== null,
    refusal(url) {
      const host = hostOf(url);
      if (host === null) return null;
      if (sites === null) return { code: "link_only_list_unavailable" };
      for (const site of sites) {
        if (
          site.exact.some((pattern) => host === pattern || host.endsWith(`.${pattern}`)) ||
          site.stems.some((stem) => stemMatches(host, stem))
        ) {
          return { code: "link_only_site", site: site.name };
        }
      }
      return null;
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
  return `${refusal.site} is link-only: its terms bar AI agents or automated copying, so the agent never reads, opens or uses it. ${action} ` +
    "Give the person the plain link; they may open it themselves and use Send page to Octo.";
}
