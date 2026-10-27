const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// Redaction, step classification and the page's secret checks come from
// @instafy/browser-action-policy, embedded ahead of this script by the runtime agent.
const redaction = globalThis.__instafyBrowserRedaction;
const actionPolicy = globalThis.__instafyBrowserActionPolicy;
const pageCapture = globalThis.__instafyBrowserPageCapture;
// The web-research skill's link-only list, embedded by the runtime agent ahead
// of this script. Octo never opens, reads or acts on a site on it, in any tab:
// its own tabs and the page the person chose alike.
const LINK_ONLY_SITES = linkOnlySitesFrom(globalThis.__instafyLinkOnlySites);
if (
  !redaction || typeof redaction.redactPageObservation !== "function" ||
  !actionPolicy || typeof actionPolicy.classifyStep !== "function" ||
  !pageCapture || typeof pageCapture.pageSecretSignalsInPage !== "function"
) {
  throw new Error("Shared Browser redaction and step policy are unavailable");
}
const { chromium } = require(
  validatePlaywrightModulePath(
    process.env.INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH,
    process.env.INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT,
  ),
);

const ACTIONS_FILE =
  process.env.INSTAFY_BROWSER_ACTIONS_FILE ||
  "/tmp/instafy/playwright/actions.jsonl";
const CDP_URL = validateCdpUrl(
  process.env.INSTAFY_PLAYWRIGHT_CDP_URL ||
    `http://127.0.0.1:${process.env.INSTAFY_PLAYWRIGHT_CDP_PORT || 9223}`,
);
const EXPECTED_BROWSER_PAGE_ID = validateBrowserPageId(
  process.env.INSTAFY_SHARED_BROWSER_PAGE_ID,
);
const AGENT_CONTROL_FILE =
  process.env.INSTAFY_BROWSER_AGENT_CONTROL_FILE ||
  "/run/instafy/browser/agent-control.json";
const APPROVAL_DIR =
  process.env.INSTAFY_SHARED_BROWSER_APPROVAL_DIR ||
  "/run/instafy/browser/approvals";
const approvalProtocol = globalThis.__instafyCreateSharedBrowserApprovalProtocol({
  approvalDir: APPROVAL_DIR,
  markerPath: AGENT_CONTROL_FILE,
  browserPageId: EXPECTED_BROWSER_PAGE_ID,
  timeoutMs: process.env.INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS,
});
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([type=hidden]):not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=combobox]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");
const MAX_INTERACTIVE_ELEMENTS = 200;
const MAX_LABEL_CHARS = 240;
const MAX_VISIBLE_TEXT_CHARS = 12_000;
const MAX_URL_CHARS = 4_096;
const MAX_TEXT_CHARS = 16_384;
const MAX_SCROLL_DELTA = 10_000;
const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{64}$/;
const ALLOWED_PRESS_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  " ",
  "Space",
]);
// Regular-expression sources the page-side checks need. Values are tested in
// the page and only yes/no answers come back.
const PAGE_POLICY_SOURCES = Object.freeze({
  kind: "page-policy",
  secretPatterns: [...redaction.KNOWN_SECRET_PATTERN_SOURCES],
  credentialContext: redaction.CREDENTIAL_CONTEXT_SOURCE,
  placeholder: redaction.PLACEHOLDER_SOURCE,
  maskedText: redaction.MASKED_TEXT_SOURCE,
});
// A document keeps this mark until a new page loads. It makes a page that was
// a secret screen, or on which a credential step ran, stay withheld across the
// separate controller processes of one run.
const WITHHELD_DOCUMENT_KEY = "instafy.sharedBrowser.withheldDocument";
// Named categories ask even under routine browsing. Ordinary record changes
// ("change") still ask only at submission, except a button whose label commits
// a change (`commit: true`). Menus, tabs and navigation items never carry it.
const ROUTINE_CONFIRMED_CATEGORIES = new Set([
  "purchase",
  "transfer",
  "message",
  "permission",
  "credential",
  "download",
  "destructive",
  "may_show_secret",
]);
// Before one of these steps runs, the page and the page it opens are withheld.
const WITHHOLDING_CATEGORIES = new Set(["credential", "may_show_secret"]);
// The exit code when Instafy's browser or the run's own tab cannot be
// reached. The runtime ends a run that keeps getting it; its
// BROWSER_UNAVAILABLE_EXIT_CODE must stay equal to this.
const BROWSER_UNAVAILABLE_EXIT_CODE = 75;
let actionOrdinal = 0;

// The browser could not be reached over CDP, or the run's page target is gone.
class BrowserUnavailableError extends Error {}

// The run's page as resolveExpectedPage last found it.
let resolvedPage = null;
// The page this command acts on: the page the person chose for the run
// (EXPECTED_BROWSER_PAGE_ID), or one of the tabs Octo opened in this run and
// selected (tabs.json). Snapshots, targets, approvals and the action feed are
// bound to it.
let activePageId = EXPECTED_BROWSER_PAGE_ID;

function inAgentTab() {
  return activePageId !== EXPECTED_BROWSER_PAGE_ID;
}

// Results from one of Octo's own tabs name it, with the label prompts,
// list_tabs and Studio all use for it.
function tabField() {
  return inAgentTab() ? { tabId: activePageId, tabLabel: tabName(activePageId) } : {};
}

// Each site's host patterns: "example.com" covers that host and its
// subdomains; "example.*" covers the label followed by one or two short
// public-suffix labels (example.de, www.example.co.uk). Null when the list is
// missing or malformed, which keeps Octo from opening, reading or acting on
// anything in any tab.
function linkOnlySitesFrom(data) {
  if (!data || data.schema !== "instafy.link-only-sites@1" || !Array.isArray(data.sites)) {
    return null;
  }
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  const sites = [];
  for (const site of data.sites) {
    const patterns = Array.isArray(site?.match) ? site.match : Array.isArray(site?.domains) ? site.domains : [];
    const matchers = [];
    for (const raw of patterns) {
      const pattern = String(raw || "").trim().toLowerCase().replace(/\.$/, "").replace(/^\*\./, "");
      if (!new RegExp(`^${label}(?:\\.${label})*(?:\\.\\*)?$`).test(pattern)) continue;
      // Escape every regex metacharacter, not only dots: the check above
      // already admits only labels and dots, this keeps it safe on its own.
      const escaped = pattern.replace(/\.\*$/, "").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      matchers.push(pattern.endsWith(".*")
        ? new RegExp(`(?:^|\\.)${escaped}\\.[a-z]{2,3}(?:\\.[a-z]{2,3})?$`)
        : new RegExp(`(?:^|\\.)${escaped}$`));
    }
    if (matchers.length) {
      sites.push({ name: String(site.name || patterns[0]).slice(0, 80), matchers });
    }
  }
  return sites.length ? sites : null;
}

// The link-only site an address is on, or null.
function linkOnlySiteOf(rawUrl) {
  let host;
  try {
    host = new URL(String(rawUrl)).hostname.toLowerCase().replace(/\.$/, "");
  } catch (_) {
    return null;
  }
  if (!host) return null;
  for (const site of LINK_ONLY_SITES || []) {
    if (site.matchers.some((matcher) => matcher.test(host))) return site.name;
  }
  return null;
}

const LIST_UNAVAILABLE_MESSAGE =
  "The link-only site list is unavailable, so Octo opens, reads and does nothing in any tab. Nothing was opened, read or done.";
const SEND_PAGE_HINT =
  'Give the person the plain link: they may open it themselves and, if they want Octo to see it, use "Send page to Octo".';

// Octo opens an address, in any tab, only when it is not on a site the skill
// keeps link-only, and only while that list is known. Called before any prompt.
function assertMayOpen(rawUrl) {
  if (LINK_ONLY_SITES === null) {
    throw new Error(LIST_UNAVAILABLE_MESSAGE);
  }
  const site = linkOnlySiteOf(rawUrl);
  if (site) {
    throw new Error(`${site} is link-only: Octo never opens it, in any tab. Nothing was opened. ${SEND_PAGE_HINT}`);
  }
}

// The link-only site a page is on, for list_tabs: "an unknown site" for every
// page while the list is unavailable.
function linkOnlySiteForPage(page) {
  if (isBlankPage(page)) return null;
  return LINK_ONLY_SITES === null ? "an unknown site" : linkOnlySiteOf(page.url());
}

function validatePlaywrightModulePath(modulePath, trustedRootPath) {
  const configuredModule = String(modulePath || "").trim();
  const configuredRoot = String(trustedRootPath || "").trim();
  if (!path.isAbsolute(configuredModule) || !path.isAbsolute(configuredRoot)) {
    throw new Error(
      "Shared Browser requires an absolute controller-provided Playwright module path",
    );
  }
  const trustedRoot = fs.realpathSync(configuredRoot);
  const resolvedModule = fs.realpathSync(configuredModule);
  if (path.relative(trustedRoot, resolvedModule) !== "playwright") {
    throw new Error(
      "Shared Browser Playwright module must be the trusted image-installed package",
    );
  }
  return resolvedModule;
}

function validateCdpUrl(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]";
  if (
    !loopback ||
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Shared Browser CDP endpoint must be a credential-free loopback URL");
  }
  return url.toString();
}

function validateBrowserPageId(raw) {
  const pageId = String(raw || "").trim();
  if (
    !pageId ||
    pageId.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(pageId)
  ) {
    throw new Error(
      "Shared Browser requires one controller-provided browserPageId CDP target",
    );
  }
  return pageId;
}

// A page on a link-only site is neither read nor used by Octo, in any tab:
// one of its own tabs, or the page the person chose, whether the person went
// there or the page moved there by itself. Octo may only take the tab
// elsewhere (navigate) or close one of its own. Refused before any prompt.
function refuseLinkOnlyPage(page) {
  if (LINK_ONLY_SITES === null) {
    throw new Error(LIST_UNAVAILABLE_MESSAGE);
  }
  const site = linkOnlySiteOf(page.url());
  if (site) {
    const where = inAgentTab() ? tabName(activePageId) : "The page the person chose";
    const leave = inAgentTab()
      ? "Octo may navigate the tab elsewhere or close it with close_tab."
      : "Octo may navigate the page elsewhere only if the person asked for that.";
    throw new Error(
      `${where} is now on ${site}, which is link-only, so nothing there was read or done. Ask the person to use "Send page to Octo" or to do this themselves. ${leave}`,
    );
  }
}

// The label of one of Octo's tabs: "Octo's tab <number>", with the number the
// tab was opened with. Prompts, list_tabs and Studio all show this label.
function tabName(tabId) {
  const tab = approvalProtocol.readTabs().tabs.find((entry) => entry.tabId === tabId);
  return tab ? `Octo's tab ${tab.number}` : "Octo's tab";
}

// Site and step approvals for the page this command acts on. In one of
// Octo's own tabs the prompt names the tab, a site approval holds for that
// tab only, and a step approval is bound to the tab as well as to its target.
function tabLabel(label) {
  return inAgentTab() ? `${tabName(activePageId)}: ${label}` : label;
}

function siteApproved(rawUrl) {
  return approvalProtocol.isOriginApproved(rawUrl, inAgentTab() ? activePageId : null);
}

async function ensureSiteApproved(rawUrl, label) {
  return await approvalProtocol.ensureOriginApproved(
    rawUrl,
    tabLabel(label),
    inAgentTab() ? activePageId : null,
  );
}

// Octo's own tabs are for reading: they take only the steps routine browsing
// takes without asking (reading, plain links, menus, ordinary clicks, typing
// that does not submit). A submission, a purchase, a message, a download, a
// commit button, an activation key or a risky address is refused there in
// every mode, before any prompt.
function refuseUnlessReadingStep(readingStep) {
  if (inAgentTab() && !readingStep) {
    throw new Error(
      "Octo's own tabs are for reading, so this step was not performed there. Leave it to the person, or take it on the page they chose when they asked for it.",
    );
  }
}

async function allowStepOnce(details, options) {
  if (!inAgentTab()) {
    return await approvalProtocol.allowOnce(details, options);
  }
  return await approvalProtocol.allowOnce({
    ...details,
    label: tabLabel(details.label),
    payloadFingerprint: approvalProtocol.sha256(
      JSON.stringify({ tabId: activePageId, payload: details.payloadFingerprint }),
    ),
  }, options);
}

function strictlyMasked(value) {
  return redaction.redactText(String(value || ""), { strict: true }).text;
}

const DISPLAY_URL_PATTERN = /https?:\/\/[^\s'"<>]+/gi;

// Text for the action log, approvals and errors. Anyone who can read the
// project sees the action log, so every random-looking run between addresses
// is masked here. An address is masked like the snapshot's own address, so it
// keeps its host and path ("Go to https://github.com/org/repo/pull/615").
function maskedDisplayText(value) {
  const text = String(value || "");
  let masked = "";
  let last = 0;
  for (const match of text.matchAll(DISPLAY_URL_PATTERN)) {
    masked += strictlyMasked(text.slice(last, match.index));
    let address;
    try {
      address = new URL(match[0]).hostname ? redaction.redactUrl(match[0]).text : strictlyMasked(match[0]);
    } catch (_) {
      address = strictlyMasked(match[0]);
    }
    masked += address;
    last = match.index + match[0].length;
  }
  return masked + strictlyMasked(text.slice(last));
}

function maskedUrl(value) {
  return value ? redaction.redactUrl(String(value)).text : null;
}

function emitAction(event) {
  try {
    fs.mkdirSync(path.dirname(ACTIONS_FILE), { recursive: true });
    fs.appendFileSync(
      ACTIONS_FILE,
      `${JSON.stringify({
        seq: Date.now() * 100 + ++actionOrdinal,
        ts: Date.now(),
        type: event.type,
        label: maskedDisplayText(event.label),
        url: maskedUrl(event.url),
        x: event.x ?? null,
        y: event.y ?? null,
        viewportW: event.viewportW ?? null,
        viewportH: event.viewportH ?? null,
        pageId: activePageId,
        ...(event.type === "human_input" ? { humanInputRequest: event.humanInputRequest } : {}),
      })}\n`,
    );
  } catch (_) {
    if (event.type === "human_input") throw new Error("Could not publish manual-input guidance");
    // Cursor/ticker telemetry must never change browser control flow.
  }
}

async function writeStdout(value) {
  await new Promise((resolve, reject) => {
    process.stdout.write(value, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function cdpTargetIdForPage(page) {
  const context = page.context();
  const session = await context.newCDPSession(page);
  try {
    const response = await session.send("Target.getTargetInfo");
    return String(response?.targetInfo?.targetId || "").trim();
  } finally {
    await session.detach().catch(() => {});
  }
}

// Every page in the browser by its CDP target id.
async function livePages(browser) {
  const pages = new Map();
  for (const page of browser.contexts().flatMap((context) => context.pages())) {
    const targetId = await cdpTargetIdForPage(page).catch(() => "");
    if (targetId && !pages.has(targetId)) {
      pages.set(targetId, page);
    }
  }
  return pages;
}

async function resolveExpectedPage(browser) {
  const page = (await livePages(browser)).get(activePageId);
  if (page) {
    resolvedPage = page;
    return page;
  }
  if (inAgentTab()) {
    // Not the browser going away: the person (or the page) closed the tab.
    throw new Error(
      "The tab Octo was using was closed, so nothing was done. Call list_tabs, then select_tab.",
    );
  }
  throw new BrowserUnavailableError(
    `Shared Browser selected page ${EXPECTED_BROWSER_PAGE_ID} is unavailable; select a live browser tab and retry`,
  );
}

// Whether a failed command failed because Instafy's browser or the run's tab
// went away: the connection dropped, the page Playwright resolved for this
// run closed, or the run's page target is no longer among the browser's
// pages. Playwright's own "closed" error carries the plain name "Error" and a
// message that can quote page markup, so the browser itself is asked instead.
// A check that does not finish in time proves nothing.
async function browserWentAway(browser) {
  if (!browser.isConnected()) {
    return true;
  }
  if (resolvedPage && resolvedPage.isClosed()) {
    return true;
  }
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), 5_000);
  });
  const pageGone = resolveExpectedPage(browser).then(
    () => false,
    (error) => error instanceof BrowserUnavailableError,
  );
  try {
    return await Promise.race([pageGone, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// Runs inside the page, joined into the page functions by withShownRule, so it
// must not use anything from this file's scope. It decides what a person can
// see. An element or a run of text is left out when it is not rendered or is
// transparent (checkVisibility with opacity and visibility), when it is under
// aria-hidden="true" or inert, when it lies wholly where the page cannot be
// scrolled to (a closed off-canvas drawer), or when a box it is laid out in
// clips it to nothing with overflow hidden or clip (a menu collapsed with
// max-height: 0). A scroll container with a real size only scrolls, so what it
// holds can be brought into its box and counts as reachable there. An open
// modal dialog or popover is drawn over the page, so no box around it clips it.
function shownRuleInPage() {
  // Less than half a pixel either way is nothing a person can see or click.
  const MIN_SIZE = 0.5;
  const VISIBILITY = {
    checkOpacity: true,
    opacityProperty: true,
    checkVisibilityCSS: true,
    visibilityProperty: true,
  };
  const styles = new Map();
  const boxes = new Map();
  const styleOf = (element) => {
    let style = styles.get(element);
    if (!style) {
      style = element.ownerDocument.defaultView.getComputedStyle(element);
      styles.set(element, style);
    }
    return style;
  };
  // The padding box, where overflow clips: the border box less its borders.
  const boxOf = (element) => {
    let box = boxes.get(element);
    if (!box) {
      const rect = element.getBoundingClientRect();
      const style = styleOf(element);
      const border = (value) => Number.parseFloat(value) || 0;
      const left = rect.left + border(style.borderLeftWidth);
      const top = rect.top + border(style.borderTopWidth);
      const right = Math.max(left, rect.right - border(style.borderRightWidth));
      const bottom = Math.max(top, rect.bottom - border(style.borderBottomWidth));
      box = { left, top, right, bottom, width: right - left, height: bottom - top };
      boxes.set(element, box);
    }
    return box;
  };
  const isElement = (node) => Boolean(node) && node.nodeType === 1;
  // The parent where the node renders: a slotted node's slot, a shadow
  // root's host, otherwise its DOM parent.
  const flatParent = (node) =>
    node.assignedSlot || node.parentElement || (node.parentNode && node.parentNode.host) || null;
  const hiddenFromPeople = (element) =>
    String(element.getAttribute("aria-hidden") || "").trim().toLowerCase() === "true" ||
    element.hasAttribute("inert");
  const rendered = (element, options = VISIBILITY) =>
    typeof element.checkVisibility === "function"
      ? element.checkVisibility(options)
      : styleOf(element).display !== "none" && styleOf(element).visibility === "visible";
  const overflowAxis = (overflow, size) => {
    const scrolls = overflow === "auto" || overflow === "scroll" || overflow === "overlay";
    if (overflow === "hidden" || overflow === "clip" || (scrolls && size < MIN_SIZE)) return "clip";
    return scrolls ? "scroll" : "";
  };
  const topLayer = new Map();
  // An open modal dialog or popover, or a fullscreen element, is drawn in the
  // top layer: over the viewport, whatever the boxes around it clip.
  const inTopLayer = (element) => {
    if (!topLayer.has(element)) {
      let found = false;
      for (const state of [":modal", ":popover-open", ":fullscreen"]) {
        try {
          found = found || element.matches(state);
        } catch (_) {
          // A browser without this state draws nothing of that kind there.
        }
      }
      topLayer.set(element, found);
    }
    return topLayer.get(element);
  };
  // Whether `rect`, laid out with `position` inside `from`, can be seen once
  // the page and its scroll containers are scrolled to it. Only the boxes that
  // contain it clip it: an absolutely positioned box escapes static ones, a
  // fixed one escapes all but a transformed or contained box, and nothing
  // outside a top-layer box clips what is in it.
  const reachable = (rect, from, startPosition, doc) => {
    if (!(rect.width >= MIN_SIZE && rect.height >= MIN_SIZE)) return false;
    let { left, top, right, bottom } = rect;
    let position = startPosition;
    for (
      let node = from;
      isElement(node) && node !== doc.body && node !== doc.documentElement;
      node = flatParent(node)
    ) {
      const style = styleOf(node);
      if (style.display === "contents") continue;
      const holdsFixed =
        style.transform !== "none" ||
        style.perspective !== "none" ||
        style.filter !== "none" ||
        (style.backdropFilter || "none") !== "none" ||
        /\b(?:layout|paint|strict|content)\b/.test(style.contain || "") ||
        /\b(?:transform|perspective|filter)\b/.test(style.willChange || "") ||
        (style.containerType || "normal") !== "normal";
      const holds =
        position === "fixed"
          ? holdsFixed
          : position === "absolute"
            ? holdsFixed || style.position !== "static"
            : true;
      if (holds) {
        position = style.position;
        const box = boxOf(node);
        const x = overflowAxis(style.overflowX, box.width);
        const y = overflowAxis(style.overflowY, box.height);
        if (x === "clip") {
          left = Math.max(left, box.left);
          right = Math.min(right, box.right);
        } else if (x === "scroll") {
          left = box.left;
          right = box.right;
        }
        if (y === "clip") {
          top = Math.max(top, box.top);
          bottom = Math.min(bottom, box.bottom);
        } else if (y === "scroll") {
          top = box.top;
          bottom = box.bottom;
        }
        if (right - left < MIN_SIZE || bottom - top < MIN_SIZE) return false;
      }
      if (inTopLayer(node)) {
        position = "fixed";
        break;
      }
    }
    const view = doc.defaultView;
    const width = view.innerWidth;
    const height = view.innerHeight;
    const across = Math.min(right, width) - Math.max(left, 0);
    if (position === "fixed") {
      return across >= MIN_SIZE && Math.min(bottom, height) - Math.max(top, 0) >= MIN_SIZE;
    }
    // The page scrolls from its start, so nothing above it, or before it in
    // the writing direction, can be scrolled to.
    if (bottom + view.scrollY < MIN_SIZE) return false;
    const root = styleOf(doc.documentElement);
    if (root.direction === "rtl" ? left + view.scrollX > width - MIN_SIZE : right + view.scrollX < MIN_SIZE) {
      return false;
    }
    // A page that hides sideways overflow cannot be scrolled sideways. The
    // body's overflow is the page's when the root leaves its own visible.
    const body = doc.body ? styleOf(doc.body) : null;
    const pageOverflowX =
      root.overflowX === "visible" && root.overflowY === "visible" && body ? body.overflowX : root.overflowX;
    return !((pageOverflowX === "hidden" || pageOverflowX === "clip") && across < MIN_SIZE);
  };
  // The nearest box at or above `element`: a display: contents element (a
  // slot, for one) has none of its own.
  const boxed = (element) => {
    let node = element;
    while (isElement(node) && styleOf(node).display === "contents") node = flatParent(node);
    return isElement(node) ? node : null;
  };
  const renderedText = new Map();
  // Whether text laid out in `element` is rendered and opaque. Cached, since
  // a page has many runs of text per element.
  const textRendered = (element) => {
    const box = boxed(element);
    if (!box) return true;
    if (!renderedText.has(box)) renderedText.set(box, rendered(box));
    return renderedText.get(box);
  };
  const elementShown = (element) => {
    for (let node = element; isElement(node); node = flatParent(node)) {
      if (hiddenFromPeople(node)) return false;
    }
    const doc = element.ownerDocument;
    const rect = element.getBoundingClientRect();
    // A control drawn in the top layer itself is judged against the viewport.
    const drawnOnTop = inTopLayer(element);
    const from = drawnOnTop ? null : flatParent(element);
    const position = drawnOnTop ? "fixed" : styleOf(element).position;
    if (rendered(element) && reachable(rect, from, position, doc)) return true;
    // A native control that something else draws is still what a person
    // operates: checkbox and switch libraries lay it transparent over the
    // styled one, and a visually hidden one is operated through its label.
    // Only one Playwright can act on (rendered, visible, with a box) counts.
    if (
      !["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName) ||
      !rendered(element, { checkVisibilityCSS: true, visibilityProperty: true }) ||
      !(rect.width > 0 && rect.height > 0)
    ) {
      return false;
    }
    const parent = boxed(flatParent(element));
    if ((!parent || rendered(parent)) && reachable(rect, from, position, doc)) return true;
    return Array.from(element.labels || []).some((label) => elementShown(label));
  };
  return { styleOf, isElement, flatParent, hiddenFromPeople, reachable, textRendered, elementShown };
}

// Runs inside the page (see withShownRule). The text a person can see, in
// reading order, judged by the same rule as the controls. Block boundaries
// become line breaks and table cells tabs, as in innerText; a closed select
// shows its chosen option as a word of its own. Field values are never read,
// and open shadow roots are read where they render.
function shownTextInPage(rule, request) {
  const doc = document;
  if (!doc.body) return "";
  const limit = Number.isSafeInteger(request && request.limit) ? request.limit : 60_000;
  const skipped = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "IFRAME", "FRAME",
    "OBJECT", "EMBED", "VIDEO", "AUDIO", "CANVAS",
  ]);
  const blockLevel = (display) =>
    display !== "table-cell" && /^(?:block|flex|grid|list-item|table|flow-root|-webkit-box)/.test(display);
  const range = doc.createRange();
  const lines = [];
  let line = "";
  let size = 0;
  const flush = () => {
    const finished = line.replace(/\s+$/, "");
    if (finished.trim()) {
      lines.push(finished);
      size += finished.length + 1;
    }
    line = "";
  };
  const add = (value, preserve) => {
    const next = preserve || (line.trim() && !/\s$/.test(line)) ? value : value.replace(/^ +/, "");
    line += next;
  };
  const space = () => {
    if (line && !/\s$/.test(line)) line += " ";
  };
  const text = (node) => {
    const parent = rule.flatParent(node);
    const raw = node.nodeValue || "";
    if (!rule.isElement(parent) || !raw) return;
    const style = rule.styleOf(parent);
    if (style.visibility !== "visible") return;
    if (!raw.trim()) {
      space();
      return;
    }
    if (!rule.textRendered(parent)) return;
    range.selectNodeContents(node);
    if (!rule.reachable(range.getBoundingClientRect(), parent, "static", doc)) return;
    const preserve = /^(?:pre|pre-wrap|break-spaces)$/.test(style.whiteSpace);
    const pieces = preserve || style.whiteSpace === "pre-line" ? raw.split("\n") : [raw];
    pieces.forEach((piece, index) => {
      if (index > 0) flush();
      add(preserve ? piece : piece.replace(/\s+/g, " "), preserve);
    });
  };
  const select = (element) => {
    const options = Array.from(element.options || []);
    const chosen = element.multiple || element.size > 1 ? options : Array.from(element.selectedOptions || []);
    const value = chosen
      .map((option) => String(option.label || option.text || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(", ");
    if (value && rule.elementShown(element)) {
      space();
      add(value, false);
      space();
    }
  };
  const walk = (node, depth) => {
    if (size + line.length >= limit || depth > 512) return;
    if (node.nodeType === 3) {
      text(node);
      return;
    }
    if (!rule.isElement(node) || skipped.has(node.tagName)) return;
    const style = rule.styleOf(node);
    // Hidden and transparent subtrees stay unseen whatever their contents say.
    if (style.display === "none" || rule.hiddenFromPeople(node) || Number.parseFloat(style.opacity) === 0) {
      return;
    }
    const block = blockLevel(style.display) || node.tagName === "BR";
    if (block) flush();
    if (style.display === "table-cell" && line.trim()) line = `${line.replace(/ +$/, "")}\t`;
    if (node.tagName === "SELECT") {
      select(node);
    } else if (style.contentVisibility !== "hidden") {
      const children = node.shadowRoot
        ? node.shadowRoot.childNodes
        : node.tagName === "SLOT"
          ? node.assignedNodes({ flatten: true })
          : node.childNodes;
      for (const child of children) walk(child, depth + 1);
    }
    if (block) flush();
  };
  walk(doc.body, 0);
  flush();
  return lines.join("\n");
}

// Runs inside the page through Playwright, so it must not use anything from
// this file's scope. It reads attributes and structure around the element,
// never field values; `policy` holds the structural facts the step classifier
// needs, the same ones the Desktop Personal Browser collects. A control a
// person cannot see is reported only as `shown: false` with its name, which
// the secret-screen check still reads.
function describeInPage(rule, element, sources) {
  const bounded = (value, max = 2_000) =>
    typeof value === "string"
      ? value.replace(/\s+/g, " ").trim().slice(0, max)
      : "";
  const labels = bounded(
    "labels" in element && element.labels
      ? Array.from(element.labels)
          .map((label) => label.textContent || "")
          .join(" ")
      : "",
  );
  const ariaLabelledBy = bounded(element.getAttribute("aria-labelledby"));
  const ariaLabelledByText = bounded(
    [...new Set(ariaLabelledBy.split(/\s+/).filter(Boolean))]
      .slice(0, 32)
      .map((id) => element.ownerDocument?.getElementById(id)?.textContent || "")
      .join(" "),
  );
  let shown = true;
  try {
    shown = rule.elementShown(element);
  } catch (_) {
    // A control the rule cannot judge stays listed when it is rendered.
    try {
      shown = element.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true }) !== false;
    } catch (_) {
      shown = true;
    }
  }
  if (!shown) {
    const image = element.querySelector("img[alt]");
    return {
      shown: false,
      name: bounded(
        [
          element.getAttribute("aria-label"), ariaLabelledByText, labels,
          element.getAttribute("placeholder"), element.getAttribute("title"),
          element.textContent, element.getAttribute("name"),
          element.getAttribute("data-bs-original-title"), element.getAttribute("data-original-title"),
          element.getAttribute("data-tippy-content"), element.getAttribute("data-tooltip"),
          image ? image.getAttribute("alt") : "",
        ].filter((value) => typeof value === "string" && value.trim()).join(" "),
        4_000,
      ),
    };
  }
  const form =
    "form" in element && element.form
      ? element.form
      : element instanceof HTMLElement
        ? element.closest("form")
        : null;
  const formAction = bounded(
    form ? form.getAttribute("action") || form.action || "" : "",
    4_096,
  );
  const formMethod = bounded(
    form ? form.getAttribute("method") || form.method || "get" : "",
    32,
  );
  const formText = bounded(form ? form.textContent || "" : "");

  const policyFacts = () => {
    const attribute = (node, name) =>
      node && typeof node.getAttribute === "function" ? node.getAttribute(name) : null;
    const tagOf = (node) =>
      node && typeof node.tagName === "string" ? node.tagName.toUpperCase() : "";
    const roleOf = (node) => bounded(attribute(node, "role"), 64).toLowerCase();
    const textOf = (node, max) =>
      bounded(
        node && typeof node.textContent === "string" ? node.textContent.slice(0, 4_000) : "",
        max,
      );
    const idText = (node, name) =>
      bounded(attribute(node, name))
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 32)
        .map((id) => node.ownerDocument?.getElementById(id)?.textContent || "")
        .join(" ");
    const credentialPattern = new RegExp(sources.credentialContext, "iu");
    const maskedPattern = new RegExp(sources.maskedText, "u");
    const headingSelector = "h1, h2, h3, h4, h5, h6, [role='heading'], legend, caption";
    const dialogSelector = "dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']";
    const isRow = (node) =>
      ["TR", "LI", "DT", "DD"].includes(tagOf(node)) ||
      ["row", "listitem", "option", "gridcell", "treeitem", "article"].includes(roleOf(node));

    // Enclosing areas, the nearest dialog's label and the nearest row.
    const areas = [];
    let dialogLabel = "";
    let row = isRow(element) ? element : null;
    for (
      let node = element.parentElement, depth = 0;
      node && depth < 64;
      node = node.parentElement, depth += 1
    ) {
      const role = roleOf(node);
      const tag = tagOf(node);
      let area = "";
      if (tag === "DIALOG" || role === "dialog" || role === "alertdialog" || attribute(node, "aria-modal") === "true") {
        area = "dialog";
      } else if (tag === "SEARCH" || role === "search") {
        area = "search";
      } else if (
        /pagination|pager|paginat|seitennavigation/i.test(
          [attribute(node, "aria-label"), attribute(node, "class"), attribute(node, "data-testid")]
            .filter(Boolean)
            .join(" "),
        )
      ) {
        area = "pagination";
      } else if (tag === "NAV" || role === "navigation") {
        area = "nav";
      } else if (["menu", "menubar", "tree", "tablist"].includes(role)) {
        area = role;
      }
      if (area && !areas.includes(area)) areas.push(area);
      if (area === "dialog" && !dialogLabel) {
        const heading = typeof node.querySelector === "function" ? node.querySelector(headingSelector) : null;
        dialogLabel = bounded(
          attribute(node, "aria-label") || idText(node, "aria-labelledby") || (heading ? heading.textContent || "" : ""),
          200,
        );
      }
      if (!row && isRow(node)) row = node;
    }

    // The nearest heading before the element, within six levels of it and not
    // inside a dialog the element is outside of.
    let heading = "";
    const headings = Array.from(document.querySelectorAll(headingSelector));
    let low = 0;
    let high = headings.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const candidate = headings[middle];
      // 4 is DOCUMENT_POSITION_FOLLOWING: the element comes after the heading.
      if (candidate === element || (candidate.compareDocumentPosition(element) & 4) !== 0) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    let scope = element;
    for (let depth = 0; depth < 6 && scope.parentElement; depth += 1) scope = scope.parentElement;
    for (let index = found, steps = 0; index >= 0 && steps < 25; index -= 1, steps += 1) {
      const candidate = headings[index];
      if (candidate === element) continue;
      if (!scope.contains(candidate)) break;
      const dialog = candidate.closest(dialogSelector);
      if (dialog && !dialog.contains(element)) continue;
      heading = textOf(candidate, 200);
      break;
    }

    // The column header of the element's table cell, or the header row for a
    // row target.
    let header = "";
    if (tagOf(row) === "TR") {
      const table = row.closest("table");
      const headerRow = table
        ? table.tHead?.rows?.[0] ??
          Array.from(table.rows ?? []).find((candidate) => candidate.querySelector("th"))
        : null;
      if (headerRow && headerRow !== row) {
        if (element === row) {
          header = bounded(Array.from(headerRow.cells ?? []).map((cell) => cell.textContent || "").join(" "), 200);
        } else {
          const cell = element.closest("td, th");
          if (cell && cell.parentElement === row && Number.isInteger(cell.cellIndex)) {
            header = textOf(headerRow.cells?.[cell.cellIndex], 200);
          }
        }
      }
    }
    const rowText = row ? textOf(row, 500) : "";

    // Masked text counts only in the element's row or a small container
    // around it, never a whole card or page.
    const smallMasked = (node) => {
      const raw = node && typeof node.textContent === "string" ? node.textContent : "";
      return raw.length <= 400 && maskedPattern.test(bounded(raw));
    };
    let nearMaskedText = false;
    for (
      let node = element.parentElement, depth = 0;
      node && depth < 3 && !nearMaskedText;
      node = node.parentElement, depth += 1
    ) {
      nearMaskedText = smallMasked(node);
    }
    if (!nearMaskedText && row && row !== element) nearMaskedText = smallMasked(row);

    const iconChild = element.querySelector("svg, i, img, use");
    const iconHint = bounded(
      [
        attribute(element, "class"), attribute(element, "data-icon"), attribute(element, "data-testid"),
        attribute(iconChild, "class"), attribute(iconChild, "aria-label"), attribute(iconChild, "alt"),
        attribute(iconChild, "data-icon"), attribute(iconChild, "href"),
      ].filter(Boolean).join(" "),
      160,
    );
    const link = element.closest("a[href]");
    const expanded = attribute(element, "aria-expanded") ?? attribute(link, "aria-expanded");
    const popup = attribute(element, "aria-haspopup");
    // A control that names the region it shows or hides (aria-controls), or
    // a Bootstrap-style collapse, dropdown or offcanvas toggle, opens part of
    // the page the way an aria-expanded opener does.
    const controlsRegion = bounded(attribute(element, "aria-controls"), 200)
      .split(/\s+/)
      .some((id) => id && Boolean(element.ownerDocument?.getElementById(id)));
    const toggleKind = bounded(
      attribute(element, "data-bs-toggle") || attribute(element, "data-toggle") || "",
      32,
    ).toLowerCase();
    const pageToggle = ["collapse", "dropdown", "offcanvas", "sidebar"].includes(toggleKind);

    const controls = form ? Array.from(form.elements || []) : [];
    const isSubmit = (control) =>
      control.form === form &&
      ((control instanceof HTMLButtonElement && control.type === "submit") ||
        (control instanceof HTMLInputElement && ["submit", "image"].includes(control.type)));
    const submitLabel = (control) =>
      bounded(control.getAttribute("aria-label") || control.textContent || control.getAttribute("value") || "", 80);
    const submit = controls.find(isSubmit) ?? null;
    const editableTypes = ["", "text", "search", "email", "url", "tel", "number", "password", "date", "time", "datetime-local", "month", "week"];
    const isPassword = (control) =>
      control instanceof HTMLInputElement && String(control.type || "").toLowerCase() === "password";
    const firstPassword = controls.findIndex(isPassword);
    const identifier = firstPassword > 0
      ? controls.slice(0, firstPassword).reverse().find((control) =>
        control instanceof HTMLInputElement && ["", "text", "email", "tel"].includes(String(control.type || "").toLowerCase()))
      : null;
    const formPasswordCount = controls.filter(isPassword).length;
    return {
      href: link instanceof HTMLAnchorElement ? bounded(link.href, 4_096) : "",
      linkSelf: link instanceof HTMLAnchorElement && link === element,
      download: link instanceof HTMLAnchorElement && link.getAttribute("download") !== null,
      formActionUrl: form ? bounded(typeof form.action === "string" ? form.action : attribute(form, "action") || "", 4_096) : "",
      formName: form
        ? bounded(
          (submit ? submitLabel(submit) : "") ||
            attribute(form, "aria-label") || idText(form, "aria-labelledby") ||
            attribute(form, "title") || attribute(form, "name") || "this form",
          200,
        )
        : "",
      formSubmitLabels: bounded(controls.filter(isSubmit).map(submitLabel).filter(Boolean).join(" | "), 200),
      formHasPassword: formPasswordCount > 0,
      formPasswordCount,
      formFieldCount: controls.filter((control) =>
        control.form === form && (
          (control instanceof HTMLInputElement && editableTypes.includes(String(control.type || "").toLowerCase())) ||
          control instanceof HTMLTextAreaElement ||
          String(control.tagName || "").toUpperCase() === "SELECT"
        )).length,
      signInIdentifier: Boolean(identifier) && identifier === element,
      contentEditable: element.isContentEditable === true,
      areas: areas.join(" "),
      menuOpener: expanded !== null || (popup !== null && popup !== "false") || controlsRegion || pageToggle,
      credentialContext: credentialPattern.test([dialogLabel, heading, header, rowText].join(" ")),
      row: Boolean(row),
      nearMaskedText,
      iconHint,
    };
  };
  let policy = null;
  try {
    policy = policyFacts();
  } catch (_) {
    // Missing facts make every step ask.
    policy = null;
  }

  // Hints for naming a control the page left unnamed (an avatar or icon
  // button), so a prompt reads "profile picture button in the top right"
  // rather than an index. Attributes, image text and geometry only: never a
  // field value or nearby page text.
  let nameHints = null;
  try {
    const read = (node, name) =>
      node && typeof node.getAttribute === "function" ? node.getAttribute(name) : null;
    const image = element.querySelector(
      "img[alt], [role='img'][aria-label], svg title, svg[aria-label], i[aria-label], i[title], span[aria-hidden='true'][title]",
    );
    const imageTag = image && typeof image.tagName === "string" ? image.tagName.toLowerCase() : "";
    const imageText = !image
      ? ""
      : imageTag === "img"
        ? read(image, "alt")
        : imageTag === "title"
          ? image.textContent
          : read(image, "aria-label") || read(image, "title");
    const describedBy = bounded(read(element, "aria-describedby"))
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)
      .map((id) => element.ownerDocument?.getElementById(id)?.textContent || "")
      .join(" ");
    const view = element.ownerDocument?.defaultView;
    const rect = element.getBoundingClientRect();
    const width = view?.innerWidth || 0;
    const height = view?.innerHeight || 0;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    let position = "";
    if (width > 0 && height > 0 && x >= 0 && x <= width && y >= 0 && y <= height) {
      const row = y < height / 4 ? "top" : y > (3 * height) / 4 ? "bottom" : "";
      const column = x < width / 3 ? "left" : x > (2 * width) / 3 ? "right" : "";
      position = [row, column].filter(Boolean).join(" ") || "middle";
    }
    nameHints = {
      tooltip: bounded(
        read(element, "data-bs-original-title") || read(element, "data-original-title") ||
          read(element, "data-tippy-content") || read(element, "data-tooltip") ||
          read(element, "data-tip") || read(element, "aria-description") || "",
        120,
      ),
      describedBy: bounded(describedBy, 120),
      image: bounded(imageText || "", 120),
      hasImage:
        Boolean(element.querySelector("img, picture, [role='img']")) ||
        /url\(/.test(view?.getComputedStyle(element).backgroundImage || ""),
      position,
    };
  } catch (_) {
    nameHints = null;
  }

  // Whether a toggle is open, and the part of the page the control sits in,
  // for reading the page; neither feeds the step policy.
  let expanded = null;
  let area = "";
  try {
    const state = bounded(element.getAttribute("aria-expanded"), 16).toLowerCase();
    if (state === "true" || state === "false") {
      expanded = state === "true";
    } else if (element.tagName === "SUMMARY" && element.parentElement?.tagName === "DETAILS") {
      expanded = element.parentElement.open === true;
    }
    const sectioned = (node) =>
      Boolean(node.parentElement?.closest(
        "article, aside, main, nav, section, [role='article'], [role='complementary'], [role='main'], [role='navigation'], [role='region']",
      ));
    for (
      let node = rule.flatParent(element), depth = 0;
      rule.isElement(node) && depth < 64 && !area;
      node = rule.flatParent(node), depth += 1
    ) {
      const tag = node.tagName;
      const role = bounded(node.getAttribute("role"), 64).toLowerCase();
      if (tag === "MAIN" || role === "main") break;
      if (tag === "DIALOG" || role === "dialog" || role === "alertdialog" || node.getAttribute("aria-modal") === "true") {
        area = "dialog";
      } else if (role === "menu" || role === "menubar") {
        area = "menu";
      } else if (role === "tablist") {
        area = "tabs";
      } else if (tag === "NAV" || role === "navigation") {
        area = "nav";
      } else if (tag === "SEARCH" || role === "search") {
        area = "search";
      } else if (role === "banner" || (tag === "HEADER" && !sectioned(node))) {
        area = "header";
      } else if (role === "contentinfo" || (tag === "FOOTER" && !sectioned(node))) {
        area = "footer";
      } else if (tag === "ASIDE" || role === "complementary") {
        area = "aside";
      }
    }
  } catch (_) {
    expanded = null;
    area = "";
  }

  return {
    shown: true,
    expanded,
    area,
    tag: bounded(element.tagName.toLowerCase(), 64),
    role: bounded(element.getAttribute("role"), 128),
    idAttribute: bounded(element.getAttribute("id")),
    ariaLabel: bounded(element.getAttribute("aria-label")),
    ariaLabelledBy,
    ariaLabelledByText,
    placeholder: bounded(element.getAttribute("placeholder")),
    nameAttribute: bounded(element.getAttribute("name")),
    titleAttribute: bounded(element.getAttribute("title")),
    valueAttribute: bounded(element.getAttribute("value")),
    href: element instanceof HTMLAnchorElement ? bounded(element.href, 4_096) : "",
    inputType:
      element instanceof HTMLInputElement || element instanceof HTMLButtonElement
        ? bounded(element.type, 64)
        : "",
    autocomplete: bounded(element.getAttribute("autocomplete"), 512),
    inputMode: bounded(element.getAttribute("inputmode"), 64),
    formAction,
    formMethod,
    formActionText: form
      ? `form ${formMethod} ${formAction} ${formText}`.slice(0, 2_000)
      : "",
    labels,
    text: bounded(element.textContent || ""),
    policy,
    nameHints,
  };
}

// Bounds and types the page's naming hints; anything malformed is empty.
const NAME_POSITIONS = new Set([
  "top left", "top right", "bottom left", "bottom right", "top", "bottom", "left", "right", "middle",
]);
function nameHintsOf(raw) {
  const valid = raw && typeof raw === "object" && !Array.isArray(raw);
  const text = (value, max) => (valid && typeof value === "string" ? value.slice(0, max) : "");
  return {
    tooltip: text(raw?.tooltip, 120),
    describedBy: text(raw?.describedBy, 120),
    image: text(raw?.image, 120),
    hasImage: valid && raw.hasImage === true,
    position: valid && NAME_POSITIONS.has(raw.position) ? raw.position : "",
  };
}

// The hints that name a control, without the ones that change while a
// person hovers (described-by tooltips) or the layout moves (position), so
// fingerprints stay stable across an approval.
function stableNameHints(description) {
  const hints = description.nameHints || nameHintsOf(null);
  return { tooltip: hints.tooltip, image: hints.image, hasImage: hints.hasImage };
}

// Page functions run inside the page: Playwright sends their source, so they
// cannot use anything from this file's scope. The two that judge what a
// person can see get the rule's source joined in front, so controls and text
// are judged by one copy of it. Only this file's own functions are joined.
function withShownRule(pageFunction) {
  return new Function("...args", `return (${pageFunction})((${shownRuleInPage})(), ...args);`);
}
const DESCRIBE_IN_PAGE = withShownRule(describeInPage);
const SHOWN_TEXT_IN_PAGE = withShownRule(shownTextInPage);
const AREA_NAMES = new Set(["dialog", "menu", "tabs", "nav", "search", "header", "footer", "aside"]);

// `hiddenNames` collects one name, empty when it has none, for each control a
// person cannot see; they are left out of the observation but still count for
// the secret-screen check, and their number tells the model some are left out.
async function describeElement(locator, index, hiddenNames) {
  const attributes = await locator
    .evaluate(DESCRIBE_IN_PAGE, PAGE_POLICY_SOURCES)
    .catch(() => null);
  if (attributes && attributes.shown === false) {
    if (hiddenNames) {
      hiddenNames.push(typeof attributes.name === "string" ? attributes.name.slice(0, 4_000) : "");
    }
    return null;
  }
  const box = await locator.boundingBox().catch(() => null);
  if (!attributes || !box) {
    return null;
  }
  const policy = policyFactsOf(attributes.policy);
  const nameHints = nameHintsOf(attributes.nameHints);
  const named = [
    attributes.ariaLabel,
    attributes.ariaLabelledByText,
    attributes.labels,
    attributes.placeholder,
    attributes.titleAttribute,
    attributes.text,
    attributes.nameAttribute,
  ]
    .find((value) => typeof value === "string" && value.trim())
    ?.trim();
  // An unnamed control gets a name from its own hints, never its index: the
  // index means nothing to the person reading a prompt.
  const label = (
    named ||
    actionPolicy.unnamedControlName({
      tag: attributes.tag,
      role: attributes.role,
      type: attributes.inputType,
      ...nameHints,
      iconHint: policy ? policy.iconHint : "",
    })
  ).slice(0, MAX_LABEL_CHARS);
  return {
    index,
    label,
    tag: attributes.tag,
    role: attributes.role,
    idAttribute: attributes.idAttribute,
    ariaLabel: attributes.ariaLabel,
    ariaLabelledBy: attributes.ariaLabelledBy,
    ariaLabelledByText: attributes.ariaLabelledByText,
    placeholder: attributes.placeholder,
    nameAttribute: attributes.nameAttribute,
    titleAttribute: attributes.titleAttribute,
    valueAttribute: attributes.valueAttribute,
    labels: attributes.labels,
    text: attributes.text,
    href: attributes.href,
    inputType: attributes.inputType,
    autocomplete: attributes.autocomplete,
    inputMode: attributes.inputMode,
    formAction: attributes.formAction,
    formMethod: attributes.formMethod,
    formActionText: attributes.formActionText,
    policy,
    nameHints,
    expanded: typeof attributes.expanded === "boolean" ? attributes.expanded : null,
    area: AREA_NAMES.has(attributes.area) ? attributes.area : "",
    box: {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    },
  };
}

// Bounds and types the page's answers; anything malformed counts as missing.
function policyFactsOf(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 10_000) : 0);
  return {
    href: text(raw.href, MAX_URL_CHARS),
    linkSelf: raw.linkSelf === true,
    download: raw.download === true,
    formActionUrl: text(raw.formActionUrl, MAX_URL_CHARS),
    formName: text(raw.formName, 200),
    formSubmitLabels: text(raw.formSubmitLabels, 200),
    formHasPassword: raw.formHasPassword === true,
    formPasswordCount: count(raw.formPasswordCount),
    formFieldCount: count(raw.formFieldCount),
    signInIdentifier: raw.signInIdentifier === true,
    contentEditable: raw.contentEditable === true,
    areas: text(raw.areas, 200),
    menuOpener: raw.menuOpener === true,
    credentialContext: raw.credentialContext === true,
    row: raw.row === true,
    nearMaskedText: raw.nearMaskedText === true,
    iconHint: text(raw.iconHint, 160),
  };
}

// The classifier's view of one observed element.
function policyTarget(description) {
  const facts = description.policy || {};
  const tag = String(description.tag || "").toLowerCase();
  const type = String(description.inputType || "").toLowerCase();
  const buttonLike =
    tag === "button" || (tag === "input" && ["button", "submit", "reset", "image"].includes(type));
  const hints = description.nameHints || nameHintsOf(null);
  return {
    tag,
    role: description.role || "",
    type,
    // An image's alt text is part of a button's accessible name, and a
    // tooltip library keeps the title in data-bs-original-title, so their
    // risk words count like any other name's.
    ariaLabel: description.ariaLabel || description.ariaLabelledByText || description.labels || hints.image || "",
    text: description.text || "",
    title: description.titleAttribute || hints.tooltip || "",
    value: buttonLike ? description.valueAttribute || "" : "",
    placeholder: description.placeholder || "",
    name: description.nameAttribute || "",
    id: description.idAttribute || "",
    autocomplete: description.autocomplete || "",
    href: facts.href || "",
    linkSelf: facts.linkSelf === true,
    download: facts.download === true,
    formOwnerIdentity: description.formMethod ? "form" : "",
    formMethod: String(description.formMethod || "").toLowerCase(),
    formActionUrl: facts.formActionUrl || "",
    formActionText: facts.formName || "",
    formSubmitLabels: facts.formSubmitLabels || "",
    formHasPassword: facts.formHasPassword === true,
    formPasswordCount: facts.formPasswordCount || 0,
    formFieldCount: facts.formFieldCount || 0,
    signInIdentifier: facts.signInIdentifier === true,
    contentEditable: facts.contentEditable === true,
    areas: facts.areas || "",
    menuOpener: facts.menuOpener === true,
    credentialContext: facts.credentialContext === true,
    row: facts.row === true,
    nearMaskedText: facts.nearMaskedText === true,
    iconHint: facts.iconHint || "",
  };
}

function classifyStep(op, description, context) {
  try {
    return actionPolicy.classifyStep(op, description ? policyTarget(description) : {}, context);
  } catch (_) {
    return { verdict: "ask", category: "change", reason: "classification failed" };
  }
}

// Revealing or copying a credential, signing in and choosing files are the
// user's steps in every mode. Refused before any prompt is shown.
function refuseUserStep(classification) {
  if (classification.verdict !== "refuse") {
    return;
  }
  const refusal = actionPolicy.refusalFor(classification.category);
  const message = refusal ? refusal.message : "This step is the user's.";
  throw new Error(`${message} [${classification.code || "step_refused"}]`);
}

// Under routine browsing a step still asks when its category is named, when
// its label commits a change ("Save", "Speichern", "Buchen"), when the older
// consequential pattern matches, or when the page's structural facts are
// missing. A commit button run by page script has no form for the submission
// checks to see, so its label is what tells it apart from an ordinary click.
function routineCovers(classification, description, { consequential = true } = {}) {
  if (!description.policy) {
    return false;
  }
  if (classification.verdict === "ask" && ROUTINE_CONFIRMED_CATEGORIES.has(classification.category)) {
    return false;
  }
  if (classification.verdict === "ask" && classification.commit === true) {
    return false;
  }
  return !consequential || !isConsequentialAction(description);
}

function approvalCategoryTitle(classification) {
  return actionPolicy.categoryTitle(classification.category) || "";
}

// The masked control name for prompts and the action log. Both labels are
// shown when the accessible name and visible text differ.
function controlLabel(description) {
  const labels = actionPolicy.stepLabels(policyTarget(description));
  const bounded = (value) => Array.from(String(value || "")).slice(0, MAX_LABEL_CHARS).join("");
  const label = labels.differ
    ? `${bounded(labels.accessible)} (shown as "${bounded(labels.visible)}")`
    : description.label;
  return maskedDisplayText(label);
}

// The controls a person can see, in document order. Snapshots and actions
// both index this list, so an index means the same control in both.
async function collectInteractiveElements(page, hiddenNames = null) {
  const matches = page.locator(INTERACTIVE_SELECTOR);
  const count = Math.min(await matches.count(), MAX_INTERACTIVE_ELEMENTS * 3);
  const elements = [];
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    const locator = await matches.nth(ordinal).elementHandle().catch(() => null);
    if (!locator) {
      continue;
    }
    // The shown rule in describeInPage covers what Playwright's isVisible
    // checks (rendered, visibility visible, a box with a size).
    const description = await describeElement(locator, elements.length, hiddenNames);
    if (!description) {
      continue;
    }
    elements.push({ locator, description });
    if (elements.length >= MAX_INTERACTIVE_ELEMENTS) {
      break;
    }
  }
  return elements;
}

function snapshotFingerprint(url, interactive) {
  // A restored conversation must observe again after human input or a new
  // control lease, even when the URL and element descriptors are unchanged.
  const { ownerId, runId } = approvalProtocol.authority();
  const elements = interactive.map(({ description }) => ({
    index: description.index,
    tag: description.tag,
    role: description.role,
    idAttribute: description.idAttribute,
    ariaLabel: description.ariaLabel,
    ariaLabelledBy: description.ariaLabelledBy,
    ariaLabelledByText: description.ariaLabelledByText,
    placeholder: description.placeholder,
    nameAttribute: description.nameAttribute,
    titleAttribute: description.titleAttribute,
    valueAttribute: description.valueAttribute,
    labels: description.labels,
    text: description.text,
    href: description.href,
    inputType: description.inputType,
    autocomplete: description.autocomplete,
    inputMode: description.inputMode,
    formAction: description.formAction,
    formMethod: description.formMethod,
    formActionText: description.formActionText,
    policy: description.policy,
    nameHints: stableNameHints(description),
  }));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ ownerId, runId, pageId: activePageId, url, elements }))
    .digest("hex");
}

function targetFingerprint(description) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        pageId: activePageId,
        tag: description.tag,
        role: description.role,
        idAttribute: description.idAttribute,
        ariaLabel: description.ariaLabel,
        ariaLabelledBy: description.ariaLabelledBy,
        ariaLabelledByText: description.ariaLabelledByText,
        placeholder: description.placeholder,
        nameAttribute: description.nameAttribute,
        titleAttribute: description.titleAttribute,
        valueAttribute: description.valueAttribute,
        labels: description.labels,
        text: description.text,
        href: description.href,
        inputType: description.inputType,
        autocomplete: description.autocomplete,
        inputMode: description.inputMode,
        formAction: description.formAction,
        formMethod: description.formMethod,
        formActionText: description.formActionText,
        policy: description.policy,
        nameHints: stableNameHints(description),
      }),
    )
    .digest("hex");
}

// What the model reads about one control. Empty fields are left out to keep
// the observation small; the box stays internal, where the visible cursor
// uses it.
function publicElementDescription(description) {
  const entry = { index: description.index, label: description.label, tag: description.tag };
  for (const field of ["role", "href", "inputType", "autocomplete", "area"]) {
    if (typeof description[field] === "string" && description[field]) {
      entry[field] = description[field];
    }
  }
  if (typeof description.expanded === "boolean") {
    entry.expanded = description.expanded;
  }
  return entry;
}

// A masked link on the page's own site, as its path. Masking keeps the scheme
// and host, so the path is a suffix of what would be shown in full.
function sameSitePath(pageOrigin, href) {
  if (!pageOrigin || typeof href !== "string" || !href.startsWith(pageOrigin)) {
    return href;
  }
  const rest = href.slice(pageOrigin.length);
  return /^[/?#]/.test(rest) ? rest : href;
}

function pageOriginOf(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch (_) {
    return null;
  }
}

// Runs inside the page, from @instafy/browser-action-policy/pageCapture: every
// check returns a boolean and a failure returns null, so the page is withheld.
const pageSecretSignalsInPage = pageCapture.pageSecretSignalsInPage;

// Runs inside the page. The mark is a non-configurable property, so page
// scripts cannot remove it; a document that refuses new properties counts as
// marked.
function documentWithheldInPage(request) {
  const key = Symbol.for(request.key);
  return Object.getOwnPropertyDescriptor(document, key) !== undefined || !Object.isExtensible(document);
}

function withholdDocumentInPage(request) {
  const key = Symbol.for(request.key);
  if (Object.getOwnPropertyDescriptor(document, key) === undefined) {
    Object.defineProperty(document, key, { value: true });
  }
  return Object.getOwnPropertyDescriptor(document, key) !== undefined;
}

// The main frame's loader id names one loaded document. It changes on every
// new document and stays across same-document history changes; page scripts
// cannot set it. Null when it cannot be read.
async function documentIdentity(page) {
  let session = null;
  try {
    session = await page.context().newCDPSession(page);
    const response = await session.send("Page.getFrameTree");
    const loaderId = String(response?.frameTree?.frame?.loaderId || "");
    return /^[A-Za-z0-9_-]{1,128}$/.test(loaderId) ? loaderId : null;
  } catch (_) {
    return null;
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

// True when a key change or "may show a secret" step ran on another document
// of this run and this is the first snapshot since: the page the step opened,
// however late it loaded. That document is marked and the record cleared.
// An unknown document stays withheld and keeps the record.
async function carriedWithholding(page) {
  // Only the page the person chose runs credential steps (Octo's own tabs
  // refuse them), so the record is that page's. Another tab neither uses nor
  // clears it.
  if (inAgentTab()) {
    return false;
  }
  const afterDocument = approvalProtocol.withholdNextDocumentAfter();
  if (afterDocument === null) {
    return false;
  }
  const current = await documentIdentity(page);
  if (current === null) {
    return true;
  }
  if (current === afterDocument) {
    // Still the page the step ran on, which the step marked itself.
    return false;
  }
  if (await withholdDocument(page)) {
    approvalProtocol.clearWithholdNextDocument();
  }
  return true;
}

async function pageSecretSignals(page) {
  const signals = await page.evaluate(pageSecretSignalsInPage, PAGE_POLICY_SOURCES).catch(() => null);
  if (!signals || typeof signals !== "object") {
    return null;
  }
  return {
    credentialContext: signals.credentialContext === true,
    secretField: signals.secretField === true,
    secretCode: signals.secretCode === true,
    maskedNearReveal: signals.maskedNearReveal === true,
  };
}

async function documentWithheld(page) {
  const withheld = await page
    .evaluate(documentWithheldInPage, { kind: "withheld-read", key: WITHHELD_DOCUMENT_KEY })
    .catch(() => null);
  // Anything but a plain "no" withholds the page.
  return withheld !== false;
}

async function withholdDocument(page) {
  const marked = await page
    .evaluate(withholdDocumentInPage, { kind: "withheld-mark", key: WITHHELD_DOCUMENT_KEY })
    .catch(() => false);
  return marked === true;
}

// The model-facing view of the page: what a person can see of it. Text,
// title, address, control names and link targets are masked on every site and
// in every approval mode; a secret screen withholds the text and stays
// withheld until a new page loads. Whether a page is a secret screen is still
// judged on all of its rendered text and every control's name, seen or not.
async function snapshot(page, { withhold = false } = {}) {
  const hiddenNames = [];
  const interactive = await collectInteractiveElements(page, hiddenNames);
  const rawUrl = page.url();
  const renderedText = await page
    .locator("body")
    .innerText({ timeout: 5_000 })
    .catch(() => "");
  const shownText = await page
    .evaluate(SHOWN_TEXT_IN_PAGE, { kind: "shown-text", limit: MAX_VISIBLE_TEXT_CHARS * 5 })
    .catch(() => null);
  const visibleText = typeof shownText === "string" ? shownText : renderedText;
  const title = await page.title().catch(() => "");
  let signals = await pageSecretSignals(page);
  if (signals === null) {
    // A page that was still changing documents fails the check; try once
    // more after it settles.
    await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => {});
    signals = await pageSecretSignals(page);
  }
  // Read after the page content, so a document that loaded meanwhile is the
  // one these answers describe.
  const carried = await carriedWithholding(page);
  const marked = await documentWithheld(page);
  const checkFailed = signals === null;
  const shownNames = interactive.map(({ description }) => description.label);
  const observeText = (text, names, forceWithhold) =>
    redaction.redactPageObservation({
      url: rawUrl,
      title,
      text: String(text || "").slice(0, MAX_VISIBLE_TEXT_CHARS * 5),
      names,
      signals,
      withhold: forceWithhold,
    });
  // The shown page, withheld whenever the whole rendered page would be.
  const observe = (forceWithhold) => {
    const shown = observeText(visibleText, shownNames, forceWithhold);
    if (shown.secretScreen) return shown;
    const whole = observeText(renderedText, [...shownNames, ...hiddenNames], forceWithhold);
    return whole.secretScreen ? observeText(visibleText, shownNames, true) : shown;
  };
  let view;
  let detected = false;
  try {
    view = observe(withhold || carried || marked || checkFailed);
    // A failed page check withholds this observation only. The document is
    // marked when a credential step ran or the page itself shows a secret,
    // so a page caught mid-navigation is read normally next time.
    detected = view.secretScreen && !marked &&
      (withhold || carried || !checkFailed || observe(false).secretScreen);
  } catch (_) {
    throw new Error("Shared Browser could not mask this page, so it was not read");
  }
  if (detected) {
    await withholdDocument(page);
  }
  const pageOrigin = pageOriginOf(rawUrl);
  const maskLink = (href) => {
    if (!href) return href;
    const masked = redaction.redactUrl(href).text;
    return sameSitePath(pageOrigin, view.secretScreen ? strictlyMasked(masked) : masked);
  };
  return {
    snapshotId: snapshotFingerprint(rawUrl, interactive),
    browserPageId: EXPECTED_BROWSER_PAGE_ID,
    ...tabField(),
    url: view.url,
    title: view.title,
    visibleText: view.text.slice(0, MAX_VISIBLE_TEXT_CHARS),
    secretScreen: view.secretScreen,
    ...(view.message ? { message: view.message } : {}),
    interactiveElements: interactive.map(({ description }, index) =>
      publicElementDescription({
        ...description,
        label: view.names[index],
        href: maskLink(description.href),
        // Page-controlled attributes, masked like control names.
        role: description.role ? strictlyMasked(description.role) : description.role,
        autocomplete: description.autocomplete
          ? strictlyMasked(description.autocomplete)
          : description.autocomplete,
      }),
    ),
    // How many controls were left out because a person cannot see them yet,
    // so a cut list does not read as the whole page.
    ...(hiddenNames.length ? { omittedControls: hiddenNames.length } : {}),
  };
}

// A browser that has just started shows about:blank, and a new tab opened in
// the viewer shows the new-tab page. Neither has an origin to approve, so they
// are reported as blank, which leaves the agent free to navigate to the task's
// site under that site's own approval. The reply is constant apart from the
// fixed address and nothing is read from the page: an about:blank document can
// inherit its opener's origin and hold script-written content. Every other
// origin-less page (data:, about:srcdoc, about:blank#..., other browser pages)
// still fails closed, and no action can target a blank page.
const BLANK_PAGE_URLS = new Set(["", "about:blank", "chrome://newtab/", "chrome://new-tab-page/"]);

function isBlankPage(page) {
  return BLANK_PAGE_URLS.has(page.url());
}

function blankPageResult(page, extra = {}) {
  const url = BLANK_PAGE_URLS.has(page.url()) ? page.url() : "about:blank";
  return {
    ...extra,
    snapshotId: snapshotFingerprint(url, []),
    browserPageId: EXPECTED_BROWSER_PAGE_ID,
    ...tabField(),
    blank: true,
    originApproved: false,
    redacted: false,
    url,
    title: "",
    visibleText: "",
    secretScreen: false,
    interactiveElements: [],
    message:
      "The page is blank. Call navigate with the http(s) address the task names; any approval the browser asks for applies there.",
  };
}

async function snapshotForResult(page, options = {}) {
  if (isBlankPage(page)) {
    return blankPageResult(page);
  }
  if (!siteApproved(page.url())) {
    return approvalProtocol.redactedPageResult(tabField());
  }
  return await snapshot(page, options);
}

async function emitNavigationResult(page) {
  if (!siteApproved(page.url())) {
    emitAction({
      type: "nav_result",
      label: "Page changed to an unapproved origin",
      url: null,
    });
    return;
  }
  const title = await page.title().catch(() => "");
  emitAction({
    type: "nav_result",
    label: title
      ? redaction.redactText(title, { credentialContext: redaction.hasCredentialWord(title) }).text
      : page.url(),
    url: page.url(),
  });
}

async function targetLocator(page, body, revalidationAfterApproval = false) {
  const interactive = await collectInteractiveElements(page);
  const currentSnapshotId = snapshotFingerprint(page.url(), interactive);
  if (body.snapshotId !== currentSnapshotId) {
    if (revalidationAfterApproval) {
      throw new Error(
        "Shared Browser snapshot changed while approval was pending; the action was not performed [approval_stale_non_retryable]",
      );
    }
    throw new Error(
      "Shared Browser snapshot is stale; take a fresh snapshot before acting",
    );
  }
  const target = interactive[body.index];
  if (!target) {
    throw new Error(
      `Shared Browser element index ${body.index} is unavailable; take a fresh snapshot`,
    );
  }
  return target;
}

function descriptionContent(description) {
  return [
    description.label,
    description.tag,
    description.role,
    description.idAttribute,
    description.ariaLabel,
    description.ariaLabelledBy,
    description.ariaLabelledByText,
    description.placeholder,
    description.nameAttribute,
    description.titleAttribute,
    description.valueAttribute,
    description.labels,
    description.text,
    description.href,
    description.inputType,
    description.autocomplete,
    description.inputMode,
    description.formAction,
    description.formMethod,
    description.formActionText,
  ]
    .filter((value) => typeof value === "string")
    .join(" ")
    .trim();
}

function assertSafeTypeTarget(description) {
  const sensitiveAutocomplete = new Set([
    "current-password",
    "new-password",
    "one-time-code",
  ]);
  const autocompleteTokens = String(description.autocomplete || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const content = descriptionContent(description);
  const sensitiveLabel =
    /\b(password|passcode|pin|otp|2fa|mfa|one[- ]?time|verification[\s_-]*code|security[\s_-]*code|auth(?:entication)?[\s_-]*code|login[\s_-]*code|access[\s_-]*code|api[\s_-]*key|client[\s_-]*secret|secret|private[\s_-]*key|seed[\s_-]*phrase|recovery[\s_-]*phrase|wallet|credit[\s_-]*card|card[\s_-]*number|cvv|cvc|social[\s_-]*security|government[\s_-]*id|passport|driver(?:'s)?[\s_-]*licen[cs]e|tax[\s_-]*id|date[\s_-]*of[\s_-]*birth|birthdate|maiden[\s_-]*name|bank[\s_-]*account|routing[\s_-]*number|iban|swift)\b/i;
  if (
    String(description.inputType || "").toLowerCase() === "password" ||
    autocompleteTokens.some(
      (token) => sensitiveAutocomplete.has(token) || token.startsWith("cc-"),
    ) ||
    sensitiveLabel.test(content)
  ) {
    throw new Error(
      "Shared Browser refuses to type authentication, payment, or identity secrets; let the user enter this value directly",
    );
  }
}

// Routine browsing is a run-scoped grant (the person's choice, or the runtime's
// own at the start of a run on an attested browser host), not a claim that
// arbitrary website JavaScript is side-effect-free. Keep recognized consequential
// controls, commit buttons, form submissions and activation keys behind
// one-shot confirmation.
// English and the German of bookkeeping tools: steps that record, rebook,
// finalize, file, issue, pay or mark something paid stay consequential even
// on a menu item, while a menu item that only names a list ("Buchungen",
// "Stornobuchung") is navigation. The shared classifier's commit words hold
// the same verbs for buttons.
const CONSEQUENTIAL_ACTION_PATTERN =
  /(?<![\p{L}\p{N}])(?:buy|purchase|pay|checkout|place[\s_-]*order|delete|remove|erase|destroy|send|post|publish|submit|authorize|approve|allow|confirm[\s_-]*(?:order|payment|purchase)|transfer|withdraw|book|reserve|sign[\s_-]*(?:contract|document|agreement)|save|finalize|mark[\s_-]*(?:as[\s_-]*)?paid|speichern|buchen|verbuchen|(?:um|aus|ab|rück|zurück|gegen|storno)buchen|übermitteln|einreichen|abgeben|ausstellen|festschreiben|als[\s_-]*bezahlt|bezahlen|überweisen|freigeben|absenden|versenden|löschen|stornieren)(?![\p{L}\p{N}])/iu;

// The control's own names and address, the fields the Desktop Personal
// Browser's high-impact check reads, plus its id and name attributes. Never
// its structure: every <button> without a type attribute reports the input
// type "submit", every control in a POST form reports the method "post", and
// formActionText carries the text of the whole form, so scanning them made
// every typeless menu button, and every control on a page wrapped in one
// form, ask under routine browsing. Form submission is checked on its own
// (isFormSubmissionControl).
function controlNameContent(description) {
  const hints = description.nameHints || nameHintsOf(null);
  return [
    description.label,
    description.idAttribute,
    description.ariaLabel,
    description.ariaLabelledByText,
    description.placeholder,
    description.nameAttribute,
    description.titleAttribute,
    description.valueAttribute,
    description.labels,
    description.text,
    description.href,
    hints.tooltip,
    hints.image,
  ]
    .filter((value) => typeof value === "string")
    .join(" ")
    .trim();
}

function isConsequentialAction(description) {
  return CONSEQUENTIAL_ACTION_PATTERN.test(controlNameContent(description));
}

function isFormSubmissionControl(description) {
  const tag = String(description.tag || "").toLowerCase();
  const type = String(description.inputType || "").toLowerCase();
  return (
    (tag === "input" && ["submit", "image"].includes(type)) ||
    (tag === "button" && type !== "button" && type !== "reset" &&
      Boolean(description.formAction || description.formMethod || description.formActionText))
  );
}

// Runs inside the page through Playwright, so it must not use anything from
// this file's scope. Waits, at most `timeoutMs`, for the running animations
// and transitions that end, such as a menu opening or a drawer sliding in.
// Endless ones, such as a spinner, are not waited for.
function animationsSettledInPage(request) {
  const timeoutMs = Math.min(Math.max(Number(request && request.timeoutMs) || 0, 0), 2_000);
  const running = typeof document.getAnimations === "function"
    ? document.getAnimations().filter((animation) => {
        try {
          return animation.playState === "running" &&
            Number.isFinite(animation.effect.getComputedTiming().endTime);
        } catch (_) {
          return false;
        }
      })
    : [];
  if (!running.length) return true;
  return Promise.race([
    Promise.all(running.map((animation) => animation.finished.catch(() => null))).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function settleAfterAction(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(250).catch(() => {});
  // A menu or drawer that opens with a transition is observed where it lands.
  await page
    .evaluate(animationsSettledInPage, { kind: "animations-settled", timeoutMs: 1_000 })
    .catch(() => {});
}

function resolvedTargetDestination(description, currentUrl) {
  const raw = description.href || description.formAction || "";
  if (!raw) {
    return null;
  }
  try {
    const destination = new URL(raw, currentUrl);
    if (
      !["http:", "https:"].includes(destination.protocol) ||
      !destination.hostname ||
      destination.username ||
      destination.password
    ) {
      return null;
    }
    return destination.toString();
  } catch (_) {
    return null;
  }
}

function assertSameOrigin(actualUrl, expectedOrigin) {
  if (approvalProtocol.normalizedOrigin(actualUrl) !== expectedOrigin) {
    throw new Error(
      "Shared Browser page changed while approval was pending; take a fresh snapshot and retry [approval_stale_non_retryable]",
    );
  }
}

function assertSameTarget(
  actual,
  currentUrl,
  expectedFingerprint,
  expectedDestination,
  destinationMode = "target",
) {
  if (targetFingerprint(actual.description) !== expectedFingerprint) {
    throw new Error(
      "Shared Browser target changed while approval was pending; take a fresh snapshot and retry [approval_stale_non_retryable]",
    );
  }
  const targetDestination = resolvedTargetDestination(
    actual.description,
    currentUrl,
  );
  const actualDestination =
    destinationMode === "none"
      ? null
      : targetDestination ||
        (destinationMode === "target-or-page" ? currentUrl : null);
  const actualBinding = approvalProtocol.destinationBinding(actualDestination);
  if (
    actualBinding.destinationFingerprint !==
      expectedDestination.destinationFingerprint ||
    actualBinding.destinationOrigin !== expectedDestination.destinationOrigin
  ) {
    throw new Error(
      "Shared Browser destination changed while approval was pending; take a fresh snapshot and retry [approval_stale_non_retryable]",
    );
  }
}

async function viewport(page) {
  const size =
    page.viewportSize() ||
    (await page
      .evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }))
      .catch(() => ({})));
  return { viewportW: size.width ?? null, viewportH: size.height ?? null };
}

// Only the form of a path is checked before the page is known.
const PATH_FORM_ORIGIN = "https://path.invalid";

// A navigation address: a full URL, or a path on the page's own site such as
// a snapshot link's href, resolved against `pageOrigin`. A path cannot leave
// that site, and a page without an http(s) origin takes full addresses only.
function validateNavigationUrl(raw, pageOrigin = PATH_FORM_ORIGIN) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_URL_CHARS) {
    throw new Error("Shared Browser navigation requires a bounded URL string");
  }
  const value = raw.trim();
  let url;
  if (value.startsWith("/")) {
    if (!pageOrigin) {
      throw new Error("Shared Browser navigation needs a full address on a page without a site");
    }
    url = new URL(value, pageOrigin);
    if (url.origin !== pageOrigin) {
      throw new Error("Shared Browser navigation path must stay on the page's site");
    }
  } else {
    url = new URL(value);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error("Shared Browser navigation requires a credential-free HTTP(S) URL");
  }
  return url.toString();
}

function validateOptionalTabId(body) {
  if (body.tabId !== undefined && !validTabId(body.tabId)) {
    throw new Error("Shared Browser tabId must be one tab id from list_tabs");
  }
}

function requireOnlyKeys(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Shared Browser request body must be an object");
  }
  const unknown = Object.keys(body).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`Shared Browser request contains unsupported field ${unknown}`);
  }
}

function validateTarget(body) {
  const hasIndex = Number.isInteger(body.index) && body.index >= 0 && body.index < 200;
  const hasSnapshotId =
    typeof body.snapshotId === "string" && SNAPSHOT_ID_PATTERN.test(body.snapshotId);
  if (!hasIndex || !hasSnapshotId) {
    throw new Error(
      "Shared Browser action requires one valid index and its fresh snapshotId",
    );
  }
}

function validateRequestBody(requestPath, body) {
  if (requestPath === "/v1/request-human-input") {
    requireOnlyKeys(body, new Set(["indices", "snapshotId"]));
    if (!Array.isArray(body.indices) || body.indices.length < 1 || body.indices.length > 8 ||
        new Set(body.indices).size !== body.indices.length ||
        body.indices.some((index) => !Number.isInteger(index) || index < 0 || index >= 200) ||
        typeof body.snapshotId !== "string" || !SNAPSHOT_ID_PATTERN.test(body.snapshotId)) {
      throw new Error("Human input requires one to eight unique indices from a fresh snapshot");
    }
  } else if (requestPath === "/v1/navigate") {
    requireOnlyKeys(body, new Set(["url", "tabId"]));
    validateNavigationUrl(body.url);
    validateOptionalTabId(body);
  } else if (requestPath === "/v1/snapshot") {
    requireOnlyKeys(body, new Set(["tabId"]));
    if (!validTabId(body.tabId)) {
      throw new Error("Shared Browser snapshot needs one tab id from list_tabs");
    }
  } else if (requestPath === "/v1/tabs/open") {
    requireOnlyKeys(body, new Set(["url"]));
    validateNavigationUrl(body.url, null);
  } else if (requestPath === "/v1/tabs/select" || requestPath === "/v1/tabs/close") {
    requireOnlyKeys(body, new Set(["tabId"]));
    if (!validTabId(body.tabId)) {
      throw new Error("Shared Browser tab commands need one tab id from list_tabs");
    }
  } else if (requestPath === "/v1/click") {
    requireOnlyKeys(body, new Set(["index", "snapshotId"]));
    validateTarget(body);
  } else if (requestPath === "/v1/type") {
    requireOnlyKeys(body, new Set(["index", "snapshotId", "text", "submit"]));
    validateTarget(body);
    if (typeof body.text !== "string" || body.text.length > MAX_TEXT_CHARS) {
      throw new Error("Shared Browser type requires bounded text");
    }
    if (body.submit !== undefined && typeof body.submit !== "boolean") {
      throw new Error("Shared Browser type submit must be a boolean");
    }
  } else if (requestPath === "/v1/press") {
    requireOnlyKeys(body, new Set(["index", "snapshotId", "key"]));
    validateTarget(body);
    if (typeof body.key !== "string" || !ALLOWED_PRESS_KEYS.has(body.key)) {
      throw new Error("Shared Browser press key is not allowed");
    }
  } else if (requestPath === "/v1/scroll") {
    requireOnlyKeys(body, new Set(["x", "y"]));
    for (const key of ["x", "y"]) {
      if (
        body[key] !== undefined &&
        (!Number.isFinite(body[key]) || Math.abs(body[key]) > MAX_SCROLL_DELTA)
      ) {
        throw new Error(`Shared Browser scroll ${key} must be a bounded number`);
      }
    }
  }
}

async function clearHumanInputHighlights(page) {
  await page.evaluate(() => {
    const key = "__instafyHumanInputHighlights";
    const records = Array.isArray(globalThis[key]) ? globalThis[key].slice(0, 8) : [];
    for (const record of records) {
      if (!(record?.element instanceof HTMLElement)) continue;
      if (record.element.style.outline === record.appliedOutline) record.element.style.outline = typeof record.outline === "string" ? record.outline : "";
      if (record.element.style.outlineOffset === "3px") record.element.style.outlineOffset = typeof record.offset === "string" ? record.offset : "";
    }
    globalThis[key] = [];
  });
}

// A credential or "may show a secret" step withholds the page before it runs,
// and the next other document a snapshot sees, however late it loads (see
// carriedWithholding). The step does not run when the page cannot be marked
// or identified.
async function withholdBeforeStep(page, classification) {
  if (!WITHHOLDING_CATEGORIES.has(classification.category)) {
    return false;
  }
  if (inAgentTab()) {
    // Octo's own tabs are for reading. A step that changes a key or may show
    // a secret belongs on the page the person chose, where its page stays
    // withheld across tabs and runs.
    throw new Error(
      "This step can change a key or show a secret, so Octo does not take it in its own tabs; it was not performed. Tell the person which step it is.",
    );
  }
  const documentId = await documentIdentity(page);
  if (!documentId || !(await withholdDocument(page))) {
    throw new Error(
      "Shared Browser could not keep this page withheld, so the step was not performed",
    );
  }
  approvalProtocol.withholdNextDocument(documentId);
  return true;
}

async function snapshotAfterStep(page, withholding) {
  if (withholding) {
    await withholdDocument(page);
  }
  return await snapshotForResult(page, { withhold: withholding });
}

// Octo's tabs. Next to the page the person chose for the run, Octo may open
// up to approvalProtocol.maxAgentTabs tabs of its own in the same, visible
// browser: every viewer sees them, they carry Octo's badge, and the person can
// take any of them over. Octo can use only those pages, never another tab the
// person or a page opened. runtime-agent closes them when the run ends, apart
// from the ones the person kept.
//
// Reads this run's tab record and drops tabs that are no longer open (the
// person closed one). The tab a command acts on is the record's current tab.
// A window a page in one of Octo's tabs opened by itself since the last step
// is closed first (see closeWindowsOpenedFromOctoTabs).
async function prepareTabs(browser, browserSession) {
  const closedWindows = await closeWindowsOpenedFromOctoTabs(browserSession, approvalProtocol.readTabs());
  const pages = await livePages(browser);
  let registry = approvalProtocol.readTabs();
  const open = registry.tabs.filter((tab) => pages.has(tab.tabId));
  let currentTabId = registry.currentTabId;
  const lostCurrent = currentTabId !== null && !open.some((tab) => tab.tabId === currentTabId);
  if (lostCurrent) {
    currentTabId = null;
  }
  if (open.length !== registry.tabs.length || currentTabId !== registry.currentTabId) {
    registry = approvalProtocol.writeTabs({ currentTabId, tabs: open });
  }
  activePageId = registry.currentTabId ?? EXPECTED_BROWSER_PAGE_ID;
  const tabs = { pages, registry, lostCurrent };
  if (closedWindows) {
    // A window comes to the front when it opens; once it is closed, the tab
    // Octo acts on comes back to the front, never a neighbouring person's tab.
    await frontOctoTab(tabs);
  }
  return tabs;
}

// Between Octo's steps no controller runs, so a page in one of Octo's tabs
// can open another window by itself (a timer, or a script still holding the
// activation of Octo's last click). Such a window is never one of Octo's tabs:
// it is not recorded, counted, badged or closed at the end of the run. So it
// is closed, together with any window it opened in turn, before the next step
// runs; runtime-agent closes them as they appear while the run holds the
// browser, and this catches any it has not closed yet. Windows the person's
// own pages open are left alone. Fails closed: a browser that cannot be
// asked takes no step.
async function closeWindowsOpenedFromOctoTabs(browserSession, registry) {
  const octoTabs = new Set(registry.tabs.map((tab) => tab.tabId));
  if (octoTabs.size === 0) return 0;
  let targetInfos;
  try {
    ({ targetInfos } = await browserSession.send("Target.getTargets"));
  } catch (_) {
    throw new Error("Shared Browser could not check for windows Octo's tabs opened, so nothing was done");
  }
  const pages = (Array.isArray(targetInfos) ? targetInfos : [])
    .filter((info) => info && info.type === "page" && validTabId(info.targetId));
  const fromOcto = new Set();
  for (let added = true; added;) {
    added = false;
    for (const info of pages) {
      const opener = typeof info.openerId === "string" ? info.openerId : "";
      if (
        opener && (octoTabs.has(opener) || fromOcto.has(opener)) &&
        !octoTabs.has(info.targetId) && info.targetId !== EXPECTED_BROWSER_PAGE_ID &&
        !fromOcto.has(info.targetId)
      ) {
        fromOcto.add(info.targetId);
        added = true;
      }
    }
  }
  for (const targetId of fromOcto) {
    await browserSession.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  return fromOcto.size;
}

function validTabId(raw) {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 256 && /^[A-Za-z0-9_-]+$/.test(raw);
}

// After Octo closes a tab or a window, the tab in front is one Octo uses: the
// tab it now acts on, else the page the person chose, else another of its own
// tabs. Never a tab the person or a page opened, so the person always sees a
// tab of the run, and its Take over, while Octo holds the browser.
async function frontOctoTab(tabs) {
  const candidates = [activePageId, EXPECTED_BROWSER_PAGE_ID, ...tabs.registry.tabs.map((tab) => tab.tabId)];
  for (const tabId of candidates) {
    const page = tabs.pages.get(tabId);
    if (page && !page.isClosed()) {
      await page.bringToFront().catch(() => {});
      return tabId;
    }
  }
  return null;
}

const UNKNOWN_TAB_MESSAGE =
  "Octo can use only the page the person chose for this run and the tabs Octo opened in it. Call list_tabs for their tab ids.";

// Makes `tabId` the tab later commands act on and brings it to the front, so
// viewers see the page Octo is working in.
async function selectTab(browser, tabs, tabId) {
  const isRunPage = tabId === EXPECTED_BROWSER_PAGE_ID;
  if (!isRunPage && !tabs.registry.tabs.some((tab) => tab.tabId === tabId)) {
    throw new Error(UNKNOWN_TAB_MESSAGE);
  }
  if (!tabs.pages.has(tabId)) {
    throw new Error(UNKNOWN_TAB_MESSAGE);
  }
  tabs.registry = approvalProtocol.writeTabs({
    currentTabId: isRunPage ? null : tabId,
    tabs: tabs.registry.tabs,
  });
  tabs.lostCurrent = false;
  activePageId = tabId;
  const page = await resolveExpectedPage(browser);
  await page.bringToFront();
  return page;
}

// One line per tab Octo may use: its id, who opened it, whether it is the one
// Octo acts on, and its address and title once its site is approved in it.
async function describeTabs(tabs) {
  const kept = approvalProtocol.keptTabIds();
  const entries = [{ tabId: EXPECTED_BROWSER_PAGE_ID, openedBy: "person" }]
    .concat(tabs.registry.tabs.map((tab) => ({
      tabId: tab.tabId,
      openedBy: "octo",
      number: tab.number,
      label: `Octo's tab ${tab.number}`,
    })));
  const described = [];
  for (const entry of entries) {
    const page = tabs.pages.get(entry.tabId);
    if (!page) continue;
    const previous = activePageId;
    activePageId = entry.tabId;
    try {
      const line = {
        tabId: entry.tabId,
        openedBy: entry.openedBy,
        ...(entry.label ? { number: entry.number, label: entry.label } : {}),
        current: entry.tabId === previous,
        ...(kept.has(entry.tabId) ? { keptByPerson: true } : {}),
      };
      const linkOnlySite = linkOnlySiteForPage(page);
      if (isBlankPage(page)) {
        described.push({ ...line, blank: true, url: page.url() || "about:blank", title: "" });
      } else if (linkOnlySite) {
        described.push({ ...line, linkOnlySite, url: null, title: null });
      } else if (!siteApproved(page.url())) {
        described.push({ ...line, originApproved: false, url: null, title: null });
      } else {
        const title = await page.title().catch(() => "");
        described.push({
          ...line,
          originApproved: true,
          url: redaction.redactUrl(page.url()).text,
          title: redaction.redactText(title, { credentialContext: redaction.hasCredentialWord(title) }).text,
        });
      }
    } finally {
      activePageId = previous;
    }
  }
  return {
    tabs: described,
    agentTabLimit: approvalProtocol.maxAgentTabs,
    agentTabsOpen: tabs.registry.tabs.length,
  };
}

async function executeTabCommand(browser, method, requestPath, body, tabs) {
  if (method === "GET" && requestPath === "/v1/tabs") {
    return await describeTabs(tabs);
  }

  if (method === "POST" && requestPath === "/v1/tabs/select") {
    await selectTab(browser, tabs, body.tabId);
    return await describeTabs(tabs);
  }

  if (method === "POST" && requestPath === "/v1/tabs/close") {
    const tabId = body.tabId;
    if (!tabs.registry.tabs.some((tab) => tab.tabId === tabId)) {
      throw new Error(
        "Octo can close only the tabs it opened in this run. Call list_tabs for their tab ids.",
      );
    }
    if (approvalProtocol.keptTabIds().has(tabId)) {
      throw new Error("The person kept this tab open, so Octo leaves it open. It was not closed.");
    }
    const page = tabs.pages.get(tabId);
    const remaining = tabs.registry.tabs.filter((tab) => tab.tabId !== tabId);
    // The record forgets the tab first: a tab that fails to close stays an
    // ordinary visible tab, never one Octo can still use.
    tabs.registry = approvalProtocol.writeTabs({
      currentTabId: tabs.registry.currentTabId === tabId ? null : tabs.registry.currentTabId,
      tabs: remaining,
    });
    activePageId = tabs.registry.currentTabId ?? EXPECTED_BROWSER_PAGE_ID;
    if (page) {
      await page.close({ runBeforeUnload: false });
      tabs.pages.delete(tabId);
    }
    // Chromium shows a neighbouring tab, which may be the person's; the tab
    // Octo now acts on comes to the front instead.
    await frontOctoTab(tabs);
    return { closedTabId: tabId, ...(await describeTabs(tabs)) };
  }

  if (method === "POST" && requestPath === "/v1/tabs/open") {
    if (tabs.registry.tabs.length >= approvalProtocol.maxAgentTabs) {
      throw new Error(
        `Octo already has ${approvalProtocol.maxAgentTabs} tabs open, so no tab was opened. Close one with close_tab, or reuse one with select_tab and navigate.`,
      );
    }
    if (tabs.registry.lastTabNumber >= approvalProtocol.maxAgentTabNumber) {
      throw new Error("Octo has opened as many tabs as one run may, so no tab was opened. Reuse one with select_tab and navigate.");
    }
    // A new tab has no site yet, so only a full address opens it.
    const url = validateNavigationUrl(body.url, null);
    assertMayOpen(url);
    const step = classifyStep("navigate", null, { url });
    if (step.verdict === "ask" || CONSEQUENTIAL_ACTION_PATTERN.test(url)) {
      throw new Error(
        "Octo's own tabs are for reading, and this address does more than show a page, so no tab was opened. Leave it to the person.",
      );
    }
    const previousTabId = tabs.registry.currentTabId;
    activePageId = EXPECTED_BROWSER_PAGE_ID;
    const runPage = await resolveExpectedPage(browser);
    // The tab opens blank in the run's own browser context, where every
    // viewer sees it, and is recorded before anything asks or loads, so the
    // end of the run closes it whatever happens next.
    const page = await runPage.context().newPage();
    const tabId = await cdpTargetIdForPage(page).catch(() => "");
    if (!validTabId(tabId) || tabId === EXPECTED_BROWSER_PAGE_ID) {
      await page.close({ runBeforeUnload: false }).catch(() => {});
      throw new Error("Shared Browser could not identify the new tab, so it was closed");
    }
    // The tab keeps this number, and its label, for as long as it is open.
    const number = tabs.registry.lastTabNumber + 1;
    tabs.registry = approvalProtocol.writeTabs({
      currentTabId: tabId,
      lastTabNumber: number,
      tabs: [...tabs.registry.tabs, { tabId, number, approvedOrigins: [] }],
    });
    tabs.pages.set(tabId, page);
    activePageId = tabId;
    let loading = false;
    try {
      await page.bringToFront();
      await ensureSiteApproved(url, "Allow the assistant to open this site in a new tab for this run");
      const destination = approvalProtocol.destinationBinding(url);
      await allowStepOnce({
        operation: "navigate",
        label: "Open a new tab",
        categoryTitle: step.verdict === "ask" ? approvalCategoryTitle(step) : "",
        sourceOrigin: null,
        ...destination,
        snapshotId: null,
        targetFingerprint: null,
        payloadFingerprint: approvalProtocol.sha256("open-tab"),
      }, { routine: true });
      const opened = await resolveExpectedPage(browser);
      const documents = await guardStepDocuments(opened);
      try {
        emitAction({ type: "navigate", label: `Open a tab: ${url}`, url });
        loading = true;
        await opened.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await settleAfterAction(opened);
        documents.assertNoneBlocked();
      } catch (error) {
        documents.assertNoneBlocked(error);
        throw error;
      } finally {
        await documents.release();
      }
      const settled = await resolveExpectedPage(browser);
      await emitNavigationResult(settled);
      return { openedTab: true, ...(await snapshotForResult(settled)) };
    } catch (error) {
      if (!loading) {
        // Nothing was approved or loaded: the blank tab goes again. When the
        // run's authority is gone the record cannot be written; the end of
        // the run closes the tab then.
        try {
          const current = approvalProtocol.readTabs();
          tabs.registry = approvalProtocol.writeTabs({
            ...current,
            currentTabId: current.tabs.some((tab) => tab.tabId === previousTabId) ? previousTabId : null,
            tabs: current.tabs.filter((tab) => tab.tabId !== tabId),
          });
          activePageId = tabs.registry.currentTabId ?? EXPECTED_BROWSER_PAGE_ID;
          await page.close({ runBeforeUnload: false }).catch(() => {});
          tabs.pages.delete(tabId);
          await frontOctoTab(tabs);
        } catch (_) {
          // Keep the approval error, which may end the run.
        }
      }
      throw error;
    }
  }

  throw new Error("Unsupported Shared Browser method/path combination");
}

async function execute(browser, browserSession, method, requestPath, body) {
  approvalProtocol.authority();
  const tabs = await prepareTabs(browser, browserSession);
  if (requestPath.startsWith("/v1/tabs")) {
    return await executeTabCommand(browser, method, requestPath, body, tabs);
  }
  if (typeof body.tabId === "string") {
    // snapshot and navigate may name the tab they act on.
    await selectTab(browser, tabs, body.tabId);
  } else if (tabs.lostCurrent) {
    throw new Error(
      "The tab Octo was using was closed, so nothing was done. Call list_tabs, then select_tab.",
    );
  }
  const page = await resolveExpectedPage(browser);
  page.setDefaultTimeout(15_000);
  await page.bringToFront();
  if (requestPath !== "/v1/navigate") {
    refuseLinkOnlyPage(page);
  }
  if (method !== "POST") {
    return await executeOnPage(browser, method, requestPath, body, page, tabs);
  }
  // Every step Octo takes, in any tab, is guarded the same way.
  const documents = await guardStepDocuments(page);
  try {
    const result = await executeOnPage(browser, method, requestPath, body, page, tabs);
    documents.assertNoneBlocked();
    return result;
  } catch (error) {
    // A blocked load fails the step itself; say why.
    documents.assertNoneBlocked(error);
    throw error;
  } finally {
    await documents.release();
  }
}

// While a step of Octo's runs, in any tab (its own tabs and the page the
// person chose alike), the tab loads no document from a link-only site: a
// link, form or redirect that would land on one is stopped before its request
// leaves the browser. Fails closed: a tab that cannot be guarded takes no step.
async function guardStepDocuments(page) {
  const blocked = [];
  // Another window a step opens (a target=_blank link, a script) would be a
  // tab Octo cannot see, count or close, outside this guard. While agent
  // control holds, no person opens a page, so every page that appears during
  // the step is such a window: its requests are stopped before they leave the
  // browser and it is closed when the step ends.
  const context = page.context();
  const knownPages = new Set(context.pages());
  const windows = [];
  const noteWindow = (opened) => {
    if (!knownPages.has(opened) && !windows.includes(opened)) windows.push(opened);
  };
  let windowRequestStopped = false;
  const stopWindowRequests = async (route) => {
    const request = route.request();
    let owner = null;
    let frameless = false;
    try {
      owner = request.frame().page();
    } catch (_) {
      // A new window's first navigation is issued before its frame exists;
      // a worker's request belongs to no page and is not a navigation.
      frameless = true;
    }
    if ((owner && !knownPages.has(owner)) || (frameless && request.isNavigationRequest())) {
      if (owner) noteWindow(owner);
      windowRequestStopped = true;
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }
    await route.fallback().catch(() => {});
  };
  let session;
  try {
    context.on("page", noteWindow);
    await context.route("**/*", stopWindowRequests);
    session = await page.context().newCDPSession(page);
    session.on("Fetch.requestPaused", (event) => {
      const url = event?.request?.url || "";
      const site = LINK_ONLY_SITES === null ? "an unknown site" : linkOnlySiteOf(url);
      const answer = site
        ? session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" })
        : session.send("Fetch.continueRequest", { requestId: event.requestId });
      if (site) blocked.push(site);
      answer.catch(() => {});
    });
    await session.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
    });
  } catch (_) {
    if (session) await session.detach().catch(() => {});
    context.off("page", noteWindow);
    await context.unroute("**/*", stopWindowRequests).catch(() => {});
    throw new Error("Shared Browser could not guard the tab against link-only sites, so the step was not performed");
  }
  return {
    release: async () => {
      await session.send("Fetch.disable").catch(() => {});
      await session.detach().catch(() => {});
      // A window that appeared after the step's last check is closed too.
      for (const opened of context.pages()) noteWindow(opened);
      context.off("page", noteWindow);
      await context.unroute("**/*", stopWindowRequests).catch(() => {});
      for (const opened of windows) {
        await opened.close({ runBeforeUnload: false }).catch(() => {});
      }
      // Chromium shows the window's neighbour when it closes, which may be a
      // person's tab: the tab the step ran in comes to the front again.
      if (windows.length && !page.isClosed()) {
        await page.bringToFront().catch(() => {});
      }
    },
    // An approval code in `cause` still ends the run, so it is kept.
    assertNoneBlocked: (cause = null) => {
      for (const opened of context.pages()) noteWindow(opened);
      if (cause && /\[[a-z_]+_non_retryable\]/.test(String(cause.message || ""))) {
        return;
      }
      if (blocked.length) {
        throw new Error(
          `A link or redirect that Octo's step followed led to ${blocked[0]}, which is link-only, so it was not opened. ${SEND_PAGE_HINT}`,
        );
      }
      if (windows.length || windowRequestStopped) {
        throw new Error(
          "The step opened another window, which Octo never uses, so it was closed before it loaded anything. Open the address with open_tab instead.",
        );
      }
    },
  };
}

// A control that leads to a link-only site is refused before any prompt. On a
// site already approved in this tab the step's own check below comes before
// every prompt; on one that is not, the control is looked up here first, so
// the site's prompt is not shown for a step that would be refused anyway.
// Nothing found here reaches Octo: a stale or missing target is reported by
// the step itself, after the site's checks.
async function refuseLinkOnlyTargetBeforeSitePrompt(page, body) {
  if (siteApproved(page.url())) return;
  let target;
  try {
    target = await targetLocator(page, body);
  } catch (_) {
    return;
  }
  const destination = resolvedTargetDestination(target.description, page.url());
  if (destination) {
    assertMayOpen(destination);
  }
}

async function executeOnPage(browser, method, requestPath, body, page, tabs) {
  if (method === "GET" && requestPath === "/v1/status") {
    const shared = {
      ready: true,
      browserPageId: EXPECTED_BROWSER_PAGE_ID,
      pageCount: browser.contexts().flatMap((context) => context.pages()).length,
      agentTabCount: tabs.registry.tabs.length,
      ...tabField(),
    };
    if (isBlankPage(page)) {
      return blankPageResult(page, shared);
    }
    if (!siteApproved(page.url())) {
      return approvalProtocol.redactedPageResult(shared);
    }
    const title = await page.title().catch(() => "");
    return {
      ...shared,
      originApproved: true,
      redacted: false,
      url: redaction.redactUrl(page.url()).text,
      title: redaction.redactText(title, { credentialContext: redaction.hasCredentialWord(title) }).text,
    };
  }

  if ((method === "GET" || method === "POST") && requestPath === "/v1/snapshot") {
    // A blank observation is not action evidence: like status, it only shows
    // that the browser is reachable, so a turn that stops here is retried.
    if (isBlankPage(page)) {
      return blankPageResult(page);
    }
    const approvedOrigin = await ensureSiteApproved(
      page.url(),
      "Allow the assistant to read and interact with this site for this run",
    );
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), approvedOrigin);
    await clearHumanInputHighlights(page);
    const result = await snapshot(page);
    emitAction({
      type: "nav_result",
      label: result.title || result.url,
      url: result.url,
    });
    return result;
  }

  if (method === "POST" && requestPath === "/v1/request-human-input") {
    if (inAgentTab()) {
      throw new Error(
        "Octo's own tabs are for reading, so the person is not asked to fill fields there. Stop at the sign-in or form and tell the person; nothing was highlighted.",
      );
    }
    const sourceOrigin = await ensureSiteApproved(page.url(), "Allow the assistant to identify fields for your input");
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), sourceOrigin);
    const interactive = await collectInteractiveElements(page);
    if (snapshotFingerprint(page.url(), interactive) !== body.snapshotId) {
      throw new Error("The page changed; take a fresh snapshot before requesting human input");
    }
    const selected = body.indices.map((index) => interactive[index]);
    if (selected.some((entry) => !entry || !["input", "textarea", "select"].includes(entry.description.tag))) {
      throw new Error("Human input targets must be observed editable fields");
    }
    await clearHumanInputHighlights(page);
    for (const entry of selected) {
      await entry.locator.evaluate((element) => {
        // Fixed native DOM styling follows scrolling/reflow. No values or
        // DOM-derived text are copied to the handoff or action log.
        const key = "__instafyHumanInputHighlights";
        const records = Array.isArray(globalThis[key]) ? globalThis[key] : [];
        if (records.length >= 8) throw new Error("Human input highlight limit");
        const record = { element, outline: element.style.outline, offset: element.style.outlineOffset };
        records.push(record);
        globalThis[key] = records;
        element.style.outline = "3px solid #f59e0b";
        element.style.outlineOffset = "3px";
        record.appliedOutline = element.style.outline;
      });
    }
    assertSameOrigin(page.url(), sourceOrigin);
    const authority = approvalProtocol.authority();
    const createdAtMs = Date.now();
    emitAction({
      type: "human_input", label: "Human input needed", url: null,
      humanInputRequest: {
        version: 1, handoffId: crypto.randomUUID(), runId: authority.runId,
        initiatorUserId: authority.initiatorUserId, browserPageId: EXPECTED_BROWSER_PAGE_ID,
        origin: sourceOrigin, createdAtMs, expiresAtMs: createdAtMs + 600_000,
        fields: selected.map((_, index) => ({ label: `Highlighted field ${index + 1}` })),
      },
    });
    // The MCP latch blocks all further observation/mutation for this turn.
    // The existing guard, not this helper, restores human authority only after
    // confirmed shutdown. Never remove the agent marker to lend control.
    throw new Error("User input is needed. End this turn; the user will explicitly continue after filling the highlighted fields. [human_input_required_non_retryable]");
  }

  if (method === "POST" && requestPath === "/v1/navigate") {
    const sourceOrigin = approvalProtocol.normalizedOrigin(page.url());
    const url = validateNavigationUrl(body.url, sourceOrigin);
    // Risky addresses (sign-out, exports, files, one-time links, action
    // addresses) are judged by the address alone and ask even under routine
    // browsing. Under routine browsing, an address for a site the run has not
    // used yet does not ask on its own.
    const step = classifyStep("navigate", null, { url });
    const readingStep = step.verdict !== "ask" && !CONSEQUENTIAL_ACTION_PATTERN.test(url);
    assertMayOpen(url);
    refuseUnlessReadingStep(readingStep);
    await ensureSiteApproved(
      url,
      "Allow the assistant to access this destination for this run",
    );
    const destination = approvalProtocol.destinationBinding(url);
    await allowStepOnce({
      operation: "navigate",
      label: "Navigate the Shared Browser",
      categoryTitle: step.verdict === "ask" ? approvalCategoryTitle(step) : "",
      sourceOrigin,
      ...destination,
      snapshotId: null,
      targetFingerprint: null,
      payloadFingerprint: approvalProtocol.sha256("navigate"),
    }, { routine: readingStep });
    page = await resolveExpectedPage(browser);
    if (sourceOrigin) {
      assertSameOrigin(page.url(), sourceOrigin);
    }
    const revalidatedUrl = validateNavigationUrl(body.url, sourceOrigin);
    // An address the agent opens itself is not the page a credential step
    // opened. That record belongs to the page the person chose, so a
    // navigation in one of Octo's own tabs leaves it.
    if (!inAgentTab()) {
      approvalProtocol.clearWithholdNextDocument();
    }
    emitAction({ type: "navigate", label: `Go to ${url}`, url });
    await page.goto(revalidatedUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await settleAfterAction(page);
    page = await resolveExpectedPage(browser);
    await emitNavigationResult(page);
    return await snapshotForResult(page);
  }

  if (method === "POST" && requestPath === "/v1/click") {
    await refuseLinkOnlyTargetBeforeSitePrompt(page, body);
    const sourceOrigin = await ensureSiteApproved(
      page.url(),
      "Allow the assistant to interact with this site for this run",
    );
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), sourceOrigin);
    let target = await targetLocator(page, body);
    const step = classifyStep("click", target.description, { pageUrl: page.url() });
    refuseUserStep(step);
    const approvedTargetFingerprint = targetFingerprint(target.description);
    const rawDestination = resolvedTargetDestination(target.description, page.url());
    const destination = approvalProtocol.destinationBinding(rawDestination);
    const readingStep = routineCovers(step, target.description) &&
      !isFormSubmissionControl(target.description);
    if (rawDestination) {
      assertMayOpen(rawDestination);
    }
    refuseUnlessReadingStep(readingStep);
    if (
      destination.destinationOrigin &&
      destination.destinationOrigin !== sourceOrigin
    ) {
      await ensureSiteApproved(
        rawDestination,
        "Allow the assistant to follow this control to another site for this run",
      );
    }
    await allowStepOnce({
      operation: "click",
      label: controlLabel(target.description) || "Activate this control",
      categoryTitle: approvalCategoryTitle(step),
      sourceOrigin,
      ...destination,
      snapshotId: body.snapshotId,
      targetFingerprint: approvedTargetFingerprint,
      payloadFingerprint: approvalProtocol.sha256("click"),
    }, { routine: readingStep });
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), sourceOrigin);
    target = await targetLocator(page, body, true);
    assertSameTarget(
      target,
      page.url(),
      approvedTargetFingerprint,
      destination,
    );
    const withholding = await withholdBeforeStep(page, step);
    const box = target.description.box;
    const size = await viewport(page);
    emitAction({
      type: "click",
      label: `Click "${controlLabel(target.description)}"`,
      url: page.url(),
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      ...size,
    });
    const beforeUrl = page.url();
    await target.locator.click();
    await settleAfterAction(page);
    page = await resolveExpectedPage(browser);
    await page.bringToFront();
    if (page.url() !== beforeUrl) {
      await emitNavigationResult(page);
    }
    return await snapshotAfterStep(page, withholding);
  }

  if (method === "POST" && requestPath === "/v1/type") {
    if (typeof body.text !== "string") {
      throw new Error("Shared Browser type requires a text string");
    }
    if (body.submit === true) {
      await refuseLinkOnlyTargetBeforeSitePrompt(page, body);
    }
    const sourceOrigin = await ensureSiteApproved(
      page.url(),
      "Allow the assistant to interact with this site for this run",
    );
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), sourceOrigin);
    let target = await targetLocator(page, body);
    assertSafeTypeTarget(target.description);
    const submitting = body.submit === true;
    const typingStep = classifyStep("type", target.description, { pageUrl: page.url() });
    refuseUserStep(typingStep);
    const submitStep = submitting
      ? classifyStep("submit", target.description, { pageUrl: page.url() })
      : null;
    if (submitStep) {
      refuseUserStep(submitStep);
    }
    const step = submitStep || typingStep;
    const readingStep = !submitting && routineCovers(step, target.description, { consequential: false });
    const rawDestination = submitting
      ? resolvedTargetDestination(target.description, page.url()) || page.url()
      : null;
    if (rawDestination) {
      assertMayOpen(rawDestination);
    }
    refuseUnlessReadingStep(readingStep);
    const approvedTargetFingerprint = targetFingerprint(target.description);
    const destination = approvalProtocol.destinationBinding(rawDestination);
    if (submitting) {
      if (
        destination.destinationOrigin &&
        destination.destinationOrigin !== sourceOrigin
      ) {
        await ensureSiteApproved(
          rawDestination,
          "Allow this form destination for this run",
        );
      }
    }
    await allowStepOnce({
      operation: submitting ? "form-submit" : "type",
      label: submitting
        ? controlLabel(target.description) || "Submit this form"
        : controlLabel(target.description) || "Type into this field",
      categoryTitle: approvalCategoryTitle(step),
      sourceOrigin,
      ...destination,
      snapshotId: body.snapshotId,
      targetFingerprint: approvedTargetFingerprint,
      payloadFingerprint: approvalProtocol.sha256(
        JSON.stringify({ text: body.text, submit: submitting }),
      ),
    }, { routine: readingStep });
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), sourceOrigin);
    target = await targetLocator(page, body, true);
    assertSameTarget(
      target,
      page.url(),
      approvedTargetFingerprint,
      destination,
      submitting ? "target-or-page" : "none",
    );
    assertSafeTypeTarget(target.description);
    emitAction({
      type: "type",
      label: `Type into "${controlLabel(target.description)}"`,
      url: page.url(),
    });
    await target.locator.focus();
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), sourceOrigin);
    target = await targetLocator(page, body, true);
    assertSafeTypeTarget(target.description);
    assertSameTarget(
      target,
      page.url(),
      approvedTargetFingerprint,
      destination,
      submitting ? "target-or-page" : "none",
    );
    const withholding = submitting ? await withholdBeforeStep(page, step) : false;
    await target.locator.fill(body.text);
    if (submitting) {
      await target.locator.press("Enter");
      await settleAfterAction(page);
      page = await resolveExpectedPage(browser);
      await emitNavigationResult(page);
    }
    page = await resolveExpectedPage(browser);
    return await snapshotAfterStep(page, withholding);
  }

  if (method === "POST" && requestPath === "/v1/press") {
    if (typeof body.key !== "string" || !ALLOWED_PRESS_KEYS.has(body.key)) {
      throw new Error("Shared Browser press requires a key");
    }
    if (["Enter", "Space", " "].includes(body.key)) {
      await refuseLinkOnlyTargetBeforeSitePrompt(page, body);
    }
    const sourceOrigin = await ensureSiteApproved(
      page.url(),
      "Allow the assistant to interact with this site for this run",
    );
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), sourceOrigin);
    let target = await targetLocator(page, body);
    // Every key is target-bound. This prevents global Delete/Backspace or
    // navigation keystrokes from acting on a stale focused element, and keeps
    // sensitive/high-impact classification on the same fresh descriptor used
    // by click and type.
    assertSafeTypeTarget(target.description);
    const step = classifyStep("press", target.description, {
      pageUrl: page.url(),
      key: body.key === "Space" ? " " : body.key,
    });
    refuseUserStep(step);
    const approvedTargetFingerprint = targetFingerprint(target.description);
    const pressKey = body.key === " " ? "Space" : body.key;
    const activationKey = ["Enter", "Space"].includes(pressKey);
    const readingStep = !activationKey && routineCovers(step, target.description);
    const rawDestination = activationKey
      ? resolvedTargetDestination(target.description, page.url()) || page.url()
      : null;
    if (rawDestination) {
      assertMayOpen(rawDestination);
    }
    refuseUnlessReadingStep(readingStep);
    const destination = approvalProtocol.destinationBinding(rawDestination);
    if (activationKey) {
      if (
        destination.destinationOrigin &&
        destination.destinationOrigin !== sourceOrigin
      ) {
        await ensureSiteApproved(
          rawDestination,
          "Allow this activation destination for this run",
        );
      }
    }
    await allowStepOnce({
      operation: activationKey
        ? pressKey === "Enter"
          ? "press-enter"
          : "press-space"
        : "press-key",
      label: activationKey
        ? controlLabel(target.description) || "Activate this control"
        : `Press ${pressKey} on ${controlLabel(target.description) || "this field"}`,
      categoryTitle: approvalCategoryTitle(step),
      sourceOrigin,
      ...destination,
      snapshotId: body.snapshotId,
      targetFingerprint: approvedTargetFingerprint,
      payloadFingerprint: approvalProtocol.sha256(body.key),
    }, { routine: readingStep });
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), sourceOrigin);
    target = await targetLocator(page, body, true);
    assertSameTarget(
      target,
      page.url(),
      approvedTargetFingerprint,
      destination,
      activationKey ? "target-or-page" : "none",
    );
    assertSafeTypeTarget(target.description);
    const withholding = activationKey ? await withholdBeforeStep(page, step) : false;
    emitAction({
      type: "type",
      label: `Press ${pressKey}`,
      url: page.url(),
    });
    await target.locator.press(pressKey);
    await settleAfterAction(page);
    page = await resolveExpectedPage(browser);
    return await snapshotAfterStep(page, withholding);
  }

  if (method === "POST" && requestPath === "/v1/scroll") {
    const sourceOrigin = await ensureSiteApproved(
      page.url(),
      "Allow the assistant to interact with this site for this run",
    );
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), sourceOrigin);
    const x = Number.isFinite(body.x) ? body.x : 0;
    const y = Number.isFinite(body.y) ? body.y : 0;
    emitAction({ type: "scroll", label: "Scroll", url: page.url() });
    await page.mouse.wheel(x, y);
    await page.waitForTimeout(200);
    page = await resolveExpectedPage(browser);
    return await snapshotForResult(page);
  }

  throw new Error("Unsupported Shared Browser method/path combination");
}

// Playwright lets this connection download into its own temporary folder
// from the moment it connects. The hosted browser has no copy-out, so a
// download would only land where an ordinary turn could read it: deny
// downloads for as long as this connection lasts, and close the connection
// with browser.close(), which for a CDP connection leaves Chromium running and
// removes that temporary folder. The override ends when the connection does;
// the profile's download_restrictions preference, set by the runtime
// entrypoint, covers everything else.
async function denyDownloads(browser) {
  const session = await browser.newBrowserCDPSession();
  await session.send("Browser.setDownloadBehavior", { behavior: "deny" });
  return session;
}

async function main() {
  // The runtime agent runs `node - <method> <path> [body]` with this script on
  // stdin, so the arguments follow the "-".
  const args = process.argv[1] === "-" ? process.argv.slice(2) : process.argv.slice(1);
  const method = String(args[0] || "").toUpperCase();
  const requestPath = String(args[1] || "");
  const body = args[2] ? JSON.parse(args[2]) : null;
  if (method === "POST") {
    validateRequestBody(requestPath, body);
  }
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15_000 });
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    throw new BrowserUnavailableError(`Instafy's browser could not be reached: ${reason}`);
  }
  try {
    const browserSession = await denyDownloads(browser);
    let result;
    try {
      result = await execute(browser, browserSession, method, requestPath, body || {});
    } catch (error) {
      if (!(error instanceof BrowserUnavailableError) && (await browserWentAway(browser))) {
        // The message is kept, so an approval code in it still ends the run.
        const reason = error && error.message ? error.message : String(error);
        throw new BrowserUnavailableError(`Instafy's browser or the run's tab closed: ${reason}`);
      }
      throw error;
    }
    await writeStdout(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    const message = error && error.message ? error.message : String(error);
    // Errors reach the model and logs; browser errors can quote page markup.
    let masked = "Shared Browser command failed and its error could not be masked";
    try {
      masked = maskedDisplayText(message);
    } catch (_) {
      // Keep the fixed message.
    }
    process.stderr.write(`Shared Browser command failed: ${masked}\n`);
    process.exit(error instanceof BrowserUnavailableError ? BROWSER_UNAVAILABLE_EXIT_CODE : 1);
  },
);
