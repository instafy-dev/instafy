import type { ChatMessage } from "../types";

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
};

export type BrowserSessionPageTarget = Pick<BrowserSessionPage, "id" | "url" | "host" | "label">;

type BrowserSessionPageDraft = {
  id: string;
  url: string;
  host: string;
  label: string;
  title: string | null;
  lastReferencedAt: number;
};

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/gi;
const HOST_LIKE_PATTERN =
  /\b(?:www\.)?[a-z0-9-]+\.(?:com|org|net|io|ai|dev|app|co|at|de|uk|news|tv|me|gg|fm|info|biz|edu|gov)(?::\d+)?(?:\/[^\s<>"'`]*)?\b/i;
const BROWSER_CONTEXT_PATTERN =
  /\b(browser|shared browser|tab|tabs|page|pages|route|title|visit|visited|open|opened|switch|switched|current)\b/i;
const ACTIVE_PAGE_PATTERN =
  /\b(current\s+(tab|page|route)|switched(?:\s+back)?\s+to|visited|opened|focused|using)\b/i;
const TITLE_PATTERNS = [
  /page title(?:\s+is)?\s+[“"]([^"”]+)[”"]/i,
  /title(?:\s+is)?\s+[“"]([^"”]+)[”"]/i,
  /current tab(?:\s+is)?\s+[“"]([^"”]+)[”"]/i,
  /current page(?:\s+is)?\s+[“"]([^"”]+)[”"]/i,
] as const;
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

function normalizeMessageType(message: ChatMessage): string {
  const direct = typeof message.messageType === "string" ? message.messageType.trim().toLowerCase() : "";
  if (direct) {
    return direct;
  }
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") {
    return "";
  }
  const directMetadata = typeof metadata.messageType === "string" ? metadata.messageType.trim().toLowerCase() : "";
  if (directMetadata) {
    return directMetadata;
  }
  return typeof metadata.message_type === "string" ? metadata.message_type.trim().toLowerCase() : "";
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

function extractQuotedTitle(content: string): string | null {
  for (const pattern of TITLE_PATTERNS) {
    const match = content.match(pattern);
    const candidate = match?.[1]?.trim() ?? "";
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function normalizeHost(parsed: URL): string {
  return parsed.hostname.replace(/^www\./i, "").toLowerCase();
}

function normalizeDomainFamily(host: string): string {
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) {
    return host;
  }
  return parts.slice(-2).join(".");
}

function normalizeTitleLabel(title: string | null): string | null {
  const value = title?.trim().replace(/\s+/g, " ").replace(/[.]+$/g, "") ?? "";
  if (!value) {
    return null;
  }
  const splitBy = (separator: string): string | null => {
    if (!value.includes(separator)) {
      return null;
    }
    const candidate = value.split(separator)[0]?.trim() ?? "";
    if (candidate.length < 3 || candidate.length > 48) {
      return null;
    }
    return candidate;
  };
  for (const separator of [" | ", " — ", " – ", " - ", " · "]) {
    const candidate = splitBy(separator);
    if (candidate) {
      return candidate;
    }
  }
  const commaCandidate = value.split(",")[0]?.trim() ?? "";
  if (commaCandidate.length >= 3 && commaCandidate.length <= 40) {
    return commaCandidate;
  }
  return value;
}

function deriveLabel(host: string, title: string | null): string {
  return normalizeTitleLabel(title) ?? host;
}

function rebuildPageDraft(page: BrowserSessionPageDraft, titleOverride?: string | null): BrowserSessionPageDraft {
  const nextTitle = titleOverride === undefined ? page.title : titleOverride;
  return {
    ...page,
    title: nextTitle,
    label: deriveLabel(page.host, nextTitle),
  };
}

function upsertPage(
  pages: Map<string, BrowserSessionPageDraft>,
  url: string,
  timestamp: number,
  title?: string | null,
): BrowserSessionPageDraft | null {
  try {
    const parsed = new URL(url);
    const host = normalizeHost(parsed);
    const id = parsed.toString();
    const existing = pages.get(id);
    if (existing) {
      const mergedTitle = title && title.trim().length > 0 ? title.trim() : existing.title;
      const next = rebuildPageDraft(
        {
          ...existing,
          lastReferencedAt: Math.max(existing.lastReferencedAt, timestamp),
        },
        mergedTitle,
      );
      pages.set(id, next);
      return next;
    }
    const trimmedTitle = title?.trim() ?? null;
    const next: BrowserSessionPageDraft = {
      id,
      url: parsed.toString(),
      host,
      title: trimmedTitle,
      label: deriveLabel(host, trimmedTitle),
      lastReferencedAt: timestamp,
    };
    pages.set(id, next);
    return next;
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildAliases(page: BrowserSessionPageDraft): string[] {
  const aliases = new Set<string>();
  const add = (value: string | null | undefined) => {
    const normalized = (value ?? "").trim().toLowerCase();
    if (normalized.length < 3) {
      return;
    }
    aliases.add(normalized);
  };
  add(page.label);
  add(page.title);
  add(page.host);
  const hostRoot = page.host.split(".")[0] ?? "";
  add(hostRoot);
  return Array.from(aliases);
}

function findReferencedPageId(contentLower: string, pages: Map<string, BrowserSessionPageDraft>): string | null {
  const matchedPageIds = new Set<string>();
  for (const page of pages.values()) {
    const aliases = buildAliases(page);
    if (
      aliases.some((alias) =>
        new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias)}([^a-z0-9]|$)`, "i").test(contentLower),
      )
    ) {
      matchedPageIds.add(page.id);
    }
  }
  return matchedPageIds.size === 1 ? Array.from(matchedPageIds)[0] ?? null : null;
}

function isRootLikeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" && !parsed.search;
  } catch {
    return false;
  }
}

function collapseRedirectLikePages(
  pages: Map<string, BrowserSessionPageDraft>,
  activePageId: string | null,
): { pages: BrowserSessionPageDraft[]; activePageId: string | null } {
  const pageList = Array.from(pages.values()).sort(
    (left, right) => right.lastReferencedAt - left.lastReferencedAt,
  );
  const removedIds = new Set<string>();
  const redirectedToPageId = new Map<string, string>();

  for (const weakerPage of pageList) {
    if (removedIds.has(weakerPage.id) || weakerPage.title) {
      continue;
    }
    const weakerFamily = normalizeDomainFamily(weakerPage.host);
    const replacement = pageList.find((candidate) => {
      if (candidate.id === weakerPage.id || removedIds.has(candidate.id) || !candidate.title) {
        return false;
      }
      if (normalizeDomainFamily(candidate.host) !== weakerFamily) {
        return false;
      }
      return isRootLikeUrl(weakerPage.url) && candidate.lastReferencedAt >= weakerPage.lastReferencedAt;
    });
    if (!replacement) {
      continue;
    }
    removedIds.add(weakerPage.id);
    redirectedToPageId.set(weakerPage.id, replacement.id);
  }

  const nextActivePageId =
    activePageId && redirectedToPageId.has(activePageId)
      ? redirectedToPageId.get(activePageId) ?? activePageId
      : activePageId;

  return {
    pages: pageList.filter((page) => !removedIds.has(page.id)),
    activePageId: nextActivePageId,
  };
}

export function resolveBrowserSessionPages(messages: ChatMessage[]): BrowserSessionPage[] {
  const pages = new Map<string, BrowserSessionPageDraft>();
  let activePageId: string | null = null;

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const content = typeof message.content === "string" ? message.content.trim() : "";
    const messageType = normalizeMessageType(message);
    const urls = extractUrls(content);
    const browserRelated = BROWSER_CONTEXT_PATTERN.test(content) || messageType === "command_execution";

    if (!browserRelated) {
      continue;
    }

    const title = extractQuotedTitle(content);
    const touchedPageIds: string[] = [];
    for (const url of urls) {
      const page = upsertPage(pages, url, message.timestamp, urls.length === 1 ? title : null);
      if (page) {
        touchedPageIds.push(page.id);
      }
    }

    const lowered = content.toLowerCase();
    const referencedKnownPageId =
      touchedPageIds.length === 0 ? findReferencedPageId(lowered, pages) : null;

    if (title && referencedKnownPageId) {
      const existing = pages.get(referencedKnownPageId);
      if (existing) {
        pages.set(referencedKnownPageId, rebuildPageDraft(existing, title));
      }
    } else if (title && !referencedKnownPageId && !touchedPageIds.length && activePageId) {
      const existing = pages.get(activePageId);
      if (existing) {
        pages.set(activePageId, rebuildPageDraft(existing, title));
      }
    }

    if (touchedPageIds.length === 1 && ACTIVE_PAGE_PATTERN.test(lowered)) {
      activePageId = touchedPageIds[0] ?? activePageId;
      continue;
    }

    if (!touchedPageIds.length && referencedKnownPageId && ACTIVE_PAGE_PATTERN.test(lowered)) {
      const existing = pages.get(referencedKnownPageId);
      if (existing) {
        pages.set(referencedKnownPageId, {
          ...existing,
          lastReferencedAt: Math.max(existing.lastReferencedAt, message.timestamp),
        });
      }
      activePageId = referencedKnownPageId;
    }
  }

  const collapsedPages = collapseRedirectLikePages(pages, activePageId);
  activePageId = collapsedPages.activePageId;

  return collapsedPages.pages
    .sort((left, right) => {
      const activeRank = Number(right.id === activePageId) - Number(left.id === activePageId);
      if (activeRank !== 0) {
        return activeRank;
      }
      if (right.lastReferencedAt !== left.lastReferencedAt) {
        return right.lastReferencedAt - left.lastReferencedAt;
      }
      return left.label.localeCompare(right.label);
    })
    .map((page) => ({
      ...page,
      isActive: page.id === activePageId,
    }));
}

export function toBrowserSessionPageTarget(page: BrowserSessionPage): BrowserSessionPageTarget {
  return {
    id: page.id,
    url: page.url,
    host: page.host,
    label: page.label,
  };
}

export function resolvePreferredBrowserSessionPage(
  pages: BrowserSessionPage[],
  preferredPageId?: string | null,
): BrowserSessionPage | null {
  const normalizedPreferredId = preferredPageId?.trim() ?? "";
  if (normalizedPreferredId) {
    const preferred = pages.find((page) => page.id === normalizedPreferredId) ?? null;
    if (preferred) {
      return preferred;
    }
  }
  return (
    pages.find((page) => page.isActive) ??
    pages[0] ??
    null
  );
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

export function buildBrowserSessionTargetedMessage(
  message: string,
  target: BrowserSessionPageTarget,
): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return trimmed;
  }
  return [
    `Use the existing "${target.label}" page in the current shared browser session for this request.`,
    `That page is ${target.url}. Treat it as a page/tab inside the current browser session, not as a new isolated session or a new runtime-backed browser session unless I explicitly ask for that.`,
    `Keep any other open browser pages available unless I explicitly ask you to close or replace them.`,
    "",
    trimmed,
  ].join("\n");
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
