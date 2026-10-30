import type { BrowserTabOpener } from "../../../sdk/instafy";

export type BrowserSessionPage = {
  id: string;
  url: string;
  host: string;
  label: string;
  title: string | null;
  lastReferencedAt: number;
  isActive: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  /** Who opened the tab, when the browser says so; absent is the person's. */
  openedBy?: BrowserTabOpener;
  /** One of Octo's tabs a person kept open past the end of the turn. */
  kept?: boolean;
  /** The number one of Octo's tabs keeps while it is open ("Octo's tab 2"). */
  agentTabNumber?: number;
  /** One of Octo's tabs that an earlier run left open ("Octo's earlier tab"). */
  leftover?: boolean;
  /** The run that left this ordinary tab open as its chat's page. */
  leftByRun?: string;
};

export type BrowserSessionPageTarget = Pick<BrowserSessionPage, "id" | "url" | "host" | "label">;

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/gi;
const HOST_LIKE_PATTERN =
  /\b(?:www\.)?[a-z0-9-]+\.(?:com|org|net|io|ai|dev|app|co|at|de|uk|news|tv|me|gg|fm|info|biz|edu|gov)(?::\d+)?(?:\/[^\s<>"'`]*)?\b/i;
const BROWSER_CONTINUATION_PATTERN =
  /\b(browser|site|page|tab|tabs|window|article|headline|story|route|url|link|cookie|banner|popup|dialog|modal|form|field|button|search|results)\b/i;
const BROWSER_INTERACTION_PATTERN =
  /\b(go to|open|visit|navigate|click|tap|scroll|search|type|fill|submit|select|choose|check|read|summarize|continue|keep going|go on|switch|back|forward|reload|refresh)\b/i;
const DEICTIC_CONTINUATION_PATTERN =
  /\b(this|that|there|here|current|same|it)\b/i;

export function browserSessionPageIsPlaceholder(page: Pick<BrowserSessionPage, "url">): boolean {
  const normalizedUrl = page.url.trim().toLowerCase();
  return (
    normalizedUrl.length === 0 ||
    normalizedUrl === "about:blank" ||
    normalizedUrl === "chrome://newtab/" ||
    normalizedUrl === "chrome://new-tab-page/" ||
    normalizedUrl === "edge://newtab/"
  );
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[),.;!?]+$/g, "");
}

function normalizeUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(trimTrailingPunctuation(rawUrl));
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractUrls(content: string): string[] {
  const matches = content.match(URL_PATTERN) ?? [];
  const normalized = matches
    .map((value) => normalizeUrl(value))
    .filter((value): value is string => Boolean(value));
  return Array.from(new Set(normalized));
}

export function toBrowserSessionPageTarget(page: BrowserSessionPage): BrowserSessionPageTarget {
  return {
    id: page.id,
    url: page.url,
    host: page.host,
    label: page.label,
  };
}

export function shouldAutoTargetBrowserSessionMessage(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("/")) {
    return false;
  }
  if (extractUrls(trimmed).length > 0 || HOST_LIKE_PATTERN.test(trimmed)) {
    return true;
  }
  if (BROWSER_CONTINUATION_PATTERN.test(trimmed)) {
    return true;
  }
  return (
    BROWSER_INTERACTION_PATTERN.test(trimmed) &&
    DEICTIC_CONTINUATION_PATTERN.test(trimmed)
  );
}

export function buildNewBrowserSessionMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return trimmed;
  }
  return [
    "Open this request in a fresh browser page/context while keeping any existing browser pages available.",
    "Reuse the current browser-capable runtime when possible. Prefer another page in the shared browser session unless I explicitly ask for isolation or separate login state.",
    "",
    trimmed,
  ].join("\n");
}
