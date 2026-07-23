import { expect, type Page } from "@playwright/test";
import { fetchRunMetricsForAttemptWithRetry, tryWaitForConversationControllerId, type TokenUsage } from "./benchLearnUtils.js";

export function parseTitleFromAssistantText(text: string): string | null {
  const normalized = (text ?? "").trim();
  if (!normalized) return null;
  for (const line of normalized.split(/\r?\n/)) {
    const match = line.match(/\bTITLE\s*[:=]\s*(.+?)\s*$/i);
    if (match) return match[1].trim();
  }
  const inlineMatch = normalized.match(/\bTITLE\s*[:=]\s*([^\n]+)/i);
  if (inlineMatch) return inlineMatch[1].trim();
  return null;
}

export type TitleFailureKind =
  | "timeout_no_assistant"
  | "browser_not_visible"
  | "missing_title_line"
  | "wrong_title"
  | "unknown";

function classifyTitleFailure(options: {
  assistantTurns: number;
  browserVisible: boolean;
  title: string | null;
  assistantSummary: string;
  expectedTitle: string;
  budgetSec: number;
}): { failureKind: TitleFailureKind; failureDetails: string } {
  if (options.assistantTurns === 0) {
    return {
      failureKind: "timeout_no_assistant",
      failureDetails: `No assistant reply observed within ${options.budgetSec}s.`,
    };
  }
  if (!options.browserVisible) {
    return {
      failureKind: "browser_not_visible",
      failureDetails: "Browser session modal never became visible during the attempt.",
    };
  }
  if (!options.title) {
    const lowered = options.assistantSummary.toLowerCase();
    const expectedLowered = options.expectedTitle.toLowerCase();
    const mentioned = lowered.includes(expectedLowered);
    return {
      failureKind: "missing_title_line",
      failureDetails: mentioned
        ? `Assistant mentioned "${options.expectedTitle}" but did not include a parsable "TITLE: ..." line.`
        : 'No parsable "TITLE: ..." line found in assistant reply.',
    };
  }
  if (options.title.trim().toLowerCase() !== options.expectedTitle.trim().toLowerCase()) {
    return {
      failureKind: "wrong_title",
      failureDetails: `Expected "${options.expectedTitle}", got "${options.title}".`,
    };
  }
  return {
    failureKind: "unknown",
    failureDetails: "Attempt failed for an unknown reason.",
  };
}

export type TitleAttemptResult = {
  attempt: number;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  budgetSec: number;
  title: string | null;
  success: boolean;
  failureKind: TitleFailureKind | null;
  failureDetails: string | null;
  browserVisible: boolean;
  assistantTurns: number;
  assistantSummary: string;
  conversationControllerId: string | null;
  runId: string | null;
  tokenUsage: TokenUsage | null;
  mcpToolCalls: number;
  shellCommands: number;
  shellCommandSummaries: string[];
  learnedBlockReads: string[];
};

export async function runTitleAttempt(
  page: Page,
  attempt: number,
  prompt: string,
  budgetSec: number,
): Promise<TitleAttemptResult> {
  const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
  const baselineAssistantCount = await assistantBubbles.count();

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  await page.getByTestId("chat-input").fill(prompt);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled();
  await page.getByTestId("chat-send-button").click();

  const deadline = startedAtMs + budgetSec * 1000;
  const browserModal = page.getByTestId("browser-session-modal");
  let browserVisible = false;
  let assistantSummary = "";
  let lastSeenText = "";
  let title: string | null = null;

  while (Date.now() < deadline) {
    if (!browserVisible) {
      browserVisible = await browserModal.isVisible().catch(() => false);
    }

    const count = await assistantBubbles.count();
    if (count > baselineAssistantCount) {
      const currentText = (await assistantBubbles.last().innerText().catch(() => "")).trim();
      if (currentText && currentText !== lastSeenText) {
        lastSeenText = currentText;
        assistantSummary = currentText;
        title = parseTitleFromAssistantText(currentText) ?? title;
        if (title) {
          break;
        }
      }
    }

    await page.waitForTimeout(1_000);
  }

  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();
  const assistantTurns = Math.max(0, (await assistantBubbles.count()) - baselineAssistantCount);

  const normalizedTitle = title ? title.trim() : null;
  const expectedTitle = "Example Domain";
  const success = normalizedTitle?.toLowerCase() === expectedTitle.toLowerCase();
  const failure = success
    ? { failureKind: null, failureDetails: null }
    : classifyTitleFailure({
        assistantTurns,
        browserVisible,
        title,
        assistantSummary,
        expectedTitle,
        budgetSec,
      });

  const assistantMatch = (content: string) => {
    const parsed = parseTitleFromAssistantText(content);
    if (!parsed) return false;
    return parsed.toLowerCase().includes("example");
  };
  const conversationControllerId = await tryWaitForConversationControllerId(page, 20_000);
  const metrics =
    conversationControllerId
      ? await fetchRunMetricsForAttemptWithRetry(page, conversationControllerId, assistantMatch).catch(() => ({
          runId: null,
          tokenUsage: null,
          mcpToolCalls: 0,
          shellCommands: 0,
          shellCommandSummaries: [],
          learnRouterBlocks: [],
          learnedBlockReads: [],
          learnedBlockReadCommands: [],
        }))
      : {
          runId: null,
          tokenUsage: null,
          mcpToolCalls: 0,
          shellCommands: 0,
          shellCommandSummaries: [],
          learnRouterBlocks: [],
          learnedBlockReads: [],
          learnedBlockReadCommands: [],
        };

  return {
    attempt,
    startedAt,
    endedAt,
    wallMs: endedAtMs - startedAtMs,
    budgetSec,
    title,
    success,
    failureKind: failure.failureKind,
    failureDetails: failure.failureDetails,
    browserVisible,
    assistantTurns,
    assistantSummary,
    conversationControllerId,
    runId: metrics.runId,
    tokenUsage: metrics.tokenUsage,
    mcpToolCalls: metrics.mcpToolCalls,
    shellCommands: metrics.shellCommands,
    shellCommandSummaries: metrics.shellCommandSummaries ?? [],
    learnedBlockReads: metrics.learnedBlockReads ?? [],
  };
}

export function parseArticleFields(text: string): { title: string | null; url: string | null } {
  const normalized = (text ?? "").trim();
  if (!normalized) return { title: null, url: null };

  let title: string | null = null;
  let url: string | null = null;

  for (const line of normalized.split(/\r?\n/)) {
    const titleMatch = line.match(/^\s*ARTICLE_TITLE\s*[:=]\s*(.+?)\s*$/i);
    if (titleMatch && !title) {
      title = titleMatch[1].trim();
    }
    const urlMatch = line.match(/^\s*ARTICLE_URL\s*[:=]\s*(.+?)\s*$/i);
    if (urlMatch && !url) {
      url = urlMatch[1].trim();
    }
  }

  if (!title) {
    const match = normalized.match(/\bARTICLE_TITLE\s*[:=]\s*(.+?)(?=\s+ARTICLE_URL\s*[:=]|$)/i);
    if (match) title = match[1].trim();
  }
  if (!url) {
    const match = normalized.match(/\bARTICLE_URL\s*[:=]\s*(.+?)\s*$/i);
    if (match) url = match[1].trim();
  }
  if (url) {
    url = url.replace(/[).,;!?\u201d]+$/g, "").trim();
  }

  return { title, url };
}

export function parseArticleFieldsWithToken(text: string): {
  title: string | null;
  url: string | null;
  token: string | null;
  searchFieldCue: string | null;
  submitControlCue: string | null;
  resultEntryCue: string | null;
  pageAdvanceCue: string | null;
  readbackLabelCue: string | null;
} {
  const normalized = (text ?? "").trim();
  if (!normalized) {
    return {
      title: null,
      url: null,
      token: null,
      searchFieldCue: null,
      submitControlCue: null,
      resultEntryCue: null,
      pageAdvanceCue: null,
      readbackLabelCue: null,
    };
  }

  let title: string | null = null;
  let url: string | null = null;
  let token: string | null = null;
  let searchFieldCue: string | null = null;
  let submitControlCue: string | null = null;
  let resultEntryCue: string | null = null;
  let pageAdvanceCue: string | null = null;
  let readbackLabelCue: string | null = null;

  for (const line of normalized.split(/\r?\n/)) {
    const titleMatch = line.match(/^\s*ARTICLE_TITLE\s*[:=]\s*(.+?)\s*$/i);
    if (titleMatch && !title) {
      title = titleMatch[1].trim();
    }
    const urlMatch = line.match(/^\s*ARTICLE_URL\s*[:=]\s*(.+?)\s*$/i);
    if (urlMatch && !url) {
      url = urlMatch[1].trim();
    }
    const tokenMatch = line.match(/^\s*ARTICLE_TOKEN\s*[:=]\s*(.+?)\s*$/i);
    if (tokenMatch && !token) {
      token = tokenMatch[1].trim();
    }
    const searchFieldCueMatch = line.match(/^\s*SEARCH_FIELD_CUE\s*[:=]\s*(.+?)\s*$/i);
    if (searchFieldCueMatch && !searchFieldCue) {
      searchFieldCue = searchFieldCueMatch[1].trim();
    }
    const submitControlCueMatch = line.match(/^\s*SUBMIT_CONTROL_CUE\s*[:=]\s*(.+?)\s*$/i);
    if (submitControlCueMatch && !submitControlCue) {
      submitControlCue = submitControlCueMatch[1].trim();
    }
    const resultEntryCueMatch = line.match(/^\s*RESULT_ENTRY_CUE\s*[:=]\s*(.+?)\s*$/i);
    if (resultEntryCueMatch && !resultEntryCue) {
      resultEntryCue = resultEntryCueMatch[1].trim();
    }
    const pageAdvanceCueMatch = line.match(/^\s*PAGE_ADVANCE_CUE\s*[:=]\s*(.+?)\s*$/i);
    if (pageAdvanceCueMatch && !pageAdvanceCue) {
      pageAdvanceCue = pageAdvanceCueMatch[1].trim();
    }
    const readbackLabelCueMatch = line.match(/^\s*READBACK_LABEL_CUE\s*[:=]\s*(.+?)\s*$/i);
    if (readbackLabelCueMatch && !readbackLabelCue) {
      readbackLabelCue = readbackLabelCueMatch[1].trim();
    }
  }

  if (!title) {
    const match = normalized.match(/\bARTICLE_TITLE\s*[:=]\s*(.+?)(?=\s+ARTICLE_URL\s*[:=]|\s+ARTICLE_TOKEN\s*[:=]|$)/i);
    if (match) title = match[1].trim();
  }
  if (!url) {
    const match = normalized.match(/\bARTICLE_URL\s*[:=]\s*(.+?)(?=\s+ARTICLE_TOKEN\s*[:=]|$)/i);
    if (match) url = match[1].trim();
  }
  if (!token) {
    const match = normalized.match(/\bARTICLE_TOKEN\s*[:=]\s*(.+?)\s*$/i);
    if (match) token = match[1].trim();
  }

  if (url) {
    url = url.replace(/[).,;!?\u201d]+$/g, "").trim();
  }
  if (token) {
    token = token.replace(/[).,;!?\u201d]+$/g, "").trim();
  }
  if (searchFieldCue) {
    searchFieldCue = searchFieldCue.replace(/[).,;!?\u201d]+$/g, "").trim();
    if (searchFieldCue === "-") searchFieldCue = null;
  }
  if (submitControlCue) {
    submitControlCue = submitControlCue.replace(/[).,;!?\u201d]+$/g, "").trim();
    if (submitControlCue === "-") submitControlCue = null;
  }
  if (resultEntryCue) {
    resultEntryCue = resultEntryCue.replace(/[).,;!?\u201d]+$/g, "").trim();
    if (resultEntryCue === "-") resultEntryCue = null;
  }
  if (pageAdvanceCue) {
    pageAdvanceCue = pageAdvanceCue.replace(/[).,;!?\u201d]+$/g, "").trim();
    if (pageAdvanceCue === "-") pageAdvanceCue = null;
  }
  if (readbackLabelCue) {
    readbackLabelCue = readbackLabelCue.replace(/[).,;!?\u201d]+$/g, "").trim();
    if (readbackLabelCue === "-") readbackLabelCue = null;
  }

  return { title, url, token, searchFieldCue, submitControlCue, resultEntryCue, pageAdvanceCue, readbackLabelCue };
}

export type WikiFailureKind =
  | "timeout_no_assistant"
  | "browser_not_visible"
  | "missing_article_fields"
  | "invalid_article_url"
  | "wrong_article_domain"
  | "query_mismatch"
  | "unknown";

function classifyWikipediaFailure(options: {
  assistantTurns: number;
  browserVisible: boolean;
  articleTitle: string | null;
  articleUrl: string | null;
  assistantSummary: string;
  query: string;
  budgetSec: number;
}): { failureKind: WikiFailureKind; failureDetails: string } {
  if (options.assistantTurns === 0) {
    return {
      failureKind: "timeout_no_assistant",
      failureDetails: `No assistant reply observed within ${options.budgetSec}s.`,
    };
  }
  if (!options.browserVisible) {
    return {
      failureKind: "browser_not_visible",
      failureDetails: "Browser session modal never became visible during the attempt.",
    };
  }
  if (!options.articleTitle || !options.articleUrl) {
    const lowered = options.assistantSummary.toLowerCase();
    const hinted =
      lowered.includes("article_title") ||
      lowered.includes("article_url") ||
      lowered.includes("wikipedia.org/wiki/");
    return {
      failureKind: "missing_article_fields",
      failureDetails: hinted
        ? "Assistant reply did not contain both ARTICLE_TITLE and ARTICLE_URL values in a parsable format."
        : "Missing ARTICLE_TITLE or ARTICLE_URL in assistant reply.",
    };
  }
  if (!/^https?:\/\//i.test(options.articleUrl)) {
    return {
      failureKind: "invalid_article_url",
      failureDetails: `ARTICLE_URL is not an http(s) URL: "${options.articleUrl}".`,
    };
  }
  if (!/wikipedia\.org\/wiki\//i.test(options.articleUrl)) {
    return {
      failureKind: "wrong_article_domain",
      failureDetails: `ARTICLE_URL is not a Wikipedia article URL: "${options.articleUrl}".`,
    };
  }
  const loweredTitle = options.articleTitle.toLowerCase();
  const loweredQuery = options.query.toLowerCase();
  if (!loweredTitle.includes(loweredQuery) && loweredTitle !== loweredQuery) {
    return {
      failureKind: "query_mismatch",
      failureDetails: `ARTICLE_TITLE did not match query "${options.query}": "${options.articleTitle}".`,
    };
  }
  return {
    failureKind: "unknown",
    failureDetails: "Attempt failed for an unknown reason.",
  };
}

export function looksLikeValidWikipediaTarget(title: string | null, url: string | null, query: string): boolean {
  if (!title || !url) return false;
  if (title.includes("<") || url.includes("<")) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (!/wikipedia\.org\/wiki\//i.test(url)) return false;
  const lowered = title.toLowerCase();
  if (!lowered.includes(query.toLowerCase())) {
    if (lowered !== query.toLowerCase()) return false;
  }
  return true;
}

export type WikiAttemptResult = {
  attempt: number;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  budgetSec: number;
  articleTitle: string | null;
  articleUrl: string | null;
  success: boolean;
  failureKind: WikiFailureKind | null;
  failureDetails: string | null;
  browserVisible: boolean;
  assistantTurns: number;
  assistantSummary: string;
  conversationControllerId: string | null;
  runId: string | null;
  tokenUsage: TokenUsage | null;
  mcpToolCalls: number;
  shellCommands: number;
  shellCommandSummaries: string[];
  learnedBlockReads: string[];
};

export async function runWikipediaAttempt(
  page: Page,
  attempt: number,
  prompt: string,
  budgetSec: number,
  query: string,
): Promise<WikiAttemptResult> {
  const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
  const baselineAssistantCount = await assistantBubbles.count();

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  await page.getByTestId("chat-input").fill(prompt);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled();
  await page.getByTestId("chat-send-button").click();

  const deadline = startedAtMs + budgetSec * 1000;
  const browserModal = page.getByTestId("browser-session-modal");
  let browserVisible = false;
  let assistantSummary = "";
  let lastSeenText = "";
  let articleTitle: string | null = null;
  let articleUrl: string | null = null;

  while (Date.now() < deadline) {
    if (!browserVisible) {
      browserVisible = await browserModal.isVisible().catch(() => false);
    }

    const count = await assistantBubbles.count();
    if (count > baselineAssistantCount) {
      const currentText = (await assistantBubbles.last().innerText().catch(() => "")).trim();
      if (currentText && currentText !== lastSeenText) {
        lastSeenText = currentText;
        assistantSummary = currentText;
        const parsed = parseArticleFields(currentText);
        articleTitle = parsed.title ?? articleTitle;
        articleUrl = parsed.url ?? articleUrl;
        if (looksLikeValidWikipediaTarget(articleTitle, articleUrl, query)) {
          break;
        }
      }
    }

    await page.waitForTimeout(1_000);
  }

  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();
  const assistantTurns = Math.max(0, (await assistantBubbles.count()) - baselineAssistantCount);
  const success = looksLikeValidWikipediaTarget(articleTitle, articleUrl, query);
  const failure = success
    ? { failureKind: null, failureDetails: null }
    : classifyWikipediaFailure({
        assistantTurns,
        browserVisible,
        articleTitle,
        articleUrl,
        assistantSummary,
        query,
        budgetSec,
      });

  const assistantMatch = (content: string) => {
    const parsed = parseArticleFields(content);
    return looksLikeValidWikipediaTarget(parsed.title, parsed.url, query);
  };
  const conversationControllerId = await tryWaitForConversationControllerId(page, 20_000);
  const metrics =
    conversationControllerId
      ? await fetchRunMetricsForAttemptWithRetry(page, conversationControllerId, assistantMatch).catch(() => ({
          runId: null,
          tokenUsage: null,
          mcpToolCalls: 0,
          shellCommands: 0,
          shellCommandSummaries: [],
          learnRouterBlocks: [],
          learnedBlockReads: [],
          learnedBlockReadCommands: [],
        }))
      : {
          runId: null,
          tokenUsage: null,
          mcpToolCalls: 0,
          shellCommands: 0,
          shellCommandSummaries: [],
          learnRouterBlocks: [],
          learnedBlockReads: [],
          learnedBlockReadCommands: [],
        };

  return {
    attempt,
    startedAt,
    endedAt,
    wallMs: endedAtMs - startedAtMs,
    budgetSec,
    articleTitle,
    articleUrl,
    success,
    failureKind: failure.failureKind,
    failureDetails: failure.failureDetails,
    browserVisible,
    assistantTurns,
    assistantSummary,
    conversationControllerId,
    runId: metrics.runId,
    tokenUsage: metrics.tokenUsage,
    mcpToolCalls: metrics.mcpToolCalls,
    shellCommands: metrics.shellCommands,
    shellCommandSummaries: metrics.shellCommandSummaries ?? [],
    learnedBlockReads: metrics.learnedBlockReads ?? [],
  };
}

export type FixtureNewsFailureKind =
  | "timeout_no_assistant"
  | "browser_not_visible"
  | "missing_article_fields"
  | "invalid_article_url"
  | "wrong_origin"
  | "wrong_article"
  | "unknown";

export function looksLikeValidFixtureNewsTarget(options: {
  title: string | null;
  url: string | null;
  expectedOrigin: string;
  expectedPathname: string;
}): boolean {
  const title = options.title?.trim() ?? "";
  const url = options.url?.trim() ?? "";
  if (!title || !url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== options.expectedOrigin) return false;
    if (parsed.pathname !== options.expectedPathname) return false;
  } catch {
    return false;
  }
  // Title matching is intentionally lax so the bench focuses on navigation + reading the page.
  return true;
}

function classifyFixtureNewsFailure(options: {
  assistantTurns: number;
  browserVisible: boolean;
  articleTitle: string | null;
  articleUrl: string | null;
  assistantSummary: string;
  expectedOrigin: string;
  expectedPathname: string;
  budgetSec: number;
}): { failureKind: FixtureNewsFailureKind; failureDetails: string } {
  if (options.assistantTurns === 0) {
    return {
      failureKind: "timeout_no_assistant",
      failureDetails: `No assistant reply observed within ${options.budgetSec}s.`,
    };
  }
  if (!options.browserVisible) {
    return {
      failureKind: "browser_not_visible",
      failureDetails: "Browser session modal never became visible during the attempt.",
    };
  }
  if (!options.articleTitle || !options.articleUrl) {
    const lowered = options.assistantSummary.toLowerCase();
    const hinted = lowered.includes("article_title") || lowered.includes("article_url") || lowered.includes("/article/");
    return {
      failureKind: "missing_article_fields",
      failureDetails: hinted
        ? "Assistant reply did not contain both ARTICLE_TITLE and ARTICLE_URL values in a parsable format."
        : "Missing ARTICLE_TITLE or ARTICLE_URL in assistant reply.",
    };
  }
  if (!/^https?:\/\//i.test(options.articleUrl)) {
    return {
      failureKind: "invalid_article_url",
      failureDetails: `ARTICLE_URL is not an http(s) URL: "${options.articleUrl}".`,
    };
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(options.articleUrl);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      failureKind: "invalid_article_url",
      failureDetails: `ARTICLE_URL could not be parsed: "${options.articleUrl}".`,
    };
  }
  if (parsed.origin !== options.expectedOrigin) {
    return {
      failureKind: "wrong_origin",
      failureDetails: `Expected origin "${options.expectedOrigin}", got "${parsed.origin}".`,
    };
  }
  if (parsed.pathname !== options.expectedPathname) {
    return {
      failureKind: "wrong_article",
      failureDetails: `Expected pathname "${options.expectedPathname}", got "${parsed.pathname}".`,
    };
  }
  return {
    failureKind: "unknown",
    failureDetails: "Attempt failed for an unknown reason.",
  };
}

export type FixtureNewsAttemptResult = {
  attempt: number;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  budgetSec: number;
  articleTitle: string | null;
  articleUrl: string | null;
  success: boolean;
  failureKind: FixtureNewsFailureKind | null;
  failureDetails: string | null;
  browserVisible: boolean;
  assistantTurns: number;
  assistantSummary: string;
  conversationControllerId: string | null;
  runId: string | null;
  tokenUsage: TokenUsage | null;
  mcpToolCalls: number;
  shellCommands: number;
  shellCommandSummaries: string[];
  expectedOrigin: string;
  expectedPathname: string;
  learnRouterBlocks: Array<{ name: string | null; path: string; score: number | null; matchedTokens: string[] }>;
  learnedBlockReads: string[];
  learnedBlockReadCommands: string[];
};

export async function runFixtureNewsAttempt(
  page: Page,
  attempt: number,
  prompt: string,
  budgetSec: number,
  options: {
    expectedOrigin: string;
    expectedPathname: string;
  },
): Promise<FixtureNewsAttemptResult> {
  const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
  const baselineAssistantCount = await assistantBubbles.count();

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  await page.getByTestId("chat-input").fill(prompt);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled();
  await page.getByTestId("chat-send-button").click();

  const deadline = startedAtMs + budgetSec * 1000;
  const browserModal = page.getByTestId("browser-session-modal");
  let browserVisible = false;
  let assistantSummary = "";
  let lastSeenText = "";
  let articleTitle: string | null = null;
  let articleUrl: string | null = null;

  while (Date.now() < deadline) {
    if (!browserVisible) {
      browserVisible = await browserModal.isVisible().catch(() => false);
    }

    const count = await assistantBubbles.count();
    if (count > baselineAssistantCount) {
      const currentText = (await assistantBubbles.last().innerText().catch(() => "")).trim();
      if (currentText && currentText !== lastSeenText) {
        lastSeenText = currentText;
        assistantSummary = currentText;
        const parsed = parseArticleFields(currentText);
        articleTitle = parsed.title ?? articleTitle;
        articleUrl = parsed.url ?? articleUrl;
        if (
          looksLikeValidFixtureNewsTarget({
            title: articleTitle,
            url: articleUrl,
            expectedOrigin: options.expectedOrigin,
            expectedPathname: options.expectedPathname,
          })
        ) {
          break;
        }
      }
    }

    await page.waitForTimeout(1_000);
  }

  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();
  const assistantTurns = Math.max(0, (await assistantBubbles.count()) - baselineAssistantCount);

  const success = looksLikeValidFixtureNewsTarget({
    title: articleTitle,
    url: articleUrl,
    expectedOrigin: options.expectedOrigin,
    expectedPathname: options.expectedPathname,
  });
  const failure = success
    ? { failureKind: null, failureDetails: null }
    : classifyFixtureNewsFailure({
        assistantTurns,
        browserVisible,
        articleTitle,
        articleUrl,
        assistantSummary,
        expectedOrigin: options.expectedOrigin,
        expectedPathname: options.expectedPathname,
        budgetSec,
      });

  const assistantMatch = (content: string) => {
    const parsed = parseArticleFields(content);
    if (articleUrl && parsed.url && parsed.url === articleUrl) {
      return true;
    }
    // If we never parsed an ARTICLE_URL, still attempt to anchor metrics to any assistant message
    // that looks like a benchmark response (it should include ARTICLE_URL).
    if (!articleUrl && parsed.url) {
      return true;
    }
    // Fallback: success case, where the URL matches the expected origin/path.
    return looksLikeValidFixtureNewsTarget({
      title: parsed.title,
      url: parsed.url,
      expectedOrigin: options.expectedOrigin,
      expectedPathname: options.expectedPathname,
    });
  };

  const conversationControllerId = await tryWaitForConversationControllerId(page, 20_000);
  const metrics =
    conversationControllerId
      ? await fetchRunMetricsForAttemptWithRetry(page, conversationControllerId, assistantMatch).catch(() => ({
          runId: null,
          tokenUsage: null,
          mcpToolCalls: 0,
          shellCommands: 0,
          shellCommandSummaries: [],
          learnRouterBlocks: [],
          learnedBlockReads: [],
          learnedBlockReadCommands: [],
        }))
      : {
          runId: null,
          tokenUsage: null,
          mcpToolCalls: 0,
          shellCommands: 0,
          shellCommandSummaries: [],
          learnRouterBlocks: [],
          learnedBlockReads: [],
          learnedBlockReadCommands: [],
        };

  return {
    attempt,
    startedAt,
    endedAt,
    wallMs: endedAtMs - startedAtMs,
    budgetSec,
    articleTitle,
    articleUrl,
    success,
    failureKind: failure.failureKind,
    failureDetails: failure.failureDetails,
    browserVisible,
    assistantTurns,
    assistantSummary,
    conversationControllerId,
    runId: metrics.runId,
    tokenUsage: metrics.tokenUsage,
    mcpToolCalls: metrics.mcpToolCalls,
    shellCommands: metrics.shellCommands,
    shellCommandSummaries: metrics.shellCommandSummaries ?? [],
    expectedOrigin: options.expectedOrigin,
    expectedPathname: options.expectedPathname,
    learnRouterBlocks: metrics.learnRouterBlocks ?? [],
    learnedBlockReads: metrics.learnedBlockReads ?? [],
    learnedBlockReadCommands: metrics.learnedBlockReadCommands ?? [],
  };
}

export type FixtureNewsTokenFailureKind =
  | "timeout_no_assistant"
  | "browser_not_visible"
  | "missing_article_fields"
  | "invalid_article_url"
  | "wrong_origin"
  | "wrong_article"
  | "wrong_token"
  | "unknown";

function looksLikeValidFixtureNewsTokenTarget(options: {
  title: string | null;
  url: string | null;
  token: string | null;
  expectedOrigin: string;
  expectedPathname: string;
  expectedToken: string;
}): boolean {
  if (
    !looksLikeValidFixtureNewsTarget({
      title: options.title,
      url: options.url,
      expectedOrigin: options.expectedOrigin,
      expectedPathname: options.expectedPathname,
    })
  ) {
    return false;
  }

  const token = options.token?.trim() ?? "";
  if (!token) return false;
  return token.toLowerCase() === options.expectedToken.trim().toLowerCase();
}

function classifyFixtureNewsTokenFailure(options: {
  assistantTurns: number;
  browserVisible: boolean;
  articleTitle: string | null;
  articleUrl: string | null;
  articleToken: string | null;
  assistantSummary: string;
  expectedOrigin: string;
  expectedPathname: string;
  expectedToken: string;
  budgetSec: number;
}): { failureKind: FixtureNewsTokenFailureKind; failureDetails: string } {
  if (options.assistantTurns === 0) {
    return {
      failureKind: "timeout_no_assistant",
      failureDetails: `No assistant reply observed within ${options.budgetSec}s.`,
    };
  }
  if (!options.browserVisible) {
    return {
      failureKind: "browser_not_visible",
      failureDetails: "Browser session modal never became visible during the attempt.",
    };
  }
  if (!options.articleTitle || !options.articleUrl || !options.articleToken) {
    const lowered = options.assistantSummary.toLowerCase();
    const hinted =
      lowered.includes("article_title") ||
      lowered.includes("article_url") ||
      lowered.includes("article_token") ||
      lowered.includes("/article/");
    return {
      failureKind: "missing_article_fields",
      failureDetails: hinted
        ? "Assistant reply did not contain ARTICLE_TITLE, ARTICLE_URL, and ARTICLE_TOKEN values in a parsable format."
        : "Missing ARTICLE_TITLE, ARTICLE_URL, or ARTICLE_TOKEN in assistant reply.",
    };
  }
  if (!/^https?:\/\//i.test(options.articleUrl)) {
    return {
      failureKind: "invalid_article_url",
      failureDetails: `ARTICLE_URL is not an http(s) URL: "${options.articleUrl}".`,
    };
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(options.articleUrl);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      failureKind: "invalid_article_url",
      failureDetails: `ARTICLE_URL could not be parsed: "${options.articleUrl}".`,
    };
  }
  if (parsed.origin !== options.expectedOrigin) {
    return {
      failureKind: "wrong_origin",
      failureDetails: `Expected origin "${options.expectedOrigin}", got "${parsed.origin}".`,
    };
  }
  if (parsed.pathname !== options.expectedPathname) {
    return {
      failureKind: "wrong_article",
      failureDetails: `Expected pathname "${options.expectedPathname}", got "${parsed.pathname}".`,
    };
  }
  if (options.articleToken.trim().toLowerCase() !== options.expectedToken.trim().toLowerCase()) {
    return {
      failureKind: "wrong_token",
      failureDetails: `Expected token "${options.expectedToken}", got "${options.articleToken}".`,
    };
  }
  return {
    failureKind: "unknown",
    failureDetails: "Attempt failed for an unknown reason.",
  };
}

export type FixtureNewsTokenAttemptResult = {
  attempt: number;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  budgetSec: number;
  articleTitle: string | null;
  articleUrl: string | null;
  articleToken: string | null;
  success: boolean;
  failureKind: FixtureNewsTokenFailureKind | null;
  failureDetails: string | null;
  browserVisible: boolean;
  assistantTurns: number;
  assistantSummary: string;
  conversationControllerId: string | null;
  runId: string | null;
  tokenUsage: TokenUsage | null;
  mcpToolCalls: number;
  shellCommands: number;
  shellCommandSummaries: string[];
  expectedOrigin: string;
  expectedPathname: string;
  expectedToken: string;
  searchFieldCue: string | null;
  submitControlCue: string | null;
  resultEntryCue: string | null;
  pageAdvanceCue: string | null;
  readbackLabelCue: string | null;
  learnRouterBlocks: Array<{ name: string | null; path: string; score: number | null; matchedTokens: string[] }>;
  learnedBlockReads: string[];
  learnedBlockReadCommands: string[];
};

export function parseCatalogPageFields(text: string): {
  pageTitle: string | null;
  pageUrl: string | null;
  deltaVisible: string | null;
  pageAdvanceCue: string | null;
  resultEntryCue: string | null;
} {
  const normalized = (text ?? "").trim();
  if (!normalized) return { pageTitle: null, pageUrl: null, deltaVisible: null, pageAdvanceCue: null, resultEntryCue: null };

  let pageTitle: string | null = null;
  let pageUrl: string | null = null;
  let deltaVisible: string | null = null;
  let pageAdvanceCue: string | null = null;
  let resultEntryCue: string | null = null;

  for (const line of normalized.split(/\r?\n/)) {
    const titleMatch = line.match(/^\s*PAGE_TITLE\s*[:=]\s*(.+?)\s*$/i);
    if (titleMatch && !pageTitle) {
      pageTitle = titleMatch[1].trim();
    }
    const urlMatch = line.match(/^\s*PAGE_URL\s*[:=]\s*(.+?)\s*$/i);
    if (urlMatch && !pageUrl) {
      pageUrl = urlMatch[1].trim();
    }
    const visibleMatch = line.match(/^\s*DELTA_LISTING_VISIBLE\s*[:=]\s*(.+?)\s*$/i);
    if (visibleMatch && !deltaVisible) {
      deltaVisible = visibleMatch[1].trim();
    }
    const pageAdvanceCueMatch = line.match(/^\s*PAGE_ADVANCE_CUE\s*[:=]\s*(.+?)\s*$/i);
    if (pageAdvanceCueMatch && !pageAdvanceCue) {
      pageAdvanceCue = pageAdvanceCueMatch[1].trim();
    }
    const resultEntryCueMatch = line.match(/^\s*RESULT_ENTRY_CUE\s*[:=]\s*(.+?)\s*$/i);
    if (resultEntryCueMatch && !resultEntryCue) {
      resultEntryCue = resultEntryCueMatch[1].trim();
    }
  }

  if (!pageTitle) {
    const match = normalized.match(/\bPAGE_TITLE\s*[:=]\s*(.+?)(?=\s+PAGE_URL\s*[:=]|\s+DELTA_LISTING_VISIBLE\s*[:=]|$)/i);
    if (match) pageTitle = match[1].trim();
  }
  if (!pageUrl) {
    const match = normalized.match(/\bPAGE_URL\s*[:=]\s*(.+?)(?=\s+DELTA_LISTING_VISIBLE\s*[:=]|$)/i);
    if (match) pageUrl = match[1].trim();
  }
  if (!deltaVisible) {
    const match = normalized.match(/\bDELTA_LISTING_VISIBLE\s*[:=]\s*(.+?)\s*$/i);
    if (match) deltaVisible = match[1].trim();
  }

  if (pageUrl) {
    pageUrl = pageUrl.replace(/[).,;!?\u201d]+$/g, "").trim();
  }
  if (deltaVisible) {
    deltaVisible = deltaVisible.toLowerCase();
  }
  if (pageAdvanceCue) {
    pageAdvanceCue = pageAdvanceCue.replace(/[).,;!?\u201d]+$/g, "").trim();
    if (pageAdvanceCue === "-") pageAdvanceCue = null;
  }
  if (resultEntryCue) {
    resultEntryCue = resultEntryCue.replace(/[).,;!?\u201d]+$/g, "").trim();
    if (resultEntryCue === "-") resultEntryCue = null;
  }

  return { pageTitle, pageUrl, deltaVisible, pageAdvanceCue, resultEntryCue };
}

export type CatalogPaginationFailureKind =
  | "timeout_no_assistant"
  | "browser_not_visible"
  | "missing_page_fields"
  | "invalid_page_url"
  | "wrong_origin"
  | "wrong_catalog_page"
  | "delta_not_visible"
  | "unknown";

function looksLikeValidCatalogPaginationTarget(options: {
  pageTitle: string | null;
  pageUrl: string | null;
  deltaVisible: string | null;
  expectedOrigin: string;
  expectedPathname: string;
  expectedQuery?: string | null;
}): boolean {
  const pageTitle = options.pageTitle?.trim() ?? "";
  const pageUrl = options.pageUrl?.trim() ?? "";
  const deltaVisible = options.deltaVisible?.trim().toLowerCase() ?? "";
  if (!pageTitle || !pageUrl || !deltaVisible) return false;
  if (deltaVisible !== "yes" && deltaVisible !== "true") return false;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(pageUrl);
  } catch {
    return false;
  }
  if (parsedUrl.origin !== options.expectedOrigin) return false;
  if (parsedUrl.pathname !== options.expectedPathname) return false;
  const expectedQuery = options.expectedQuery?.trim() ?? "";
  if (expectedQuery && parsedUrl.search !== expectedQuery) return false;
  return /catalog page 2/i.test(pageTitle);
}

function classifyCatalogPaginationFailure(options: {
  assistantTurns: number;
  browserVisible: boolean;
  pageTitle: string | null;
  pageUrl: string | null;
  deltaVisible: string | null;
  assistantSummary: string;
  expectedOrigin: string;
  expectedPathname: string;
  expectedQuery?: string | null;
  budgetSec: number;
}): { failureKind: CatalogPaginationFailureKind; failureDetails: string } {
  if (options.assistantTurns === 0) {
    return {
      failureKind: "timeout_no_assistant",
      failureDetails: `No assistant reply observed within ${options.budgetSec}s.`,
    };
  }
  if (!options.browserVisible) {
    return {
      failureKind: "browser_not_visible",
      failureDetails: "Browser session modal never became visible during the attempt.",
    };
  }
  if (!options.pageTitle || !options.pageUrl || !options.deltaVisible) {
    return {
      failureKind: "missing_page_fields",
      failureDetails: 'Missing PAGE_TITLE, PAGE_URL, or DELTA_LISTING_VISIBLE in assistant reply.',
    };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(options.pageUrl);
  } catch {
    return {
      failureKind: "invalid_page_url",
      failureDetails: `PAGE_URL is not an http(s) URL: "${options.pageUrl}".`,
    };
  }
  if (parsedUrl.origin !== options.expectedOrigin) {
    return {
      failureKind: "wrong_origin",
      failureDetails: `Expected origin "${options.expectedOrigin}", got "${parsedUrl.origin}".`,
    };
  }
  const expectedQuery = options.expectedQuery?.trim() ?? "";
  if (parsedUrl.pathname !== options.expectedPathname || (expectedQuery && parsedUrl.search !== expectedQuery)) {
    return {
      failureKind: "wrong_catalog_page",
      failureDetails: `Expected "${options.expectedPathname}${expectedQuery}", got "${parsedUrl.pathname}${parsedUrl.search}".`,
    };
  }
  if (!/catalog page 2/i.test(options.pageTitle)) {
    return {
      failureKind: "wrong_catalog_page",
      failureDetails: `Expected catalog page 2 title, got "${options.pageTitle}".`,
    };
  }
  if (!["yes", "true"].includes(options.deltaVisible.trim().toLowerCase())) {
    return {
      failureKind: "delta_not_visible",
      failureDetails: `Expected DELTA_LISTING_VISIBLE to be yes/true, got "${options.deltaVisible}".`,
    };
  }
  return {
    failureKind: "unknown",
    failureDetails: "Attempt failed for an unknown reason.",
  };
}

export type CatalogPaginationAttemptResult = {
  attempt: number;
  startedAt: string;
  endedAt: string;
  wallMs: number;
  budgetSec: number;
  pageTitle: string | null;
  pageUrl: string | null;
  deltaVisible: string | null;
  success: boolean;
  failureKind: CatalogPaginationFailureKind | null;
  failureDetails: string | null;
  browserVisible: boolean;
  assistantTurns: number;
  assistantSummary: string;
  conversationControllerId: string | null;
  runId: string | null;
  tokenUsage: TokenUsage | null;
  mcpToolCalls: number;
  shellCommands: number;
  shellCommandSummaries: string[];
  expectedOrigin: string;
  expectedPathname: string;
  expectedQuery: string;
  pageAdvanceCue: string | null;
  resultEntryCue: string | null;
  learnRouterBlocks: Array<{ name: string | null; path: string; score: number | null; matchedTokens: string[] }>;
  learnedBlockReads: string[];
  learnedBlockReadCommands: string[];
};

export async function runFixtureNewsTokenAttempt(
  page: Page,
  attempt: number,
  prompt: string,
  budgetSec: number,
  options: {
    expectedOrigin: string;
    expectedPathname: string;
    expectedToken: string;
  },
): Promise<FixtureNewsTokenAttemptResult> {
  const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
  const baselineAssistantCount = await assistantBubbles.count();

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  await page.getByTestId("chat-input").fill(prompt);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled();
  await page.getByTestId("chat-send-button").click();

  const deadline = startedAtMs + budgetSec * 1000;
  const browserModal = page.getByTestId("browser-session-modal");
  let browserVisible = false;
  let assistantSummary = "";
  let lastSeenText = "";
  let articleTitle: string | null = null;
  let articleUrl: string | null = null;
  let articleToken: string | null = null;
  let searchFieldCue: string | null = null;
  let submitControlCue: string | null = null;
  let resultEntryCue: string | null = null;
  let pageAdvanceCue: string | null = null;
  let readbackLabelCue: string | null = null;

  while (Date.now() < deadline) {
    if (!browserVisible) {
      browserVisible = await browserModal.isVisible().catch(() => false);
    }

    const count = await assistantBubbles.count();
    if (count > baselineAssistantCount) {
      const currentText = (await assistantBubbles.last().innerText().catch(() => "")).trim();
      if (currentText && currentText !== lastSeenText) {
        lastSeenText = currentText;
        assistantSummary = currentText;
        const parsed = parseArticleFieldsWithToken(currentText);
        articleTitle = parsed.title ?? articleTitle;
        articleUrl = parsed.url ?? articleUrl;
        articleToken = parsed.token ?? articleToken;
        searchFieldCue = parsed.searchFieldCue ?? searchFieldCue;
        submitControlCue = parsed.submitControlCue ?? submitControlCue;
        resultEntryCue = parsed.resultEntryCue ?? resultEntryCue;
        pageAdvanceCue = parsed.pageAdvanceCue ?? pageAdvanceCue;
        readbackLabelCue = parsed.readbackLabelCue ?? readbackLabelCue;
        if (
          looksLikeValidFixtureNewsTokenTarget({
            title: articleTitle,
            url: articleUrl,
            token: articleToken,
            expectedOrigin: options.expectedOrigin,
            expectedPathname: options.expectedPathname,
            expectedToken: options.expectedToken,
          })
        ) {
          break;
        }
      }
    }

    await page.waitForTimeout(1_000);
  }

  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();
  const assistantTurns = Math.max(0, (await assistantBubbles.count()) - baselineAssistantCount);

  const success = looksLikeValidFixtureNewsTokenTarget({
    title: articleTitle,
    url: articleUrl,
    token: articleToken,
    expectedOrigin: options.expectedOrigin,
    expectedPathname: options.expectedPathname,
    expectedToken: options.expectedToken,
  });
  const failure = success
    ? { failureKind: null, failureDetails: null }
    : classifyFixtureNewsTokenFailure({
        assistantTurns,
        browserVisible,
        articleTitle,
        articleUrl,
        articleToken,
        assistantSummary,
        expectedOrigin: options.expectedOrigin,
        expectedPathname: options.expectedPathname,
        expectedToken: options.expectedToken,
        budgetSec,
      });

  const assistantMatch = (content: string) => {
    const parsed = parseArticleFieldsWithToken(content);
    if (articleUrl && parsed.url && parsed.url === articleUrl) {
      return true;
    }
    if (!articleUrl && parsed.url) {
      return true;
    }
    return looksLikeValidFixtureNewsTokenTarget({
      title: parsed.title,
      url: parsed.url,
      token: parsed.token,
      expectedOrigin: options.expectedOrigin,
      expectedPathname: options.expectedPathname,
      expectedToken: options.expectedToken,
    });
  };

  const conversationControllerId = await tryWaitForConversationControllerId(page, 20_000);
  const metrics =
    conversationControllerId
      ? await fetchRunMetricsForAttemptWithRetry(page, conversationControllerId, assistantMatch).catch(() => ({
          runId: null,
          tokenUsage: null,
          mcpToolCalls: 0,
          shellCommands: 0,
          shellCommandSummaries: [],
          learnRouterBlocks: [],
          learnedBlockReads: [],
          learnedBlockReadCommands: [],
        }))
      : {
          runId: null,
          tokenUsage: null,
          mcpToolCalls: 0,
          shellCommands: 0,
          shellCommandSummaries: [],
          learnRouterBlocks: [],
          learnedBlockReads: [],
          learnedBlockReadCommands: [],
        };

  return {
    attempt,
    startedAt,
    endedAt,
    wallMs: endedAtMs - startedAtMs,
    budgetSec,
    articleTitle,
    articleUrl,
    articleToken,
    success,
    failureKind: failure.failureKind,
    failureDetails: failure.failureDetails,
    browserVisible,
    assistantTurns,
    assistantSummary,
    conversationControllerId,
    runId: metrics.runId,
    tokenUsage: metrics.tokenUsage,
    mcpToolCalls: metrics.mcpToolCalls,
    shellCommands: metrics.shellCommands,
    shellCommandSummaries: metrics.shellCommandSummaries ?? [],
    expectedOrigin: options.expectedOrigin,
    expectedPathname: options.expectedPathname,
    expectedToken: options.expectedToken,
    searchFieldCue,
    submitControlCue,
    resultEntryCue,
    pageAdvanceCue,
    readbackLabelCue,
    learnRouterBlocks: metrics.learnRouterBlocks ?? [],
    learnedBlockReads: metrics.learnedBlockReads ?? [],
    learnedBlockReadCommands: metrics.learnedBlockReadCommands ?? [],
  };
}

export async function runCatalogPaginationAttempt(
  page: Page,
  attempt: number,
  prompt: string,
  budgetSec: number,
  options: {
    expectedOrigin: string;
    expectedPathname: string;
    expectedQuery: string;
  },
): Promise<CatalogPaginationAttemptResult> {
  const assistantBubbles = page.locator('[data-testid="chat-bubble-assistant"]');
  const baselineAssistantCount = await assistantBubbles.count();

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  await page.getByTestId("chat-input").fill(prompt);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled();
  await page.getByTestId("chat-send-button").click();

  const deadline = startedAtMs + budgetSec * 1000;
  const browserModal = page.getByTestId("browser-session-modal");
  let browserVisible = false;
  let assistantSummary = "";
  let lastSeenText = "";
  let pageTitle: string | null = null;
  let pageUrl: string | null = null;
  let deltaVisible: string | null = null;
  let pageAdvanceCue: string | null = null;
  let resultEntryCue: string | null = null;

  while (Date.now() < deadline) {
    if (!browserVisible) {
      browserVisible = await browserModal.isVisible().catch(() => false);
    }

    const count = await assistantBubbles.count();
    if (count > baselineAssistantCount) {
      const currentText = (await assistantBubbles.last().innerText().catch(() => "")).trim();
      if (currentText && currentText !== lastSeenText) {
        lastSeenText = currentText;
        assistantSummary = currentText;
        const parsed = parseCatalogPageFields(currentText);
        pageTitle = parsed.pageTitle ?? pageTitle;
        pageUrl = parsed.pageUrl ?? pageUrl;
        deltaVisible = parsed.deltaVisible ?? deltaVisible;
        pageAdvanceCue = parsed.pageAdvanceCue ?? pageAdvanceCue;
        resultEntryCue = parsed.resultEntryCue ?? resultEntryCue;
        if (
          looksLikeValidCatalogPaginationTarget({
            pageTitle,
            pageUrl,
            deltaVisible,
            expectedOrigin: options.expectedOrigin,
            expectedPathname: options.expectedPathname,
            expectedQuery: options.expectedQuery,
          })
        ) {
          break;
        }
      }
    }

    await page.waitForTimeout(1_000);
  }

  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();
  const assistantTurns = Math.max(0, (await assistantBubbles.count()) - baselineAssistantCount);

  const success = looksLikeValidCatalogPaginationTarget({
    pageTitle,
    pageUrl,
    deltaVisible,
    expectedOrigin: options.expectedOrigin,
    expectedPathname: options.expectedPathname,
    expectedQuery: options.expectedQuery,
  });
  const failure = success
    ? { failureKind: null, failureDetails: null }
    : classifyCatalogPaginationFailure({
        assistantTurns,
        browserVisible,
        pageTitle,
        pageUrl,
        deltaVisible,
        assistantSummary,
        expectedOrigin: options.expectedOrigin,
        expectedPathname: options.expectedPathname,
        expectedQuery: options.expectedQuery,
        budgetSec,
      });

  const assistantMatch = (content: string) => {
    const parsed = parseCatalogPageFields(content);
    return looksLikeValidCatalogPaginationTarget({
      pageTitle: parsed.pageTitle,
      pageUrl: parsed.pageUrl,
      deltaVisible: parsed.deltaVisible,
      expectedOrigin: options.expectedOrigin,
      expectedPathname: options.expectedPathname,
      expectedQuery: options.expectedQuery,
    });
  };

  const conversationControllerId = await tryWaitForConversationControllerId(page, 20_000);
  const metrics =
    conversationControllerId
      ? await fetchRunMetricsForAttemptWithRetry(page, conversationControllerId, assistantMatch).catch(() => ({
          runId: null,
          tokenUsage: null,
          mcpToolCalls: 0,
          shellCommands: 0,
          shellCommandSummaries: [],
          learnRouterBlocks: [],
          learnedBlockReads: [],
          learnedBlockReadCommands: [],
        }))
      : {
          runId: null,
          tokenUsage: null,
          mcpToolCalls: 0,
          shellCommands: 0,
          shellCommandSummaries: [],
          learnRouterBlocks: [],
          learnedBlockReads: [],
          learnedBlockReadCommands: [],
        };

  return {
    attempt,
    startedAt,
    endedAt,
    wallMs: endedAtMs - startedAtMs,
    budgetSec,
    pageTitle,
    pageUrl,
    deltaVisible,
    success,
    failureKind: failure.failureKind,
    failureDetails: failure.failureDetails,
    browserVisible,
    assistantTurns,
    assistantSummary,
    conversationControllerId,
    runId: metrics.runId,
    tokenUsage: metrics.tokenUsage,
    mcpToolCalls: metrics.mcpToolCalls,
    shellCommands: metrics.shellCommands,
    shellCommandSummaries: metrics.shellCommandSummaries ?? [],
    expectedOrigin: options.expectedOrigin,
    expectedPathname: options.expectedPathname,
    expectedQuery: options.expectedQuery,
    pageAdvanceCue,
    resultEntryCue,
    learnRouterBlocks: metrics.learnRouterBlocks ?? [],
    learnedBlockReads: metrics.learnedBlockReads ?? [],
    learnedBlockReadCommands: metrics.learnedBlockReadCommands ?? [],
  };
}
