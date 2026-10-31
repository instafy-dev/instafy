import { browserSessionPageIsPlaceholder, type BrowserSessionPage } from "./browserSessionPages";

/** The name on an agent's tab when the run does not name its agent. */
export const BROWSER_AGENT_DEFAULT_NAME = "Octo";

/** The longest page title the Reading row shows; the full title is in its tooltip. */
const READING_TITLE_MAX_CHARS = 80;

export type BrowserAgentTabsInput = {
  pages: readonly BrowserSessionPage[];
  /**
   * The agent holds the browser right now (the origin's agent owner on
   * Shared, resumed control while a turn runs on Personal). False after
   * Pause, Escape or take-over: then every tab is the person's again.
   */
  agentControlActive: boolean;
  /** Tabs an agent run is bound to (the page its turn was sent for). */
  agentPageIds?: readonly string[];
};

/**
 * The tabs the agent holds now: the tabs it opened and the tab its run is
 * bound to. Empty while the agent has no control, so a badge never outlives
 * the control it stands for. A tab an earlier run left open is not one of
 * them: no run holds it any more.
 */
export function resolveAgentTabIds({ pages, agentControlActive, agentPageIds = [] }: BrowserAgentTabsInput): ReadonlySet<string> {
  if (!agentControlActive) return new Set();
  const bound = new Set(agentPageIds.map((id) => id.trim()).filter(Boolean));
  return new Set(pages
    .filter((page) => (page.openedBy === "agent" && !page.leftover) || bound.has(page.id))
    .map((page) => page.id));
}

/**
 * The label of a tab the agent opened in the Shared Browser, the one its
 * approval prompts and Octo's list_tabs use: "Octo's tab 2". It keeps its
 * number while it is open. A tab an earlier run left open has no number, so
 * it never shares a label with one of the running turn's tabs.
 */
export function sharedBrowserAgentTabLabel(page: Pick<BrowserSessionPage, "agentTabNumber" | "leftover">): string {
  if (page.leftover) return `${BROWSER_AGENT_DEFAULT_NAME}'s earlier tab`;
  return page.agentTabNumber ? `${BROWSER_AGENT_DEFAULT_NAME}'s tab ${page.agentTabNumber}` : `${BROWSER_AGENT_DEFAULT_NAME}'s tab`;
}

/** The agent's tabs that show a web page, in tab order: what the Reading row lists. */
export function resolveAgentReadingPages(input: BrowserAgentTabsInput): BrowserSessionPage[] {
  const agentTabIds = resolveAgentTabIds(input);
  return input.pages.filter((page) => agentTabIds.has(page.id) && !browserSessionPageIsPlaceholder(page));
}

/** The host a reader recognises: no scheme, no `www.`, the page's own host when it has one. */
export function browserReadingHost(page: Pick<BrowserSessionPage, "host" | "url">): string {
  const host = page.host.trim();
  if (host) return host.replace(/^www\./i, "");
  try {
    return new URL(page.url).hostname.replace(/^www\./i, "") || page.url;
  } catch {
    return page.url;
  }
}

// A title that is only a media type ("image/svg+xml"), as an image or svg
// shown on its own can leave: it names nothing. Software writes the type in
// lower case; "Audio/Video" is a title.
const MEDIA_TYPE_TITLE = /^(?:image|video|audio|application|text|font|model|multipart)\/[A-Za-z0-9][A-Za-z0-9.+-]*(?:\s*;.*)?$/;

/**
 * A page's title as a tab shows it, or null when it has none: a title that
 * is only a media type names nothing, so the tab is named by its site. Nor
 * does a blank tab's address: while a tab that was blank loads its first
 * page, the browser reports the new address with the blank tab's title,
 * "about:blank", until the page arrives.
 */
export function shownBrowserPageTitle(title: string | null | undefined): string | null {
  const value = title?.replace(/\s+/g, " ").trim() ?? "";
  return value && !MEDIA_TYPE_TITLE.test(value) && !browserSessionPageIsPlaceholder({ url: value }) ? value : null;
}

/**
 * The page's own title, shortened for one line. Page titles are page data:
 * they are only ever shown as text, never followed.
 */
export function browserReadingTitle(page: Pick<BrowserSessionPage, "title">): string | null {
  const title = shownBrowserPageTitle(page.title) ?? "";
  if (!title) return null;
  return title.length > READING_TITLE_MAX_CHARS ? `${title.slice(0, READING_TITLE_MAX_CHARS - 1).trimEnd()}…` : title;
}

type PersonalBrowserTabsStatus = Pick<InstafyDesktopPersonalBrowserStatus, "url" | "title" | "tabs">;

/** The id of the one page of a Personal Browser host that does not list its tabs. */
export const PERSONAL_BROWSER_SINGLE_PAGE_ID = "personal-page";

function pageHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The Personal Browser's tabs as pages. A host with one page reports no
 * `tabs`; its page is the status's own url and title.
 */
export function personalBrowserTabPages(status: PersonalBrowserTabsStatus | null | undefined): BrowserSessionPage[] {
  if (!status) return [];
  const tabs: InstafyDesktopPersonalBrowserTab[] = Array.isArray(status.tabs) && status.tabs.length > 0
    ? status.tabs
    : status.url ? [{ id: PERSONAL_BROWSER_SINGLE_PAGE_ID, url: status.url, title: status.title, active: true }] : [];
  return tabs.flatMap((tab, index) => {
    const id = typeof tab.id === "string" ? tab.id.trim() : "";
    const url = typeof tab.url === "string" ? tab.url.trim() : "";
    if (!id || !url) return [];
    const host = pageHost(url);
    const title = typeof tab.title === "string" && tab.title.trim() ? tab.title.trim() : null;
    const openedBy = tab.openedBy === "agent" ? "agent" as const : undefined;
    return [{
      id,
      url,
      host,
      label: title ?? (host || url),
      title,
      lastReferencedAt: tabs.length - index,
      isActive: tab.active === true,
      ...(openedBy ? { openedBy } : {}),
    }];
  });
}
