const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// Redaction, step classification and the page's secret checks come from
// @instafy/browser-action-policy, embedded ahead of this script by the runtime agent.
const redaction = globalThis.__instafyBrowserRedaction;
const actionPolicy = globalThis.__instafyBrowserActionPolicy;
const pageCapture = globalThis.__instafyBrowserPageCapture;
// The form submission a step makes, computed in the page the way the browser
// does; the Desktop Personal Browser runs the same rules.
const formSubmission = globalThis.__instafyBrowserFormSubmission;
// The web-research skill's link-only list, embedded by the runtime agent ahead
// of this script, plus what the space's own copy adds. Octo never opens, reads
// or acts on a "no-agents" site on it, nor on a translator's, cache's or
// archive's copy of one, in any tab: its own tabs and the page the person
// chose alike. A "no-reuse" site (its terms bar copying, not reading) is not
// refused. Matching is @instafy/browser-action-policy's linkOnly.js, embedded
// ahead of this script too and shared with `instafy web read` and the Personal
// Browser.
const LINK_ONLY = linkOnlyListForRun();
const LINK_ONLY_SITES = LINK_ONLY.list;
if (
  !redaction || typeof redaction.redactPageObservation !== "function" ||
  !actionPolicy || typeof actionPolicy.classifyStep !== "function" ||
  !pageCapture || typeof pageCapture.pageSecretSignalsInPage !== "function" ||
  !formSubmission || typeof formSubmission.formSubmissionRulesInPage !== "function"
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
// The longest option label a choose step names.
const MAX_OPTION_CHARS = 500;
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
// Regular-expression sources the page-side checks need, the same ones Send
// page uses. Values are tested in the page and only yes/no answers come back.
const PAGE_POLICY_SOURCES = Object.freeze(pageCapture.pagePolicySources(redaction));
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

// One step's time. A page can keep a step busy far longer than any step needs:
// a script that holds the page, or a load that never settles. The turn would
// then wait with the view and its line frozen. So a step's own time ends after
// STEP_TIME_MS, and the step answers with the page as it is (pageAsItIs). A
// prompt waiting for the person is not the step's time: the clock stops while
// one waits, and the approval keeps its own deadline. Once the time is up the
// step takes no further action (assertStepOnTime), so nothing it was about to
// do happens after it answered.
const STEP_TIME_MS = 20_000;
// How long reading the page as it is may take once the step's time is up.
const LATE_READ_MS = 8_000;
// How long ending a step's guards (guardStepDocuments) may take once its time
// is up. A busy page holds a guard's own release; the command's end lets go of
// the page anyway, and the windows are closed by their targets first.
const GUARD_RELEASE_MS = 1_000;
class StepTimeUp extends Error {
  constructor() {
    super("This step's time was up, so it took no further action.");
  }
}
function createStepClock(limitMs) {
  let left = limitMs;
  // "idle" before the step starts, "running" while its time counts, "paused"
  // while a prompt waits, and "over" once it answered or its time ran out.
  let state = "idle";
  let startedAt = 0;
  let timer = null;
  let prompts = 0;
  let up = false;
  let expire;
  const expired = new Promise((resolve) => {
    expire = resolve;
  });
  const run = () => {
    state = "running";
    startedAt = Date.now();
    timer = setTimeout(() => {
      state = "over";
      up = true;
      expire();
    }, Math.max(left, 0));
  };
  const pause = () => {
    clearTimeout(timer);
    left -= Date.now() - startedAt;
    state = "paused";
  };
  return {
    // Resolves when the step's time is up; never while a prompt waits.
    expired,
    isUp: () => up,
    start() {
      if (state === "idle") run();
    },
    stop() {
      clearTimeout(timer);
      state = "over";
    },
    // Runs `wait` (a prompt) with the clock stopped.
    async whilePersonAnswers(wait) {
      if (prompts++ === 0 && state === "running") pause();
      try {
        return await wait();
      } finally {
        if (--prompts === 0 && state === "paused") run();
      }
    },
  };
}
const stepClock = createStepClock(STEP_TIME_MS);
function assertStepOnTime() {
  if (stepClock.isUp()) {
    throw new StepTimeUp();
  }
}

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

// The list this run enforces: the bundled copy and the sites and wrappers the
// space's copy (INSTAFY_SHARED_BROWSER_SPACE_LINK_ONLY_FILE) adds. A space's
// copy can only add; one that does not load is left out with a warning and
// the bundled list still applies. Null when the bundled list or the matcher is
// missing or malformed, which keeps Octo from opening, reading or acting on
// anything in any tab.
function linkOnlyListForRun() {
  const api = globalThis.__instafyLinkOnly;
  if (
    !api ||
    typeof api.linkOnlyListFrom !== "function" ||
    typeof api.linkOnlyMatch !== "function" ||
    typeof api.barsAgents !== "function"
  ) {
    return { api: null, list: null, warnings: [] };
  }
  const file = String(process.env.INSTAFY_SHARED_BROWSER_SPACE_LINK_ONLY_FILE || "").trim();
  const copy = file && path.isAbsolute(file) ? readSpaceLinkOnlyCopy(file) : {};
  const additions = "data" in copy ? [{ data: copy.data, source: "the space's link-only-sites.json" }] : [];
  const merged = api.linkOnlyListFrom(globalThis.__instafyLinkOnlySites, additions);
  return { api, list: merged.list, warnings: [...(copy.warning ? [copy.warning] : []), ...merged.warnings] };
}

// The space's copy is read as data only: a regular file (never a link or a
// pipe) of at most 256 KiB holding JSON. Nothing of its text is repeated.
function readSpaceLinkOnlyCopy(file) {
  const ignored = (why) => ({ warning: `the space's link-only-sites.json ${why} and was ignored; the bundled list still applies` });
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (error) {
    return error && error.code === "ENOENT" ? {} : ignored("could not be read");
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 * 1024) return ignored("is not a file of at most 256 KiB");
    return { data: JSON.parse(fs.readFileSync(fd, "utf8")) };
  } catch (_) {
    return ignored("is not valid JSON");
  } finally {
    fs.closeSync(fd);
  }
}

// The "no-agents" site an address is on, or null. A wrapper's copy is named as
// the site with the wrapper: "Booking.com (its copy on the Wayback Machine)".
function linkOnlySiteOf(rawUrl) {
  if (LINK_ONLY_SITES === null) return null;
  const hit = LINK_ONLY.api.linkOnlyMatch(LINK_ONLY_SITES, String(rawUrl || ""));
  if (!LINK_ONLY.api.barsAgents(hit)) return null;
  return hit.via.length ? `${hit.site} (its copy on ${hit.via.join(", then ")})` : hit.site;
}

// The "no-agents" site a document's answer says it is a copy of, or null: an
// archive's Memento `Link: <…>; rel="original"` header names the page it
// copies even at a short address (archive.ph/AbCdE) that names no site.
// `headers` are CDP's [{ name, value }].
function linkOnlyCopyOf(headers, rawUrl) {
  if (LINK_ONLY_SITES === null) return null;
  const link = (Array.isArray(headers) ? headers : [])
    .filter((header) => String(header?.name || "").toLowerCase() === "link")
    .map((header) => String(header?.value || ""));
  const hit = link.length ? LINK_ONLY.api.linkOnlyCopyOf(LINK_ONLY_SITES, link, String(rawUrl || "")) : null;
  return LINK_ONLY.api.barsAgents(hit) ? `${hit.site} (a page that says it is a copy of it)` : null;
}

const LIST_UNAVAILABLE_MESSAGE =
  "The link-only site list is unavailable, so Octo opens, reads and does nothing in any tab. Nothing was opened, read or done.";
// A refused address ends that address, not the task: a search engine or a
// listing the turn chose itself leads on to the source's own site, and only a
// site the person asked for is theirs to open.
const SEND_PAGE_HINT =
  'Go on with the maker\'s, venue\'s or reviewer\'s own site; give the person this link only if they asked for this site: they may open it themselves and, if they want Octo to see it, use "Send page to Octo".';

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

// `destinationUrl`: the exact address the step loads, when it loads one. The
// site's prompt is bound to it and its label names it. `label` may be a
// function, so a label that masks an address is made only when a prompt shows.
// This process runs one step. Set once the step waited on a prompt and the
// person allowed it, so its activity says it was allowed at its prompt.
let stepAllowedAtPrompt = false;
// What the step is, once the browser has judged it and before it asks the
// person: a search, or a form sent. A step the person says no to, or leaves
// unanswered, ends in an error, and its kind still names the clause the turn's
// line says ("you said no to a search"). Only these words, never page text.
const FAILED_STEP_KINDS = new Set(["search", "submit"]);
let stepKind = null;
// Which of the person's own steps the browser refused to take (the action
// policy's category: accepting a consent banner, signing in, choosing a
// file, showing a credential, typing a password, code or payment detail), so
// the turn's Details names it for what it was. Only these words.
const REFUSED_STEP_KINDS = new Set(["consent", "sign_in", "upload", "reveal_secret", "sensitive"]);
let refusedStep = null;

async function ensureSiteApproved(rawUrl, label, { destinationUrl = null } = {}) {
  assertStepOnTime();
  // A site the run already uses, or routine browsing, opens without a prompt.
  const prompts = !siteApproved(rawUrl);
  const origin = await stepClock.whilePersonAnswers(() => approvalProtocol.ensureOriginApproved(
    rawUrl,
    () => tabLabel(typeof label === "function" ? label() : label),
    inAgentTab() ? activePageId : null,
    { destinationUrl },
  ));
  if (prompts) {
    stepAllowedAtPrompt = true;
  }
  return origin;
}

// The address a prompt names, so the person approves the page the step will
// load and not only its site: masked like a snapshot's address (it keeps its
// host and path), and cut with "…" to fit a prompt's label.
const MAX_LABEL_ADDRESS_CHARS = 160;
function labelAddress(rawUrl) {
  const address = maskedUrl(rawUrl) || "";
  return address.length <= MAX_LABEL_ADDRESS_CHARS
    ? address
    : `${address.slice(0, MAX_LABEL_ADDRESS_CHARS - 1)}…`;
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
  assertStepOnTime();
  // Routine browsing takes a routine step without a prompt; every other step
  // waits for the person's answer.
  const prompts = !(options?.routine === true && approvalProtocol.routineBrowsingAllowed());
  const request = await stepClock.whilePersonAnswers(() => (inAgentTab()
    ? approvalProtocol.allowOnce({
      ...details,
      label: tabLabel(details.label),
      payloadFingerprint: approvalProtocol.sha256(
        JSON.stringify({ tabId: activePageId, payload: details.payloadFingerprint }),
      ),
    }, options)
    : approvalProtocol.allowOnce(details, options)));
  if (prompts) {
    stepAllowedAtPrompt = true;
  }
  return request;
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

// The page's title, or "" when it names nothing: an image or svg shown on
// its own can leave a bare media type ("image/svg+xml") as its title.
async function pageTitle(page) {
  const title = await page.title().catch(() => "");
  return typeof title === "string" && !actionPolicy.isPlaceholderName(title) ? title : "";
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
function describeInPage(rule, forms, names, element, sources) {
  const bounded = (value, max = 2_000) =>
    typeof value === "string"
      ? value.replace(/\s+/g, " ").trim().slice(0, max)
      : "";
  // A label's own words, as a person reads them beside the control: never the
  // text inside a control it holds, such as a list's options, a field's text or
  // a button's name, which are values or names of their own.
  const notLabelWords = new Set([
    "INPUT", "SELECT", "TEXTAREA", "BUTTON", "OPTION", "OPTGROUP", "DATALIST", "OUTPUT",
    "SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT",
  ]);
  const ownWords = (node) => {
    let words = "";
    const visit = (current, depth) => {
      if (depth > 32 || words.length > 4_000) return;
      for (let child = current.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          words += child.nodeValue || "";
        } else if (child.nodeType === 1 && !notLabelWords.has(String(child.tagName).toUpperCase())) {
          visit(child, depth + 1);
        }
      }
    };
    try {
      if (node) visit(node, 0);
    } catch (_) {
      return "";
    }
    return words;
  };
  const labels = bounded(
    "labels" in element && element.labels
      ? Array.from(element.labels)
          .map(ownWords)
          .join(" ")
      : "",
  );
  const ariaLabelledBy = bounded(element.getAttribute("aria-labelledby"));
  const ariaLabelledByText = bounded(
    [...new Set(ariaLabelledBy.split(/\s+/).filter(Boolean))]
      .slice(0, 32)
      .map((id) => ownWords(element.ownerDocument?.getElementById(id)))
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
  const ownForm =
    "form" in element && element.form
      ? element.form
      : element instanceof HTMLElement
        ? element.closest("form")
        : null;
  // The submission the step through this element makes, as the browser
  // computes it: its own for a submit button (formaction, formmethod,
  // formenctype and formtarget included), the implicit one through the
  // default button for Enter in a field, or the form's own when the step
  // submits nothing. Addresses are absolute, resolved against <base href>.
  let submission = null;
  try {
    submission = forms.submissionOf(element, ownForm instanceof HTMLFormElement ? ownForm : null);
  } catch (_) {
    submission = null;
  }
  const form = submission ? submission.form : ownForm;
  const formAction = bounded(submission ? submission.action : "", 4_096);
  const formMethod = bounded(submission ? submission.method : "", 32);
  const formTarget = bounded(submission ? submission.target : "", 200);
  const formEnctype = bounded(submission ? submission.enctype : "", 64);
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

    // A cookie or consent banner around the control: a container whose id,
    // class, label or test id names it, a dialog whose title does, or a
    // small container close by whose text speaks of cookies. With it, a
    // refusal's words go without a prompt and accepting words are refused
    // (the classifier's consent rejection and `step_refused_consent`). The
    // page's body and root are no banner, though a consent plugin may name
    // them after cookies ("cookies-not-set") while it waits for an answer.
    const consentPattern = /cookie|consent|gdpr|rgpd|dsgvo|privacy|datenschutz|privacidade|confidentialit/i;
    let consentContext = consentPattern.test(dialogLabel);
    const pageRoots = [element.ownerDocument?.body, element.ownerDocument?.documentElement];
    for (
      let node = element.parentElement, depth = 0;
      node && !pageRoots.includes(node) && depth < 16 && !consentContext;
      node = node.parentElement, depth += 1
    ) {
      const named = bounded(
        [attribute(node, "id"), attribute(node, "class"), attribute(node, "aria-label"),
          idText(node, "aria-labelledby"), attribute(node, "data-testid")].filter(Boolean).join(" "),
        400,
      );
      if (consentPattern.test(named)) {
        consentContext = true;
      } else if (depth < 6) {
        const raw = typeof node.textContent === "string" ? node.textContent : "";
        consentContext = raw.length <= 1_500 && /\bcookies?\b/i.test(raw);
      }
    }

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
      formActionUrl: formAction,
      formNewWindow: submission ? submission.newWindow === true : false,
      formSubmission: submission ? submission.via : null,
      formSubmits: submission ? submission.submits === true : false,
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
      consentContext,
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
    // The label or title of any other element inside the control: it only
    // names an unnamed control and never feeds the step's category, so a
    // page cannot turn a button into a menu toggle through a child's label.
    const inner = element.querySelector("[aria-label], [title]");
    const innerName = inner ? read(inner, "aria-label") || read(inner, "title") : "";
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
    // The name an image button or an input button carries in its own
    // attributes: its alt text, or its value (the browser's own "Submit" or
    // "Reset" without one).
    const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
    const type = tag === "INPUT" ? String(element.type || "").toLowerCase() : "";
    const ownName =
      tag === "IMG" || tag === "AREA" || type === "image"
        ? read(element, "alt")
        : ["submit", "reset", "button"].includes(type)
          ? read(element, "value") ?? (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "")
          : "";
    // An svg sprite's symbol (`<use href="#icon-search">`) names its icon.
    const sprite = element.querySelector("use");
    // The text beside it is read only for a control with no name of its own.
    let nearby = "";
    const ownText = (() => {
      try {
        return names.shownTextOf(element, 80);
      } catch (_) {
        return "";
      }
    })();
    if (
      !ownText && !ownName && !imageText && !innerName &&
      !read(element, "aria-label") && !read(element, "aria-labelledby") && !read(element, "title") &&
      !read(element, "placeholder") && !(element.labels && element.labels.length)
    ) {
      try {
        nearby = names.nearbyTextOf(element);
      } catch (_) {
        nearby = "";
      }
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
      innerName: bounded(innerName || "", 120),
      ownName: bounded(ownName || "", 120),
      sprite: bounded(read(sprite, "href") || read(sprite, "xlink:href") || "", 160),
      nearby: bounded(nearby, 40),
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
    formTarget,
    formEnctype,
    formActionText: form
      ? `form ${formMethod} ${formAction} ${formText}`.slice(0, 2_000)
      : "",
    labels,
    text: bounded(element.textContent || ""),
    // The text the control draws: what textContent holds, less scripts,
    // styles, an svg's metadata, title and defs, and hidden parts.
    shownText: (() => {
      try {
        return bounded(names.shownTextOf(element));
      } catch (_) {
        return bounded(element.textContent || "");
      }
    })(),
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
    innerName: text(raw?.innerName, 120),
    ownName: text(raw?.ownName, 120),
    sprite: text(raw?.sprite, 160),
    nearby: text(raw?.nearby, 40),
    hasImage: valid && raw.hasImage === true,
    position: valid && NAME_POSITIONS.has(raw.position) ? raw.position : "",
  };
}

// The hints that name a control, without the ones that change while a
// person hovers (described-by tooltips), the layout moves (position) or the
// page around it updates (nearby text), so fingerprints stay stable across
// an approval.
function stableNameHints(description) {
  const hints = description.nameHints || nameHintsOf(null);
  return {
    tooltip: hints.tooltip, image: hints.image, innerName: hints.innerName, ownName: hints.ownName,
    sprite: hints.sprite, hasImage: hints.hasImage,
  };
}

// Page functions run inside the page: Playwright sends their source, so they
// cannot use anything from this file's scope. The two that judge what a
// person can see get the rule's source joined in front, so controls and text
// are judged by one copy of it. Only this file's own functions are joined.
function withShownRule(pageFunction) {
  return new Function("...args", `return (${pageFunction})((${shownRuleInPage})(), ...args);`);
}
// The describer also gets the form submission rules (formSubmission.js),
// joined in the same way.
const DESCRIBE_IN_PAGE = new Function(
  "...args",
  `return (${describeInPage})((${shownRuleInPage})(), (${formSubmission.formSubmissionRulesInPage})(), (${actionPolicy.controlNameRulesInPage})(), ...args);`,
);
// The same describer for every control of a page in one call: its source (over
// 50 KB with the rules it carries) is sent and compiled once per read of the
// page, not once per control. Each control is described on its own, as with
// DESCRIBE_IN_PAGE, and one that cannot be described is null.
const DESCRIBE_ALL_IN_PAGE = new Function(
  "request",
  `const describe = ${DESCRIBE_IN_PAGE};
  return request.elements.map((element) => {
    try {
      return describe(element, request.sources);
    } catch (_) {
      return null;
    }
  });`,
);
const SHOWN_TEXT_IN_PAGE = withShownRule(shownTextInPage);
const AREA_NAMES = new Set(["dialog", "menu", "tabs", "nav", "search", "header", "footer", "aside"]);

// `hiddenNames` collects one name, empty when it has none, for each control a
// person cannot see; they are left out of the observation but still count for
// the secret-screen check, and their number tells the model some are left out.
// `described`: what DESCRIBE_ALL_IN_PAGE said of this control, when it was
// read with the rest of the page.
async function describeElement(locator, index, hiddenNames, described = undefined) {
  const attributes = described !== undefined
    ? described
    : await locator.evaluate(DESCRIBE_IN_PAGE, PAGE_POLICY_SOURCES).catch(() => null);
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
  const shownText = typeof attributes.shownText === "string" ? attributes.shownText : attributes.text;
  // Text that names nothing (a bare media type an svg's metadata leaves)
  // is skipped.
  const named = [
    attributes.ariaLabel,
    attributes.ariaLabelledByText,
    attributes.labels,
    attributes.placeholder,
    attributes.titleAttribute,
    nameHints.ownName,
    shownText,
    attributes.nameAttribute,
  ]
    .find((value) => typeof value === "string" && value.trim() && !actionPolicy.isPlaceholderName(value))
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
      // An inner element's label names an unnamed control like its image.
      image: nameHints.image || nameHints.innerName,
      iconHint: [policy ? policy.iconHint : "", nameHints.sprite].filter(Boolean).join(" "),
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
    shownText: typeof shownText === "string" ? shownText : "",
    href: attributes.href,
    inputType: attributes.inputType,
    autocomplete: attributes.autocomplete,
    inputMode: attributes.inputMode,
    formAction: attributes.formAction,
    formMethod: attributes.formMethod,
    formTarget: typeof attributes.formTarget === "string" ? attributes.formTarget : "",
    formEnctype: typeof attributes.formEnctype === "string" ? attributes.formEnctype : "",
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
    formNewWindow: raw.formNewWindow === true,
    formSubmission: ["button", "implicit", "nested", ""].includes(raw.formSubmission) ? raw.formSubmission : null,
    formSubmits: raw.formSubmits === true,
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
    consentContext: raw.consentContext === true,
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
    // What the control draws, for the visible label prompts show; risk words
    // still read every text inside it.
    shownText: typeof description.shownText === "string" ? description.shownText : undefined,
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
    formNewWindow: facts.formNewWindow === true,
    formSubmission: typeof facts.formSubmission === "string" ? facts.formSubmission : null,
    formSubmits: facts.formSubmits === true,
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
    consentContext: facts.consentContext === true,
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

// Revealing or copying a credential, signing in, choosing files and
// accepting a cookie banner are the user's steps in every mode. Refused
// before any prompt is shown.
function refuseUserStep(classification) {
  if (classification.verdict !== "refuse") {
    return;
  }
  if (REFUSED_STEP_KINDS.has(classification.category)) {
    refusedStep = classification.category;
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

// A control's masked names: the text it shows, then its other name when the
// two differ ("Agree and close", also called "Agree and close: Agree to our
// data processing and close"). The text it shows leads: it is what the
// person finds on the page, and the other name can say more than it shows.
function controlNames(description) {
  const labels = actionPolicy.stepLabels(policyTarget(description));
  return labels.differ
    ? { shown: maskedDisplayText(labels.visible), other: maskedDisplayText(labels.accessible) }
    : { shown: maskedDisplayText(description.label), other: "" };
}

// The control's name, quoted, for the action log and the ticker:
// `"Agree and close" (also called "Agree and close: Agree to our data processing and close")`.
function quotedControlLabel(description) {
  const { shown, other } = controlNames(description);
  const bounded = (value) => Array.from(value).slice(0, MAX_LABEL_CHARS).join("");
  return other ? `"${bounded(shown)}" (also called "${bounded(other)}")` : `"${bounded(shown)}"`;
}

// A prompt's label, with its category and tab, fits the approval's 240
// bytes, so each name and the list of sent fields are cut on their own.
const PROMPT_NAME_BYTES = 44;
const PROMPT_FIELDS_BYTES = 80;

// `value` cut to `maxBytes` of UTF-8 between characters, ending in "…" when cut.
function boundedBytes(value, maxBytes) {
  const text = String(value || "");
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let kept = "";
  let bytes = Buffer.byteLength("\u2026");
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    kept += character;
    bytes += size;
  }
  return `${kept.trimEnd()}\u2026`;
}

// The sent fields as a prompt lists them: as many whole names as fit, then
// "and 2 more".
function sentFieldsText(names) {
  const listed = [];
  for (const [index, name] of names.entries()) {
    const rest = names.length - index - 1;
    const text = [...listed, name].join(", ") + (rest > 0 ? ` and ${rest} more` : "");
    if (Buffer.byteLength(text) > PROMPT_FIELDS_BYTES) break;
    listed.push(name);
  }
  const more = names.length - listed.length;
  if (listed.length === 0) return names.length === 1 ? "1 field" : `${names.length} fields`;
  return more > 0 ? `${listed.join(", ")} and ${more} more` : listed.join(", ");
}

// The control's name in a prompt, the text it shows first and each name cut
// on its own, and for a step that sends a form the fields it sends, never
// their values: `Submit order · Sends: Customer name, Telephone`.
function promptLabel(description, fallback, sentFields = []) {
  const { shown, other } = controlNames(description);
  const name = !shown
    ? fallback
    : other
      ? `${boundedBytes(shown, PROMPT_NAME_BYTES)} (also called "${boundedBytes(other, PROMPT_NAME_BYTES)}")`
      : boundedBytes(shown, 2 * PROMPT_NAME_BYTES);
  return sentFields.length > 0 ? `${name} \u00b7 Sends: ${sentFieldsText(sentFields)}` : name;
}

// A list's own name, masked, for a choice: its label ("Start") or its title,
// never the option it holds or its options, which are values. Empty when it
// has none.
function listOwnName(description) {
  const target = policyTarget(description);
  const name = [target.ariaLabel, target.title]
    .map((value) => String(value || "").replace(/\s+/g, " ").trim())
    .find((value) => value && !actionPolicy.isPlaceholderName(value));
  return name ? maskedDisplayText(name) : "";
}

// A choice in a prompt: the option, then the list it is in by the list's own
// name, each cut on its own (`São Bento · In: Start`), or the option alone
// for a list with no name of its own.
function choicePromptLabel(description, option) {
  const list = listOwnName(description);
  const name = boundedBytes(maskedDisplayText(option), 2 * PROMPT_NAME_BYTES);
  return list ? `${name} \u00b7 In: ${boundedBytes(list, PROMPT_NAME_BYTES)}` : name;
}

// The controls a person can see, in document order. Snapshots and actions
// both index this list, so an index means the same control in both. The page
// is asked once for its controls and once to describe them all: asking for
// each control on its own would send the describer again for every one, which
// takes seconds on a page with a few hundred links, and a click or a choice
// reads the page twice (its check, then its result).
async function collectInteractiveElements(page, hiddenNames = null) {
  const handles = (await page.locator(INTERACTIVE_SELECTOR).elementHandles())
    .slice(0, MAX_INTERACTIVE_ELEMENTS * 3);
  const described = await page
    .evaluate(DESCRIBE_ALL_IN_PAGE, { elements: handles, sources: PAGE_POLICY_SOURCES })
    .catch(() => null);
  // A page that could not answer for all of them at once is asked for each
  // control on its own.
  const together = Array.isArray(described) && described.length === handles.length;
  const elements = [];
  for (let ordinal = 0; ordinal < handles.length; ordinal += 1) {
    const locator = handles[ordinal];
    // The shown rule in describeInPage covers what Playwright's isVisible
    // checks (rendered, visibility visible, a box with a size).
    const description = await describeElement(
      locator,
      elements.length,
      hiddenNames,
      together ? described[ordinal] ?? null : undefined,
    );
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
    shownText: description.shownText,
    href: description.href,
    inputType: description.inputType,
    autocomplete: description.autocomplete,
    inputMode: description.inputMode,
    formAction: description.formAction,
    formMethod: description.formMethod,
    formTarget: description.formTarget,
    formEnctype: description.formEnctype,
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
        shownText: description.shownText,
        href: description.href,
        inputType: description.inputType,
        autocomplete: description.autocomplete,
        inputMode: description.inputMode,
        formAction: description.formAction,
        formMethod: description.formMethod,
        formTarget: description.formTarget,
        formEnctype: description.formEnctype,
        formActionText: description.formActionText,
        policy: description.policy,
        nameHints: stableNameHints(description),
      }),
    )
    .digest("hex");
}

// A field the person may be asked to fill (request_human_input).
const EDITABLE_FIELD_TAGS = new Set(["input", "textarea", "select"]);

// One editable field as a pause on fields checks it: its index, label and
// kind, and where its form sends, on the page's address. Unlike a snapshot's
// fingerprint, nothing else on the page is in it, so controls a page adds or
// changes elsewhere after it loads (a passkey button, a banner) leave it as it
// was.
function fieldFingerprint(url, description) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        pageId: activePageId,
        url,
        index: description.index,
        label: description.label,
        tag: description.tag,
        role: description.role,
        inputType: description.inputType,
        formAction: description.formAction,
        formMethod: description.formMethod,
      }),
    )
    .digest("hex");
}

// Records the editable fields a snapshot of the page the person chose shows,
// for request_human_input (approvalProtocol.recordObservedFields). Octo's own
// tabs are for reading and never ask the person to fill a field. Without the
// record, a pause checks the whole page, as before.
function recordObservedFields(snapshotId, url, interactive) {
  if (inAgentTab()) return;
  const fields = interactive
    .filter(({ description }) => EDITABLE_FIELD_TAGS.has(description.tag))
    .slice(0, approvalProtocol.maxObservedFields)
    .map(({ description }) => ({ index: description.index, field: fieldFingerprint(url, description) }));
  if (!fields.length) return;
  try {
    approvalProtocol.recordObservedFields(snapshotId, fields);
  } catch (_) {
    // The pause checks the whole page instead.
  }
}

// Whether the fields a pause highlights are the ones Octo saw in the snapshot
// it names: each at its index with the same label and kind, in a form that
// sends to the same place, on the same address. The rest of the page may have
// changed since. A snapshot with no
// record of those fields is checked whole, as every step is.
function humanInputFieldsAsObserved(url, interactive, body) {
  const observed = approvalProtocol.observedFields(body.snapshotId);
  if (observed && body.indices.every((index) => observed.has(index))) {
    return body.indices.every((index) => {
      const entry = interactive[index];
      return Boolean(entry) && observed.get(index) === fieldFingerprint(url, entry.description);
    });
  }
  return snapshotFingerprint(url, interactive) === body.snapshotId;
}

// What the model reads about one control. Empty fields are left out to keep
// the observation small; the box stays internal, where the visible cursor
// uses it. A select says which option it holds (`chosen`), as a person sees it
// closed; `choose` sets it.
function publicElementDescription(description) {
  const entry = { index: description.index, label: description.label, tag: description.tag };
  for (const field of ["role", "href", "inputType", "autocomplete", "area", "chosen"]) {
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

// A page is read in several steps, and it can change documents in between: a
// timed redirect that commits while the text is read, or a load the step's
// document guard does not see (a page restored from the back/forward cache,
// an activated prerender, a navigation a service worker answers). So the page
// is checked against the link-only list when the read starts and again once
// everything is read, and a read that ended on another site than it started
// on reports nothing.
function assertReadStayedOnOneSite(page, startUrl) {
  refuseLinkOnlyPage(page);
  if (approvalProtocol.normalizedOrigin(page.url()) !== approvalProtocol.normalizedOrigin(startUrl)) {
    throw new Error(
      "The page moved on to another site while Octo read it, so nothing was read. Take a fresh snapshot.",
    );
  }
}

// The model-facing view of the page: what a person can see of it. Text,
// title, address, control names and link targets are masked on every site and
// in every approval mode; a secret screen withholds the text and stays
// withheld until a new page loads. Whether a page is a secret screen is still
// judged on all of its rendered text and every control's name, seen or not.
async function snapshot(page, { withhold = false } = {}) {
  const startUrl = page.url();
  refuseLinkOnlyPage(page);
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
  const title = await pageTitle(page);
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
  assertReadStayedOnOneSite(page, startUrl);
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
  // A page that is not blank but reads with no text and no controls has not
  // drawn yet (still loading, or hidden while it loads). It is answered as
  // busy, never as an empty page, so Octo reads it again instead of taking
  // "nothing" for what the page says.
  if (!view.secretScreen && !view.text.trim() && interactive.length === 0) {
    return addressOnly(page);
  }
  const pageOrigin = pageOriginOf(rawUrl);
  const maskLink = (href) => {
    if (!href) return href;
    const masked = redaction.redactUrl(href).text;
    return sameSitePath(pageOrigin, view.secretScreen ? strictlyMasked(masked) : masked);
  };
  // A sign-in page names its fields, so a sign-in the person needs pauses on
  // them for the person instead of ending the turn; a page with none yet names
  // the control that opens the sign-in page ("Sign in" in its header). Octo's
  // own tabs are for reading and never ask the person to fill fields.
  const signInHint = inAgentTab() || view.secretScreen ? null : signInHintOf(interactive);
  const snapshotId = snapshotFingerprint(rawUrl, interactive);
  recordObservedFields(snapshotId, rawUrl, interactive);
  return {
    snapshotId,
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
        // The option a select holds, page text masked like a control's name;
        // a secret screen lists none.
        chosen: isSelectDescription(description) && !view.secretScreen
          ? strictlyMasked(Array.from(description.shownText || "").slice(0, MAX_LABEL_CHARS).join(""))
          : "",
      }),
    ),
    // How many controls were left out because a person cannot see them yet,
    // so a cut list does not read as the whole page.
    ...(hiddenNames.length ? { omittedControls: hiddenNames.length } : {}),
    ...(signInHint ? { signIn: signInHint } : {}),
  };
}

// The one rule for a sign-in, as the policies and the browser skill state it:
// a sign-in the person asked for, or one a step they asked for needs, is
// opened and paused on for them; otherwise Octo never signs in, and a page
// that shows only a sign-in ends there, not the task. Neither hint says a page
// ends: a readable page with a sign-in link or a login box stays readable.
const SIGN_IN_WHEN = "If the person asked to sign in, or a step they asked for needs it,";

function signInHintOf(interactive) {
  const fields = interactive
    .filter(({ description }) => actionPolicy.isSignInField(policyTarget(description)))
    .map(({ description }) => description.index)
    .slice(0, 8);
  if (fields.length) {
    return {
      fields,
      next: `Signing in is the person's step. ${SIGN_IN_WHEN} call request_human_input with this snapshotId and these fields' indices, then end the turn: they sign in on the page and choose Let Octo continue. Otherwise never sign in: use what the page shows without it and go on with the task. Never type into these fields.`,
    };
  }
  const opener = interactive.find(({ description }) => actionPolicy.isSignInOpener(policyTarget(description)));
  if (!opener) return null;
  return {
    open: opener.description.index,
    next: `This opens the site's sign-in page. ${SIGN_IN_WHEN} click it, then pause on the sign-in page's fields with request_human_input. Otherwise leave it.`,
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
      "The page is blank. Call navigate with the http(s) address the task names, or, when it names none, with the official site of what the task is about; any approval the browser asks for applies there.",
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
  // A link-only page's title and address are not read into the feed either.
  const linkOnlySite = linkOnlySiteForPage(page);
  if (linkOnlySite) {
    emitAction({
      type: "nav_result",
      label: `Page changed to ${linkOnlySite}, which is link-only`,
      url: null,
    });
    return;
  }
  if (!siteApproved(page.url())) {
    emitAction({
      type: "nav_result",
      label: "Page changed to an unapproved origin",
      url: null,
    });
    return;
  }
  const title = await pageTitle(page);
  emitAction({
    type: "nav_result",
    label: title
      ? redaction.redactText(title, { credentialContext: redaction.hasCredentialWord(title) }).text
      : page.url(),
    url: page.url(),
  });
}

// The control a step is for, by its index in the snapshot Octo observed: the
// page must still read as that snapshot did (the run, the tab, the address and
// every control), so the index names the control Octo saw. `asked` keeps what
// the person is asked about, for approvedTarget: that very control, the page's
// address and the text around the control.
async function targetLocator(page, body) {
  const interactive = await collectInteractiveElements(page);
  if (body.snapshotId !== snapshotFingerprint(page.url(), interactive)) {
    pageChangedUnderStep = true;
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
  const place = await controlPlace(target.locator);
  return { ...target, asked: { locator: target.locator, url: page.url(), around: place ? place.around : null } };
}

// After the person's answer, the step acts on the control they were asked
// about, whatever else on the page changed while they read the prompt: a
// carousel's slide, a clock, a live count. It is that very control, still
// shown, on the same address (its fragment too, which some sites keep their
// page in), with the same text around it (aroundTextInPage: its card, its
// form's labels), so a product, an order or a total that changed beside it is
// asked about again. A control the page drew again in its place stands for it only
// on a page that reads exactly as Octo's snapshot did. Anything else is not
// used (controlChanged). The run's authority is read again last, so a
// take-over or a new run still ends the step there. `around: false` leaves
// the text around it out, for the check right after the step's own focus,
// which may open a list beside a field.
async function approvedTarget(page, body, asked, { around = true } = {}) {
  const place = await controlPlace(asked.locator);
  let target = null;
  let placeNow = place;
  if (place && place.connected) {
    const description = await describeElement(asked.locator, body.index, null);
    target = description ? { locator: asked.locator, description } : null;
  } else {
    const interactive = await collectInteractiveElements(page);
    if (body.snapshotId === snapshotFingerprint(page.url(), interactive) && interactive[body.index]) {
      target = interactive[body.index];
      placeNow = await controlPlace(target.locator);
    }
  }
  if (
    !target ||
    page.url() !== asked.url ||
    (around && (!placeNow || asked.around === null || placeNow.around !== asked.around))
  ) {
    throw controlChanged();
  }
  approvalProtocol.authority();
  return { ...target, asked };
}

// Runs inside the page through Playwright, so it must not use anything from
// this file's scope. Whether the control is still in the page, and the text
// around it that tells what it acts on: that of the nearest element around it
// whose text is more than the control's own (a product's card, a form with its
// labels, a table's row), when that is a small part of the page. Text further
// away, such as a carousel elsewhere or a clock in the header, is not in it.
function aroundTextInPage(element, request) {
  const max = Math.min(Math.max(Number(request && request.maxChars) || 0, 0), 4_000);
  const textOf = (node) => String((node && node.textContent) || "").replace(/\s+/g, " ").trim();
  const own = textOf(element);
  let around = "";
  for (let node = element.parentElement; node; node = node.parentElement) {
    const text = textOf(node);
    if (text !== own) {
      around = text.length <= max ? text : "";
      break;
    }
  }
  return { connected: element.isConnected === true, around };
}

const AROUND_TEXT_MAX_CHARS = 2_000;
async function controlPlace(locator) {
  const place = await locator
    .evaluate(aroundTextInPage, { kind: "around-text", maxChars: AROUND_TEXT_MAX_CHARS })
    .catch(() => null);
  return place && typeof place === "object" && typeof place.connected === "boolean" &&
    typeof place.around === "string"
    ? { connected: place.connected, around: place.around.slice(0, AROUND_TEXT_MAX_CHARS) }
    : null;
}

// Set when a step the person said yes to was not done because its control
// changed. The failed command says so on stdout, and runtime-agent ends the
// run at the second such step, so a page that keeps changing never turns into
// a chain of prompts.
let changedAfterYes = false;

// Set when a step was not done because the page changed under it while nobody
// was asked: its snapshot no longer reads as the page, or the control or the
// fields it was for are not there as they were. The failed command says so on
// stdout, and runtime-agent counts such steps in a row, so a page that never
// holds still (a live count, a ticker) ends that page instead of a loop of
// snapshots.
let pageChangedUnderStep = false;

// The control a step is for is not on the page as it was when the step was
// judged, so nothing was done. This does not end the run: Octo looks at the
// page again and, if the step still fits, does it again, which asks the person
// again when it asked them before.
function controlChanged() {
  if (stepAllowedAtPrompt) {
    changedAfterYes = true;
  } else {
    pageChangedUnderStep = true;
  }
  return new Error(
    stepAllowedAtPrompt
      ? "The page changed after the person said yes, and the control this step was for is not there as it was, so nothing was done. Take a fresh snapshot and do the step again if it still fits the request: it asks the person again."
      : "The page changed before this step ran, and the control it was for is not there as it was, so nothing was done. Take a fresh snapshot and do the step again if it still fits the request.",
  );
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

// What a list says about itself, for the check below: everything a field's
// description holds but the text inside it (every option), the option it
// holds, and the name a snapshot gives it, which is that option when it has
// no label.
function listContent(description) {
  return descriptionContent({ ...description, label: "", text: "", valueAttribute: "" });
}

// Authentication, payment and identity fields are the person's to fill: a
// step that types into one, presses a key in one or chooses its option is
// refused.
function assertSafeTypeTarget(description, step = "type") {
  const sensitiveAutocomplete = new Set([
    "current-password",
    "new-password",
    "one-time-code",
  ]);
  const autocompleteTokens = String(description.autocomplete || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  // A list is judged by its own names and its form, never its options: they
  // are values ("Suzuki Swift" in a list of cars is no payment detail).
  const content = step === "choose" ? listContent(description) : descriptionContent(description);
  const sensitiveLabel =
    /\b(password|passcode|pin|otp|2fa|mfa|one[- ]?time|verification[\s_-]*code|security[\s_-]*code|auth(?:entication)?[\s_-]*code|login[\s_-]*code|access[\s_-]*code|api[\s_-]*key|client[\s_-]*secret|secret|private[\s_-]*key|seed[\s_-]*phrase|recovery[\s_-]*phrase|wallet|credit[\s_-]*card|card[\s_-]*number|cvv|cvc|social[\s_-]*security|government[\s_-]*id|passport|driver(?:'s)?[\s_-]*licen[cs]e|tax[\s_-]*id|date[\s_-]*of[\s_-]*birth|birthdate|maiden[\s_-]*name|bank[\s_-]*account|routing[\s_-]*number|iban|swift)\b/i;
  if (
    String(description.inputType || "").toLowerCase() === "password" ||
    autocompleteTokens.some(
      (token) => sensitiveAutocomplete.has(token) || token.startsWith("cc-"),
    ) ||
    sensitiveLabel.test(content)
  ) {
    refusedStep = "sensitive";
    throw new Error(
      step === "choose"
        ? "Shared Browser does not choose options in authentication, payment, or identity fields; let the user choose this value directly"
        : "Shared Browser refuses to type authentication, payment, or identity secrets; let the user enter this value directly",
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
// French, Spanish, Italian, Portuguese and Dutch, as the classifier has them:
// buy, pay, order and check out, confirm an order or a payment, send, delete
// and save, and cancel where it ends a contract, subscription or booking, as
// "stornieren" does. A bare cancel ("Annuler", "Cancelar"), which also closes
// a dialog, stays out as "cancel" does, and so do "commander" and "payer",
// which are English words too ("Jeep Commander", "single-payer"); the
// classifier still asks for those on a control. A Dutch verb before a hyphen
// starts a shortened compound ("Verzend- en retourbeleid"), so it is no verb
// there.
const CONSEQUENTIAL_ACTION_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[
    "buy", "purchase", "pay", "checkout", "place[\\s_-]*order", "delete", "remove", "erase", "destroy", "send",
    "post", "publish", "submit", "authorize", "approve", "allow", "confirm[\\s_-]*(?:order|payment|purchase)",
    "transfer", "withdraw", "book", "reserve", "sign[\\s_-]*(?:contract|document|agreement)", "save", "finalize",
    "mark[\\s_-]*(?:as[\\s_-]*)?paid",
    "speichern", "buchen", "verbuchen", "(?:um|aus|ab|rück|zurück|gegen|storno)buchen", "übermitteln", "einreichen",
    "abgeben", "ausstellen", "festschreiben", "als[\\s_-]*bezahlt", "bezahlen", "überweisen", "freigeben", "absenden",
    "versenden", "löschen", "stornieren",
    // French.
    "acheter", "achetez", "j['’]ach[èe]te", "payez", "commandez", "je[\\s_-]*(?:commande|pa(?:ie|ye))",
    "(?:passer|valider|finaliser|confirmer|terminer)[\\s_-]*(?:(?:la|ma|votre|une)[\\s_-]*)?commande",
    "je[\\s_-]*(?:passe|valide|confirme|finalise|termine)[\\s_-]*(?:(?:la|le|ma|mon|votre)[\\s_-]*|l['’]\\s*)?" +
      "(?:commande|panier|achat|paiement)",
    "(?:valider|finaliser|confirmer)[\\s_-]*(?:l['’]\\s*|mon[\\s_-]*|votre[\\s_-]*)?achat",
    "valider[\\s_-]*(?:(?:le|mon|votre)[\\s_-]*)?panier", "confirmer[\\s_-]*(?:le[\\s_-]*)?paiement",
    "envoyer", "envoyez", "j['’]envoie", "supprimer", "effacer", "r[ée]silier", "je[\\s_-]*(?:supprime|r[ée]silie)",
    "j['’]efface", "enregistrer", "sauvegarder", "j['’]enregistre", "je[\\s_-]*sauvegarde",
    // Spanish and Portuguese.
    "comprar", "c[óo]mpralo", "pagar", "encomendar",
    "pedir[\\s_-]*(?:ahora|ya)", "(?:ir|proceder|continuar)[\\s_-]*al[\\s_-]*pago",
    "(?:finalizar|concluir|tramitar|realizar|hacer|fazer|confirmar|completar|efe(?:c)?tuar)[\\s_-]*" +
      "(?:(?:el|la|mi|tu|su|a|o|sua|seu|minha|meu)[\\s_-]*)?(?:compra|pedido|encomenda|pago|pagamento)",
    "fechar[\\s_-]*(?:(?:o|a)[\\s_-]*)?(?:pedido|compra|encomenda)",
    "enviar", "eliminar", "borrar", "suprimir", "apagar", "excluir", "dar(?:me|se)?[\\s_-]*de[\\s_-]*baja",
    "guardar", "salvar",
    // Italian.
    "acquistare", "pagare", "procedi[\\s_-]*all['’]\\s*(?:acquisto|ordine)",
    "procedi[\\s_-]*con[\\s_-]*(?:l['’]\\s*)?ordine", "concludi[\\s_-]*(?:l['’]\\s*)?(?:acquisto|ordine)",
    "vai[\\s_-]*alla[\\s_-]*cassa",
    "inviare", "eliminare", "cancellare", "disdici", "disdire", "salvare",
    // Dutch.
    "kopen", "koop[\\s_-]*nu", "betalen", "betaal(?!-)", "bestel(?!-)", "afrekenen", "reken[\\s_-]*af",
    "naar[\\s_-]*de[\\s_-]*kassa", "bestelling[\\s_-]*(?:plaatsen|afronden|bevestigen)",
    "(?:plaats|bevestig)[\\s_-]*(?:(?:je|jouw|uw|de)[\\s_-]*)?(?:bestelling|betaling)", "betaling[\\s_-]*bevestigen",
    "verzend(?!-)", "versturen", "verstuur", "verwijderen", "verwijder(?!-)", "opzeggen", "opslaan",
  ].join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);
// Words that are also a headline's verb ("Apple acquista una startup",
// "Governo elimina portagens") count only where a button puts its verb, first
// in one of a control's own names, after marks, an icon font's name or a
// "yes", or right after an "and" ("Elimina account", "Paga ora", "Sì,
// elimina", "Prenota e paga"), and never in an address: an article's address
// holds its headline. Dutch "verzenden" is shipping too ("Verzenden en
// retourneren"), so it counts last in a name, where Dutch puts the verb
// ("Bericht verzenden"). The classifier has the same words.
const CONSEQUENTIAL_FIRST_IN_NAME = new RegExp(
  "(?:^(?:[^\\p{L}\\p{N}]|[a-z]+(?:_[a-z]+)+(?![\\p{L}\\p{N}])|(?:yes|ok|oui|s[iìí]|sim|ja)(?![\\p{L}\\p{N}]))*" +
    "|(?<![\\p{L}\\p{N}])(?:e|ed|y|et)\\s+)" +
    `(?:${[
      "compra", "compre", "paga", "pague", "acquista", "ordina[\\s_-]*(?:ora|adesso|subito)",
      "(?:conferma|completa|finalizza)[\\s_-]*(?:l['’]\\s*)?acquisto",
      "(?:effettua|conferma|completa|invia)[\\s_-]*(?:l['’]\\s*)?ordine", "conferma[\\s_-]*(?:il[\\s_-]*)?pagamento",
      "invia", "env[íi]a", "envíe", "elimina", "elimine", "cancella", "borra", "borre", "apague", "exclua", "salva",
    ].join("|")})(?![\\p{L}\\p{N}-])`,
  "iu",
);
const CONSEQUENTIAL_LAST_IN_NAME = /(?<![\p{L}\p{N}])verzenden[^\p{L}\p{N}]*$/iu;

// The control's own names and address, the fields the Desktop Personal
// Browser's high-impact check reads, plus its id and name attributes. Never
// its structure: every <button> without a type attribute reports the input
// type "submit", every control in a POST form reports the method "post", and
// formActionText carries the text of the whole form, so scanning them made
// every typeless menu button, and every control on a page wrapped in one
// form, ask under routine browsing. Form submission is checked on its own
// (isFormSubmissionControl).
function controlNameContent(description) {
  return [...controlOwnNames(description), description.href]
    .filter((value) => typeof value === "string")
    .join(" ")
    .trim();
}

// The same names one by one, without the address.
function controlOwnNames(description) {
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
    hints.tooltip,
    hints.image,
  ].filter((value) => typeof value === "string");
}

// A word that counts only first or last in one name.
function hasPlacedConsequentialWord(name) {
  return CONSEQUENTIAL_FIRST_IN_NAME.test(name) || CONSEQUENTIAL_LAST_IN_NAME.test(name);
}

function isConsequentialAction(description) {
  return CONSEQUENTIAL_ACTION_PATTERN.test(controlNameContent(description)) ||
    controlOwnNames(description).some(hasPlacedConsequentialWord);
}

function isFormSubmissionControl(description) {
  const tag = String(description.tag || "").toLowerCase();
  const type = String(description.inputType || "").toLowerCase();
  return (
    (tag === "input" && ["submit", "image"].includes(type)) ||
    (tag === "button" && type !== "button" && type !== "reset" &&
      Boolean(description.formAction || description.formMethod || description.formActionText)) ||
    // An element whose click reaches a submit button (its label, anything
    // inside it, a field inside it) submits too.
    ["button", "nested"].includes(description.policy?.formSubmission)
  );
}

// The form submission a step makes, from the page's own answer: a click,
// Enter or Space on a submit button, Enter in a form's field or typing with
// submit. Null when the step submits no form, or the page did not say.
function stepFormSubmission(description, step, key = "") {
  return formSubmission.stepSubmission(policyTarget(description), step, key === "Space" ? " " : key);
}

// Octo uses no other windows: a form step whose submission opens one
// ("_blank", or a window name that is no frame of the page) is refused
// before it asks. A window a page opens by itself is still stopped and
// closed by the step's guard. Nor does Octo take a form step through a field
// inside a submit button: a click sends the form through that button and
// Enter through the default button, which can go elsewhere.
function refuseNewWindowOrNestedSubmission(submission) {
  if (submission && submission.newWindow) {
    throw new Error(
      "This form opens another window, which Octo never uses, so it was not submitted. Nothing was sent. Open the address with open_tab instead, or leave the form to the person.",
    );
  }
  if (submission && submission.nested) {
    throw new Error(
      "This control sits inside the form's submit button, so a click and Enter send the form in different ways. Octo takes neither, so nothing was sent. Leave this form to the person.",
    );
  }
}

// The sites the page a step acts on may send a form to (POST) while the step
// runs, enforced by the step's guard on the request itself, so a page that
// moves its form between the check and the step (a keydown or click
// handler), or a submit button the page describer cannot see (in a closed
// shadow tree, or laid over the control), sends nothing elsewhere. A form
// step may post to the page's own site and the site it was approved for; an
// ordinary step (one routine browsing takes without asking) to the page's
// own site only. A step the person approved that sends no form of its own is
// not limited: a page may build and send one after it, as checkout pages do.
// A page the step went on to load is not the one it acted on, so the limit
// ends when one does. Like the link-only check, it covers the tab's own
// document, not the page's frames: a form the page sends into one of its
// frames goes out like any other request the page's script makes.
function stepPostOrigins(readingStep, sourceOrigin, submission, destination) {
  if (submission) return [sourceOrigin, destination.destinationOrigin];
  return readingStep ? [sourceOrigin] : null;
}

// Runs inside the page with the form submission rules joined in front
// (FORM_ENTRIES_IN_PAGE), so it must not use anything from this file's scope.
// The [name, value] entries Enter in `element` sends: every control of the
// form the browser would include, hidden fields and the default button's
// value too. The field's own entry is at `own`; a type step replaces its
// value, so the page is never given the text (`keepOwn: false` reports it as
// null). Read from the controls themselves, never with new FormData(), which
// would run the page's formdata handlers, and through HTMLFormElement's own
// `elements`, which a control named "elements" shadows on the form. A form
// the rules cannot read in full (a file chooser, a form-associated custom
// element, too many entries), or a field that sends nothing of its own (no
// name), is reported incomplete, and the step asks.
function formEntriesInPage(forms, element, request) {
  const MAX_ENTRIES = 64;
  const MAX_CHARS = 4_097;
  const incomplete = { kind: "form-entries", complete: false, entries: [], own: -1 };
  let implicit = null;
  let controls = [];
  try {
    implicit = forms.implicitSubmission(element);
    if (!implicit || implicit.blocked || !(implicit.form instanceof HTMLFormElement)) return incomplete;
    controls = Array.from(Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "elements").get.call(implicit.form));
  } catch (_) {
    return incomplete;
  }
  const bounded = (value) => String(value).slice(0, MAX_CHARS);
  const entries = [];
  let own = -1;
  // The values one control sends, as the browser builds the form's entries.
  const valuesOf = (control, tag, type) => {
    if (tag === "BUTTON" || (tag === "INPUT" && ["submit", "image", "reset", "button"].includes(type))) {
      return control === implicit.button && type !== "image" ? [control.value] : [];
    }
    if (tag === "INPUT" && (type === "checkbox" || type === "radio")) return control.checked ? [control.value] : [];
    if (tag === "SELECT") return Array.from(control.selectedOptions || [], (option) => option.value);
    return tag === "INPUT" || tag === "TEXTAREA" ? [control.value] : [];
  };
  for (const control of controls) {
    if (entries.length > MAX_ENTRIES) return incomplete;
    const tag = String(control.tagName || "").toUpperCase();
    if (tag.includes("-")) return incomplete;
    if (!control.name || control.matches(":disabled")) continue;
    const type = String(control.type || "").toLowerCase();
    if (tag === "INPUT" && type === "file") return incomplete;
    const name = bounded(control.name);
    const values = valuesOf(control, tag, type);
    if (control === element && values.length > 0) {
      own = entries.length;
      if (request && request.keepOwn === false) {
        entries.push([name, null]);
        continue;
      }
    }
    for (const value of values) entries.push([name, bounded(value)]);
  }
  if (entries.length > MAX_ENTRIES || own < 0) return incomplete;
  return { kind: "form-entries", complete: true, entries, own };
}

const FORM_ENTRIES_IN_PAGE = new Function(
  "...args",
  `return (${formEntriesInPage})((${formSubmission.formSubmissionRulesInPage})(), ...args);`,
);

// The fields a form step sends something from, named the way the page
// labels them, never their values (formSubmission's sentFieldNames).
const SENT_FIELDS_IN_PAGE = new Function(
  "element",
  "request",
  `return (${formSubmission.formSubmissionRulesInPage})().sentFieldNames(element, Boolean(request && request.typed));`,
);

// What a prompt says a form step sends: the fields' masked names, or none
// when the step sends no form, sends nothing (a dialog form) or the page did
// not say. `typed` is the text a type step puts in the field first.
async function sentFieldNames(target, submission, typed = null) {
  if (!submission || submission.method === "dialog") return [];
  const names = await target.locator
    .evaluate(SENT_FIELDS_IN_PAGE, { kind: "sent-fields", typed: typeof typed === "string" && typed !== "" })
    .catch(() => null);
  if (!Array.isArray(names)) return [];
  return names
    .filter((name) => typeof name === "string" && name.trim())
    .slice(0, 24)
    .map((name) => maskedDisplayText(Array.from(name.replace(/\s+/g, " ").trim()).slice(0, 40).join("")));
}

// The entries a page reported for a free site search, with the typed text in
// the field's own entry, or null when the answer is not exactly that shape.
function freeSearchEntries(answer, typed) {
  if (
    !answer || answer.kind !== "form-entries" || answer.complete !== true ||
    !Array.isArray(answer.entries) || !Number.isInteger(answer.own) ||
    answer.own < 0 || answer.own >= answer.entries.length
  ) {
    return null;
  }
  const entries = [];
  for (const [index, entry] of answer.entries.entries()) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") return null;
    const typedHere = index === answer.own && typed !== null;
    if (typedHere ? entry[1] !== null : typeof entry[1] !== "string") return null;
    entries.push([entry[0], typedHere ? typed : entry[1]]);
  }
  return entries;
}

// Enter in the page's own search box, or typing into it with submit, that
// goes without a prompt (actionPolicy.isFreeSiteSearch): only under routine
// browsing, and only when every entry the form sends was read, the field's
// own included, none looks like a key and the address they make is not a
// risky one. `typed` is the text a type step puts in the field, or null for
// a press. The entries are tested here and kept nowhere. The step's guard
// then lets no form post leave the tab (FREE_SEARCH_POST_ORIGINS). In one of
// Octo's own tabs the page was opened in this run, and routine browsing
// covers the run's tabs alike.
async function freeSiteSearch(page, target, typed) {
  if (!target.description.policy || !approvalProtocol.routineBrowsingAllowed()) return false;
  const facts = policyTarget(target.description);
  const pageUrl = page.url();
  // The submission itself first, so a step that is no site search reads
  // nothing more from the page.
  if (!actionPolicy.isFreeSiteSearch(facts, pageUrl, [])) return false;
  const answer = await target.locator
    .evaluate(FORM_ENTRIES_IN_PAGE, { kind: "form-entries", keepOwn: typed === null })
    .catch(() => null);
  const entries = freeSearchEntries(answer, typed);
  return entries !== null && actionPolicy.isFreeSiteSearch(facts, pageUrl, entries);
}

// A free site search sends a GET of the page's own origin, so while it runs
// the tab may post a form nowhere: a page script that turns the search into
// a post is stopped before it leaves the browser.
const FREE_SEARCH_POST_ORIGINS = Object.freeze([]);

// A list the page draws as a select: the control `choose` sets. A list a page
// builds from other elements is clicked and typed into instead.
function isSelectDescription(description) {
  return String(description?.tag || "").toLowerCase() === "select";
}

// The most options of one list a choose step reads, and the most characters
// of their labels an answer lists.
const MAX_SELECT_OPTIONS = 10_000;
const MAX_OPTIONS_TEXT_CHARS = 1_500;
// How long a choice waits for the option it was judged on to be in its place,
// and the list to be shown and turned on.
const CHOICE_SELECT_TIMEOUT_MS = 2_000;

// Runs inside the page through Playwright, so it must not use anything from
// this file's scope. A select's options as a person reads them once it is
// open: whether it holds several at once, the options whose label reads as
// `request.wanted` (as written, or else with case, accents and spacing
// aside), how many there are, how many the page lets a person pick, and the
// first of them, for an answer that lists them. Each gives its label, its
// index and whether the page turned it off. An option the page hides is left
// out: nobody can pick it.
function selectOptionsInPage(element, request) {
  if (!(element instanceof HTMLSelectElement)) {
    return { kind: "select-options", select: false, multiple: false, matches: [], options: [], count: 0, enabled: 0 };
  }
  const tidy = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const key = (value) => String(value || "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
  const limit = Math.min(Math.max(Number(request && request.limit) || 0, 0), 10_000);
  const listChars = Math.min(Math.max(Number(request && request.listChars) || 0, 0), 4_000);
  const wanted = tidy(request && request.wanted);
  const wantedKey = key(wanted);
  const view = element.ownerDocument.defaultView;
  const exact = [];
  const close = [];
  const options = [];
  let listed = 0;
  let count = 0;
  let enabled = 0;
  for (const option of Array.from(element.options).slice(0, limit)) {
    let hidden = option.hidden;
    try {
      hidden = hidden || view.getComputedStyle(option).display === "none";
    } catch (_) {
      // An option whose style cannot be read counts as shown.
    }
    if (hidden) continue;
    const label = tidy(option.label || option.text).slice(0, 500);
    const entry = { index: option.index, label, disabled: option.matches(":disabled") };
    count += 1;
    if (!entry.disabled) enabled += 1;
    if (label === wanted) {
      exact.push(entry);
    } else if (key(label) === wantedKey) {
      close.push(entry);
    }
    if (listed <= listChars) {
      options.push(entry);
      listed += label.length + 2;
    }
  }
  return {
    kind: "select-options",
    select: true,
    multiple: element.multiple === true,
    matches: (exact.length ? exact : close).slice(0, 32),
    options,
    count,
    enabled,
  };
}

// A select's options as the page reports them (selectOptionsInPage), for
// `wanted`. The step stops when the page did not say.
async function selectOptions(target, wanted) {
  const answer = await target.locator
    .evaluate(selectOptionsInPage, {
      kind: "select-options",
      wanted,
      limit: MAX_SELECT_OPTIONS,
      listChars: MAX_OPTIONS_TEXT_CHARS,
    })
    .catch(() => null);
  if (
    !answer || answer.kind !== "select-options" || answer.select !== true ||
    !Array.isArray(answer.matches) || !Array.isArray(answer.options)
  ) {
    throw new Error("Shared Browser could not read this list's options, so nothing was chosen. Take a fresh snapshot.");
  }
  const entries = (values) => values
    .filter((option) =>
      option && Number.isSafeInteger(option.index) && option.index >= 0 && typeof option.label === "string")
    .map((option) => ({ index: option.index, label: option.label.slice(0, 500), disabled: option.disabled === true }));
  const counted = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return {
    multiple: answer.multiple === true,
    matches: entries(answer.matches),
    options: entries(answer.options),
    count: counted(answer.count),
    enabled: counted(answer.enabled),
  };
}

// A list's options for an error: as many whole labels as fit, then how many
// more of the `total` there are.
function optionsText(options, total) {
  let text = "";
  let listed = 0;
  for (const option of options) {
    if (option.label) {
      const next = text ? `${text}, ${option.label}` : option.label;
      if (next.length > MAX_OPTIONS_TEXT_CHARS) break;
      text = next;
    }
    listed += 1;
  }
  if (!text) return total > 0 ? "Its options have no labels to choose by." : "It has no options to choose from.";
  const more = Math.max(total - listed, 0);
  return `Its options: ${text}${more > 0 ? ` and ${more} more` : ""}.`;
}

// A list's options are the page's text: an answer names them only where a
// snapshot would show that text, never on a page that is withheld, that may
// show a secret (a credential context, a secret field, masked text beside a
// reveal) or that could not be checked.
async function optionsMayBeListed(page) {
  if (await documentWithheld(page)) return false;
  const signals = await pageSecretSignals(page);
  if (!signals || signals.credentialContext || signals.secretField || signals.maskedNearReveal) return false;
  return !redaction.hasCredentialWord(await pageTitle(page));
}

// The option `wanted` names in a list (selectOptions): the one whose label
// reads the same, as written or with case, accents and spacing aside, that the
// page lets a person pick. Otherwise nothing is chosen, and the error lists
// the list's options so the next try can name one exactly, unless the page
// may show a secret.
async function optionNamed(page, list, wanted, listName) {
  const option = list.matches.find((candidate) => candidate.disabled !== true);
  if (option) return option;
  const text = String(wanted).replace(/\s+/g, " ").trim();
  const name = listName ? `"${listName}"` : "this list";
  const unlisted = (await optionsMayBeListed(page))
    ? null
    : "This page may show a secret, so its options are not listed: leave this list to the person.";
  if (list.matches.length) {
    const enabled = list.options.filter((candidate) => candidate.disabled !== true);
    throw new Error(`The page has turned off "${list.matches[0].label}" in ${name}, so nothing was chosen. ${unlisted || optionsText(enabled, list.enabled)}`);
  }
  throw new Error(`No option in ${name} is called "${text}", so nothing was chosen. ${unlisted || `${optionsText(list.options, list.count)} Choose one of them by its label.`}`);
}

// What a step was, for the turn's plain-language activity line
// (docs/Chat-Activity.md): its kind, the page it left the tab on (masked like
// the result's own address, and only on a site the run may read) and how it
// was allowed. Made from the browser's own state, never from page text.
// runtime-agent keeps only the kind, the address's host, a key of the address
// and the approval.
function stepActivity(page, step, approval = null) {
  let url = null;
  try {
    if (page && !page.isClosed() && !isBlankPage(page) && siteApproved(page.url())) {
      url = maskedUrl(page.url());
    }
  } catch (_) {
    url = null;
  }
  return { step, url, ...(approval ? { approval } : {}) };
}

// How a step was allowed: "once" when it waited on a prompt (its site's or
// its own) and the person allowed it, "routine" when routine browsing took it
// without one, and nothing when it needed no answer (reading a site the run
// already uses).
function stepApproval() {
  if (stepAllowedAtPrompt) {
    return "once";
  }
  return approvalProtocol.routineBrowsingAllowed() ? "routine" : null;
}

// A reading step asks only for its site, and only the first time: "once"
// when that prompt was answered in this step.
function readingApproval() {
  return stepAllowedAtPrompt ? "once" : null;
}

function withActivity(result, activity) {
  return { ...result, activity };
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
  // A dialog submission closes a dialog and sends nothing.
  const dialog = !description.href && String(description.formMethod || "").toLowerCase() === "dialog";
  const raw = dialog ? "" : description.href || description.formAction || "";
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

// The step stays on the site it was judged on. A page that moved to another
// site after the person said yes in this step ends the browser run
// (approval_stale): their yes was for a step on that site, and the reply says
// the page changed after it. One that moved while nobody was asked only fails
// the step, and a fresh snapshot judges the site it is on now.
function assertSameOrigin(actualUrl, expectedOrigin) {
  if (approvalProtocol.normalizedOrigin(actualUrl) === expectedOrigin) {
    return;
  }
  if (stepAllowedAtPrompt) {
    throw new Error(
      "The page moved to another site after the person said yes, so the step was not done [approval_stale_non_retryable]",
    );
  }
  throw new Error("The page moved to another site, so nothing was done. Take a fresh snapshot.");
}

function assertSameTarget(
  actual,
  currentUrl,
  expectedFingerprint,
  expectedDestination,
  destinationMode = "target",
) {
  if (targetFingerprint(actual.description) !== expectedFingerprint) {
    throw controlChanged();
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
    throw controlChanged();
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
  } else if (requestPath === "/v1/choose") {
    requireOnlyKeys(body, new Set(["index", "snapshotId", "option"]));
    validateTarget(body);
    if (typeof body.option !== "string" || !body.option.trim() || Array.from(body.option).length > MAX_OPTION_CHARS) {
      throw new Error("Shared Browser choose requires the option's label");
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
        const title = await pageTitle(page);
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
    return withActivity(await describeTabs(tabs), stepActivity(null, "tabs"));
  }

  if (method === "POST" && requestPath === "/v1/tabs/select") {
    await selectTab(browser, tabs, body.tabId);
    return withActivity(await describeTabs(tabs), stepActivity(null, "tabs"));
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
    return withActivity({ closedTabId: tabId, ...(await describeTabs(tabs)) }, stepActivity(null, "tabs"));
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
    assertStepOnTime();
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
      // A tab opens only a plain address (a risky one was refused above), so
      // the site's approval in this tab covers opening it: one prompt, which
      // names the exact address, and none once the site is approved here.
      await ensureSiteApproved(url, () => `Open ${labelAddress(url)} in a new tab`, { destinationUrl: url });
      const opened = await resolveExpectedPage(browser);
      const documents = await guardStepDocuments(opened);
      try {
        assertStepOnTime();
        emitAction({ type: "navigate", label: `Open a tab: ${url}`, url });
        loading = true;
        await opened.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await settleAfterAction(opened);
        documents.assertNoneBlocked();
      } catch (error) {
        documents.assertNoneBlocked(error);
        throw await unansweredLoadFailure(error, documents);
      } finally {
        await documents.release();
      }
      const settled = await resolveExpectedPage(browser);
      await emitNavigationResult(settled);
      return withActivity(
        { openedTab: true, ...(await snapshotForResult(settled)) },
        stepActivity(settled, "open_tab", stepApproval()),
      );
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

// The step within its time (STEP_TIME_MS): its own answer, or, once its time is
// up, the page as it is.
async function executeWithinStepTime(browser, browserSession, method, requestPath, body) {
  stepBrowserSession = browserSession;
  stepClock.start();
  const step = execute(browser, browserSession, method, requestPath, body);
  const finished = await Promise.race([
    step.then((value) => ({ value }), (error) => ({ error })),
    stepClock.expired.then(() => null),
  ]);
  stepClock.stop();
  if (finished) {
    if ("error" in finished) throw finished.error;
    return finished.value;
  }
  // What the step still does stops at its next action (assertStepOnTime), and
  // its own answer no longer reaches anyone.
  step.catch(() => {});
  return await pageAsItIs(browser);
}

// Resolves to `promise`'s value, or to `fallback` once `ms` have passed.
async function within(ms, promise, fallback = null) {
  promise.catch(() => {});
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

// Stops the load a step started in its tab (guardStepDocuments) whose site has
// not answered, whatever started it: navigate, open_tab, a link, a form or a
// key. Null when no such load waits; otherwise whether the browser said it
// stopped, and whether the site's answer came as it stopped (that page is
// then the step's).
async function stopUnansweredLoad(guards) {
  const load = guards.map((guard) => guard.unansweredLoad()).find(Boolean) ?? null;
  if (!load) return null;
  const stopped = await within(GUARD_RELEASE_MS, stopLoading(load.page).catch(() => false), false);
  return { page: load.page, stopped, answered: load.answered };
}

// The answer of a step whose time ran out: the page as it is now, read like a
// snapshot within LATE_READ_MS, or its address alone when the page is too busy
// to be read. It says that the step's time ran out, so Octo checks what the step
// did before it acts again. Its activity says what it is: a read of the page,
// or, for the address alone, the page it is on, as status names it. A load the
// step started whose site has not answered, whatever page the tab showed before
// and whatever started it, is stopped first (stopUnansweredLoad): while it
// waits, Instafy's browser cannot be reached by the next step, and it would land
// after the step ended. So the step opened nothing, and it fails (its line
// reads as the step it tried) saying the site did not answer and where to go
// next, never the page the tab still shows, nor the blank page's "Call
// navigate", which sent Octo to load the same site again. A site that answered
// as the time ran out has its page, which is read as it is, and a load the
// browser did not confirm stopped is still busy. A tab that is still blank is
// stopped and answered the same way. The step's guards still hold while the
// page is read, then end as a step's guards end: a window it opened is closed,
// and what they stopped fails the step as it would have in its time.
async function pageAsItIs(browser) {
  const guards = [...openStepGuards];
  const load = await stopUnansweredLoad(guards);
  const unanswered = load !== null && !load.answered;
  const read = unanswered
    ? null
    : await within(LATE_READ_MS, (async () => snapshotForResult(await resolveExpectedPage(browser)))());
  let stopped = null;
  try {
    await within(GUARD_RELEASE_MS, Promise.all(guards.map((guard) => guard.closeUnseenWindows())));
  } catch (_) {
    stopped = new Error("This step's time ran out, and Shared Browser could not check for windows it opened, so it stopped there. Take a snapshot before you act again.");
  }
  for (const guard of guards) {
    try {
      guard.assertNoneBlocked();
    } catch (error) {
      stopped ??= error;
    }
  }
  await within(GUARD_RELEASE_MS, Promise.all(guards.map((guard) => guard.release())));
  if (stopped) throw stopped;
  const view = unanswered ? null : read ?? addressOnly(resolvedPage);
  const readSomething = read && view.blank !== true && !isBusyPageResult(read);
  // Only a page that was read is "the page as it is now"; a busy one says so
  // in its own message.
  const note = `This step was still running after ${STEP_TIME_MS / 1000} seconds, so it stopped where it was. ${
    readSomething ? "This is the page as it is now: check" : "Check"
  } what the step did before you act again.`;
  if (unanswered) {
    throw new Error(load.stopped ? unansweredLoadMessage(load.page) : `${BUSY_PAGE_MESSAGE} ${note}`);
  }
  if (view.blank === true) {
    const stoppedBlankLoad = await within(GUARD_RELEASE_MS, stopLoading(resolvedPage).catch(() => false), false);
    throw new Error(stoppedBlankLoad ? UNANSWERED_PAGE_MESSAGE : `${BUSY_PAGE_MESSAGE} ${note}`);
  }
  emitAction({ type: "nav_result", label: view.title || view.url, url: view.url });
  return withActivity(
    { ...view, stepTimedOut: true, message: [view.message, note].filter(Boolean).join(" ") },
    stepActivity(resolvedPage, readSomething ? "snapshot" : "status", null),
  );
}

const BUSY_PAGE_MESSAGE = "The page is still busy, so it could not be read yet. Take a snapshot in a moment.";
// What a load answers whose site sent nothing back before the step stopped
// waiting for it (its time ran out, or a click's own wait for the page did):
// the tab still shows what it showed before, and Octo goes to the next source
// in the same turn (the browser skill's "Finding a page").
const UNANSWERED_NEXT_SOURCE = "Open the place's own site now (the venue's or the operator's), or another official source if this was it.";
const UNANSWERED_PAGE_MESSAGE = `The site did not answer in time, so nothing was opened and the page is still blank. ${UNANSWERED_NEXT_SOURCE}`;
const UNANSWERED_LOADED_PAGE_MESSAGE = `The site did not answer in time, so nothing was opened and the tab still shows the page it showed before. ${UNANSWERED_NEXT_SOURCE}`;

function unansweredLoadMessage(page) {
  return isBlankPage(page) ? UNANSWERED_PAGE_MESSAGE : UNANSWERED_LOADED_PAGE_MESSAGE;
}

// A step that failed on its own wait for the page a load would bring (a click
// or a key waits 15 seconds for the page it opens, so it may give up before the
// step's time does) while that load's site had not answered: the load is
// stopped, as it is once the step's time is up, and the step says the site did
// not answer. Any other failure is the step's own.
async function unansweredLoadFailure(error, guard) {
  if (error?.name !== "TimeoutError") return error;
  const load = await stopUnansweredLoad([guard]);
  return load?.stopped && !load.answered ? new Error(unansweredLoadMessage(load.page)) : error;
}

// Stops what the page is still loading, as the browser's stop button does; true
// once the browser says it did.
async function stopLoading(page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Page.stopLoading");
    return true;
  } finally {
    await session.detach().catch(() => {});
  }
}

// Whether a read answered that the page is still busy (addressOnly).
function isBusyPageResult(result) {
  return result?.message === BUSY_PAGE_MESSAGE;
}

// The address alone of a page too busy to be read, checked and masked as a
// snapshot's is. It lists no text and no controls, so no action can use it.
function addressOnly(page) {
  if (!page || page.isClosed()) {
    throw new Error("The page could not be read in time, so nothing was read. Take a snapshot.");
  }
  if (isBlankPage(page)) {
    return blankPageResult(page);
  }
  refuseLinkOnlyPage(page);
  if (!siteApproved(page.url())) {
    return approvalProtocol.redactedPageResult(tabField());
  }
  return {
    snapshotId: snapshotFingerprint(page.url(), []),
    browserPageId: EXPECTED_BROWSER_PAGE_ID,
    ...tabField(),
    url: redaction.redactUrl(page.url()).text,
    title: "",
    visibleText: "",
    secretScreen: false,
    interactiveElements: [],
    message: BUSY_PAGE_MESSAGE,
  };
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
    const result = await executeOnPage(browser, method, requestPath, body, page, tabs, documents);
    documents.assertNoneBlocked();
    return result;
  } catch (error) {
    // A blocked load fails the step itself; say why. So does a load whose site
    // did not answer.
    documents.assertNoneBlocked(error);
    throw await unansweredLoadFailure(error, documents);
  } finally {
    await documents.release();
  }
}

// The guards (guardStepDocuments) of the step that is running, so a step whose
// time runs out still ends them (pageAsItIs).
const openStepGuards = new Set();
// The browser's own CDP session for this command (denyDownloads), which lists
// and closes windows whose page is too busy to answer.
let stepBrowserSession = null;

async function pageTargetIds() {
  const { targetInfos } = await stepBrowserSession.send("Target.getTargets");
  return (Array.isArray(targetInfos) ? targetInfos : [])
    .filter((info) => info && info.type === "page" && validTabId(info.targetId))
    .map((info) => info.targetId);
}

// While a step of Octo's runs, in any tab (its own tabs and the page the
// person chose alike), the tab itself loads no document from a link-only
// site: a link, form or redirect that would take it there is stopped before
// its request leaves the browser. Frames inside the page are not the tab
// going there and load as the page asks. Fails closed: a tab that cannot be
// guarded takes no step.
async function guardStepDocuments(page) {
  const blocked = [];
  // Where the tab may send a form while the step runs (stepPostOrigins):
  // null for anywhere, until the step says.
  let postOrigins = null;
  const strayPosts = [];
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
  // Windows closed by their target alone (closeUnseenWindows).
  let unseenWindows = 0;
  let targetsAtStart = null;
  // The tab's own load that the step started and its site has not answered
  // yet (stopUnansweredLoad): the tab's newest document request, from when it
  // leaves the browser until the site's answer comes (`answered`) or the
  // request ends unanswered. Only a load that sends nothing (GET, through
  // every redirect) is one: a form the tab posted has reached its site even
  // when no answer came, so that load is left to run and the step answers as
  // it did, never that nothing was opened.
  let waitingLoad = null;
  const tabDocument = (request) => {
    try {
      return request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch (_) {
      return false;
    }
  };
  const sendsNothing = (request) => {
    for (let hop = request; hop; hop = hop.redirectedFrom()) {
      if (hop.method() !== "GET") return false;
    }
    return true;
  };
  const loadStarted = (request) => {
    if (tabDocument(request)) waitingLoad = sendsNothing(request) ? { page, request, answered: false } : null;
  };
  const loadAnswered = (response) => {
    if (waitingLoad && waitingLoad.request === response.request()) {
      waitingLoad.answered = true;
      waitingLoad = null;
    }
  };
  const loadEnded = (request) => {
    if (waitingLoad && waitingLoad.request === request) waitingLoad = null;
  };
  const followLoads = (on) => {
    for (const [event, listener] of [["request", loadStarted], ["response", loadAnswered], ["requestfailed", loadEnded]]) {
      if (on) page.on(event, listener);
      else page.off(event, listener);
    }
  };
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
    // The browser's list of pages too: a window a busy page opens is listed
    // there long before Playwright can show it as a page.
    targetsAtStart = new Set(await pageTargetIds());
    context.on("page", noteWindow);
    followLoads(true);
    await context.route("**/*", stopWindowRequests);
    session = await page.context().newCDPSession(page);
    // The tab's own document is what is guarded. A page may frame a
    // link-only site (a map, a sign-in button, a captcha), which Octo neither
    // reads nor drives: stopping that frame would only break the page and
    // fail the step as if Octo had gone there. A paused request that names no
    // frame counts as the tab's own.
    const { frameTree } = await session.send("Page.getFrameTree");
    const mainFrameId = frameTree?.frame?.id;
    if (typeof mainFrameId !== "string" || !mainFrameId) {
      throw new Error("The tab's main frame is unknown");
    }
    // Each document request pauses before it leaves, and again when its answer
    // arrives (CDP marks that stage with a status or an error), before the
    // page renders: an answer may say it is a copy of a link-only site.
    session.on("Fetch.requestPaused", (event) => {
      const url = event?.request?.url || "";
      const ownDocument = typeof event?.frameId !== "string" || event.frameId === mainFrameId;
      const answered = event?.responseStatusCode !== undefined || event?.responseErrorReason !== undefined;
      const site = !ownDocument
        ? null
        : LINK_ONLY_SITES === null
          ? "an unknown site"
          : linkOnlySiteOf(url) || (answered ? linkOnlyCopyOf(event.responseHeaders, url) : null);
      // A form the tab posts to a site the step may not send to, judged when
      // the request leaves: an answer belongs to a request already let
      // through. A redirect the server answers with is the server's own, so
      // only the browser's first request counts.
      const strayPost = !site && ownDocument && !answered && postOrigins !== null &&
        String(event?.request?.method || "").toUpperCase() === "POST" &&
        !event?.redirectedRequestId &&
        !postOrigins.has(approvalProtocol.normalizedOrigin(url));
      const answer = site || strayPost
        ? session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" })
        : session.send("Fetch.continueRequest", { requestId: event.requestId });
      if (site) blocked.push(site);
      if (strayPost) strayPosts.push(approvalProtocol.normalizedOrigin(url) || "an address that is not a web site");
      answer.catch(() => {});
    });
    await session.send("Fetch.enable", {
      patterns: [
        { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
        { urlPattern: "*", resourceType: "Document", requestStage: "Response" },
      ],
    });
    // A new document in the tab ends the limit on where forms may be sent:
    // the page the step acted on is gone.
    session.on("Page.frameNavigated", (event) => {
      if (event?.frame && !event.frame.parentId) postOrigins = null;
    });
    await session.send("Page.enable");
  } catch (_) {
    if (session) await session.detach().catch(() => {});
    context.off("page", noteWindow);
    followLoads(false);
    await context.unroute("**/*", stopWindowRequests).catch(() => {});
    throw new Error("Shared Browser could not guard the tab against link-only sites, so the step was not performed");
  }
  let released = null;
  const guard = {
    // The sites the tab may send a form to from now on (stepPostOrigins).
    limitFormPosts: (origins) => {
      postOrigins = origins === null ? null : new Set(origins.filter(Boolean));
    },
    // The load the step started that its site has not answered yet, if any.
    unansweredLoad: () => waitingLoad,
    // Ends the guard once, whoever asks first: the step, or pageAsItIs once
    // the step's time is up (a busy page can hold the step's own release).
    release: () => (released ??= (async () => {
      await session.send("Fetch.disable").catch(() => {});
      await session.detach().catch(() => {});
      // A window that appeared after the step's last check is closed too.
      for (const opened of context.pages()) noteWindow(opened);
      context.off("page", noteWindow);
      followLoads(false);
      await context.unroute("**/*", stopWindowRequests).catch(() => {});
      for (const opened of windows) {
        await opened.close({ runBeforeUnload: false }).catch(() => {});
      }
      // Chromium shows the window's neighbour when it closes, which may be a
      // person's tab: the tab the step ran in comes to the front again.
      if (windows.length && !page.isClosed()) {
        await page.bringToFront().catch(() => {});
      }
    })().finally(() => openStepGuards.delete(guard))),
    // Once a step's time is up its page may be too busy for Playwright to show
    // a window the step opened as a page: such a window is closed by its
    // target, as every page that appears during the step is the step's.
    closeUnseenWindows: async () => {
      for (const targetId of await pageTargetIds()) {
        if (targetsAtStart.has(targetId)) continue;
        await stepBrowserSession.send("Target.closeTarget", { targetId }).catch(() => {});
        unseenWindows += 1;
      }
      // As release does, the tab the step ran in comes to the front again.
      if (unseenWindows) {
        await stepBrowserSession.send("Target.activateTarget", { targetId: activePageId }).catch(() => {});
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
      if (strayPosts.length) {
        throw new Error(
          `During this step the page sent a form to ${maskedDisplayText(strayPosts[0])}, which the step was not approved to send to, so it was stopped before it left the browser. Nothing was sent there. Leave this form to the person.`,
        );
      }
      if (windows.length || windowRequestStopped || unseenWindows) {
        throw new Error(
          "The step opened another window, which Octo never uses, so it was closed before it loaded anything. Open the address with open_tab instead.",
        );
      }
    },
  };
  openStepGuards.add(guard);
  return guard;
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

async function executeOnPage(browser, method, requestPath, body, page, tabs, documents = null) {
  if (method === "GET" && requestPath === "/v1/status") {
    const shared = {
      ready: true,
      browserPageId: EXPECTED_BROWSER_PAGE_ID,
      pageCount: browser.contexts().flatMap((context) => context.pages()).length,
      agentTabCount: tabs.registry.tabs.length,
      ...tabField(),
      // A space's copy of the link-only list that was left out, so Octo can tell the person.
      ...(LINK_ONLY.warnings.length ? { linkOnlyListWarnings: LINK_ONLY.warnings } : {}),
    };
    if (isBlankPage(page)) {
      return blankPageResult(page, shared);
    }
    if (!siteApproved(page.url())) {
      return approvalProtocol.redactedPageResult(shared);
    }
    const title = await pageTitle(page);
    return {
      ...shared,
      originApproved: true,
      redacted: false,
      url: redaction.redactUrl(page.url()).text,
      title: redaction.redactText(title, { credentialContext: redaction.hasCredentialWord(title) }).text,
      activity: stepActivity(page, "status"),
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
    // A busy page was not read: its line names the page it is on, as status does.
    return withActivity(
      result,
      stepActivity(page, isBusyPageResult(result) ? "status" : "snapshot", readingApproval()),
    );
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
    // Only the fields it highlights must be as Octo saw them: a sign-in page
    // that adds a button under its form after it loads still pauses on them.
    if (!humanInputFieldsAsObserved(page.url(), interactive, body)) {
      pageChangedUnderStep = true;
      throw new Error("The page changed; take a fresh snapshot before requesting human input");
    }
    const selected = body.indices.map((index) => interactive[index]);
    if (selected.some((entry) => !entry || !EDITABLE_FIELD_TAGS.has(entry.description.tag))) {
      throw new Error("Human input targets must be observed editable fields");
    }
    await clearHumanInputHighlights(page);
    try {
      for (const entry of selected) {
        assertStepOnTime();
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
      // A step that answered with the page as it is asks the person for nothing.
      assertStepOnTime();
    } catch (error) {
      if (error instanceof StepTimeUp) await clearHumanInputHighlights(page).catch(() => {});
      throw error;
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
    // A plain address (a reading step) needs only its site's approval in this
    // tab: the site prompt names the exact address, and a site already
    // approved here opens without one. A risky address still asks for the
    // step itself, in every mode.
    await ensureSiteApproved(url, () => `Open ${labelAddress(url)}`, { destinationUrl: url });
    if (!readingStep) {
      await allowStepOnce({
        operation: "navigate",
        label: `Go to ${labelAddress(url)}`,
        categoryTitle: step.verdict === "ask" ? approvalCategoryTitle(step) : "",
        sourceOrigin,
        ...approvalProtocol.destinationBinding(url),
        snapshotId: null,
        targetFingerprint: null,
        payloadFingerprint: approvalProtocol.sha256("navigate"),
      });
    }
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
    assertStepOnTime();
    emitAction({ type: "navigate", label: `Go to ${url}`, url });
    await page.goto(revalidatedUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await settleAfterAction(page);
    page = await resolveExpectedPage(browser);
    await emitNavigationResult(page);
    return withActivity(await snapshotForResult(page), stepActivity(page, "navigate", stepApproval()));
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
    const clickSubmission = stepFormSubmission(target.description, "click");
    // A cookie banner's refusal shares nothing, so it never asks, in any
    // mode: only a button in a consent banner, with a refusal's words, that
    // is no link and sends no form. Its step lets no form post leave the tab.
    const consentRejection = step.verdict === "allow" && step.consentRejection === true &&
      !rawDestination && !clickSubmission && !isFormSubmissionControl(target.description);
    const readingStep = consentRejection || (routineCovers(step, target.description) &&
      !isFormSubmissionControl(target.description));
    if (rawDestination) {
      assertMayOpen(rawDestination);
    }
    refuseNewWindowOrNestedSubmission(clickSubmission);
    refuseUnlessReadingStep(readingStep);
    if (
      destination.destinationOrigin &&
      destination.destinationOrigin !== sourceOrigin
    ) {
      await ensureSiteApproved(
        rawDestination,
        () => `Follow this control to ${labelAddress(rawDestination)}`,
        { destinationUrl: rawDestination },
      );
    }
    if (!consentRejection) {
      await allowStepOnce({
        operation: "click",
        label: promptLabel(
          target.description,
          "Activate this control",
          await sentFieldNames(target, clickSubmission),
        ),
        categoryTitle: approvalCategoryTitle(step),
        sourceOrigin,
        ...destination,
        snapshotId: body.snapshotId,
        targetFingerprint: approvedTargetFingerprint,
        payloadFingerprint: approvalProtocol.sha256("click"),
      }, { routine: readingStep });
    }
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), sourceOrigin);
    target = await approvedTarget(page, body, target.asked);
    assertSameTarget(
      target,
      page.url(),
      approvedTargetFingerprint,
      destination,
    );
    const withholding = await withholdBeforeStep(page, step);
    documents?.limitFormPosts(consentRejection
      ? []
      : stepPostOrigins(readingStep, sourceOrigin, clickSubmission, destination));
    const box = target.description.box;
    const size = await viewport(page);
    assertStepOnTime();
    emitAction({
      type: "click",
      label: `Click ${quotedControlLabel(target.description)}`,
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
    return withActivity(await snapshotAfterStep(page, withholding), stepActivity(page, "click", stepApproval()));
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
    const rawDestination = submitting
      ? resolvedTargetDestination(target.description, page.url()) || page.url()
      : null;
    if (rawDestination) {
      assertMayOpen(rawDestination);
    }
    const typeSubmission = submitting ? stepFormSubmission(target.description, "submit") : null;
    refuseNewWindowOrNestedSubmission(typeSubmission);
    // Typing into the page's own search box with submit goes without a
    // prompt under routine browsing; every other submission asks.
    const freeSearch = submitting && documents !== null && (await freeSiteSearch(page, target, body.text));
    const readingStep = freeSearch ||
      (!submitting && routineCovers(step, target.description, { consequential: false }));
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
          () => `Send this form to ${labelAddress(rawDestination)}`,
          { destinationUrl: rawDestination },
        );
      }
    }
    if (submitting) {
      stepKind = step.category === "search" ? "search" : "submit";
    }
    await allowStepOnce({
      operation: submitting ? "form-submit" : "type",
      label: submitting
        ? promptLabel(
          target.description,
          "Submit this form",
          readingStep ? [] : await sentFieldNames(target, typeSubmission, body.text),
        )
        : promptLabel(target.description, "Type into this field"),
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
    target = await approvedTarget(page, body, target.asked);
    assertSameTarget(
      target,
      page.url(),
      approvedTargetFingerprint,
      destination,
      submitting ? "target-or-page" : "none",
    );
    assertSafeTypeTarget(target.description);
    assertStepOnTime();
    emitAction({
      type: "type",
      label: `Type into ${quotedControlLabel(target.description)}`,
      url: page.url(),
    });
    await target.locator.focus();
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), sourceOrigin);
    target = await approvedTarget(page, body, target.asked, { around: false });
    assertSafeTypeTarget(target.description);
    assertSameTarget(
      target,
      page.url(),
      approvedTargetFingerprint,
      destination,
      submitting ? "target-or-page" : "none",
    );
    const withholding = submitting ? await withholdBeforeStep(page, step) : false;
    documents?.limitFormPosts(freeSearch
      ? FREE_SEARCH_POST_ORIGINS
      : stepPostOrigins(readingStep, sourceOrigin, typeSubmission, destination));
    assertStepOnTime();
    await target.locator.fill(body.text);
    if (submitting) {
      assertStepOnTime();
      await target.locator.press("Enter");
      await settleAfterAction(page);
      page = await resolveExpectedPage(browser);
      await emitNavigationResult(page);
    }
    page = await resolveExpectedPage(browser);
    // Typing with submit into a search field is a search, whoever allowed it;
    // into any other field it sends a form.
    const typeKind = submitting ? (step.category === "search" ? "search" : "submit") : "type";
    return withActivity(
      await snapshotAfterStep(page, withholding),
      stepActivity(page, typeKind, freeSearch ? "free" : stepApproval()),
    );
  }

  // Choosing an option of a list, by its label, as a person picks it from the
  // open list. It does not send the form, so it is judged like typing that does
  // not submit: routine browsing takes it without a prompt unless the list's
  // own label or the option says it is risky ("Payment method", "Delete
  // selected"), and the form is sent by its own button, which asks. While the
  // option changes, the page may send a form to its own site (an older site
  // that reloads a list when it changes) and nowhere else, whoever allowed the
  // choice: its prompt names no other site. In Octo's own tabs, which are for
  // reading, it may send none.
  if (method === "POST" && requestPath === "/v1/choose") {
    const sourceOrigin = await ensureSiteApproved(
      page.url(),
      "Allow the assistant to interact with this site for this run",
    );
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), sourceOrigin);
    let target = await targetLocator(page, body);
    if (!isSelectDescription(target.description)) {
      throw new Error(
        "choose sets a list the page draws as a select, and this control is not one, so nothing was chosen. Click it to open it, then click the option, or type into it.",
      );
    }
    assertSafeTypeTarget(target.description, "choose");
    const listName = listOwnName(target.description);
    const list = await selectOptions(target, body.option);
    if (list.multiple) {
      throw new Error(
        `${listName ? `"${listName}"` : "This list"} holds several options at once, and choose sets one, so nothing was chosen. Leave this list to the person.`,
      );
    }
    const option = await optionNamed(page, list, body.option, listName);
    const step = classifyStep("choose", target.description, { pageUrl: page.url(), option: option.label });
    refuseUserStep(step);
    // The older consequential words count for the option a person would
    // click, as they do for a control's own name.
    const readingStep = routineCovers(step, target.description, { consequential: false }) &&
      !CONSEQUENTIAL_ACTION_PATTERN.test(option.label) && !hasPlacedConsequentialWord(option.label);
    refuseUnlessReadingStep(readingStep);
    const approvedTargetFingerprint = targetFingerprint(target.description);
    const destination = approvalProtocol.destinationBinding(null);
    await allowStepOnce({
      operation: "choose",
      label: choicePromptLabel(target.description, option.label),
      categoryTitle: approvalCategoryTitle(step),
      sourceOrigin,
      ...destination,
      snapshotId: body.snapshotId,
      targetFingerprint: approvedTargetFingerprint,
      payloadFingerprint: approvalProtocol.sha256(JSON.stringify({ option: option.label, index: option.index })),
    }, { routine: readingStep });
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), sourceOrigin);
    target = await approvedTarget(page, body, target.asked);
    assertSameTarget(target, page.url(), approvedTargetFingerprint, destination, "none");
    assertSafeTypeTarget(target.description, "choose");
    const withholding = await withholdBeforeStep(page, step);
    documents?.limitFormPosts(inAgentTab() ? [] : [sourceOrigin]);
    const box = target.description.box;
    const size = await viewport(page);
    assertStepOnTime();
    const bounded = (value) => Array.from(value).slice(0, MAX_LABEL_CHARS).join("");
    emitAction({
      type: "click",
      label: `Choose "${bounded(option.label)}"${listName ? ` in "${bounded(listName)}"` : ""}`,
      url: page.url(),
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      ...size,
    });
    const beforeUrl = page.url();
    // The option the step was judged on is set by its label and its place
    // together, in one pass inside the page. A list that moved, turned off or
    // dropped it meanwhile chooses nothing.
    await target.locator
      .selectOption({ index: option.index, label: option.label }, { timeout: CHOICE_SELECT_TIMEOUT_MS })
      .catch((error) => {
        throw error && error.name === "TimeoutError" ? controlChanged() : error;
      });
    await settleAfterAction(page);
    page = await resolveExpectedPage(browser);
    await page.bringToFront();
    if (page.url() !== beforeUrl) {
      await emitNavigationResult(page);
    }
    return withActivity(await snapshotAfterStep(page, withholding), stepActivity(page, "choose", stepApproval()));
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
    const rawDestination = activationKey
      ? resolvedTargetDestination(target.description, page.url()) || page.url()
      : null;
    if (rawDestination) {
      assertMayOpen(rawDestination);
    }
    const pressSubmission = stepFormSubmission(target.description, "press", pressKey);
    refuseNewWindowOrNestedSubmission(pressSubmission);
    // Enter in the page's own search box goes without a prompt under routine
    // browsing; every other activation key asks.
    const freeSearch = pressKey === "Enter" && documents !== null && (await freeSiteSearch(page, target, null));
    const readingStep = freeSearch || (!activationKey && routineCovers(step, target.description));
    refuseUnlessReadingStep(readingStep);
    const destination = approvalProtocol.destinationBinding(rawDestination);
    if (activationKey) {
      if (
        destination.destinationOrigin &&
        destination.destinationOrigin !== sourceOrigin
      ) {
        await ensureSiteApproved(
          rawDestination,
          () => `Follow this control to ${labelAddress(rawDestination)}`,
          { destinationUrl: rawDestination },
        );
      }
    }
    if (pressKey === "Enter" && step.category === "search") {
      stepKind = "search";
    }
    await allowStepOnce({
      operation: activationKey
        ? pressKey === "Enter"
          ? "press-enter"
          : "press-space"
        : "press-key",
      label: activationKey
        ? promptLabel(
          target.description,
          "Activate this control",
          readingStep ? [] : await sentFieldNames(target, pressSubmission),
        )
        : `Press ${pressKey} on ${promptLabel(target.description, "this field")}`,
      categoryTitle: approvalCategoryTitle(step),
      sourceOrigin,
      ...destination,
      snapshotId: body.snapshotId,
      targetFingerprint: approvedTargetFingerprint,
      payloadFingerprint: approvalProtocol.sha256(body.key),
    }, { routine: readingStep });
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), sourceOrigin);
    target = await approvedTarget(page, body, target.asked);
    assertSameTarget(
      target,
      page.url(),
      approvedTargetFingerprint,
      destination,
      activationKey ? "target-or-page" : "none",
    );
    assertSafeTypeTarget(target.description);
    const withholding = activationKey ? await withholdBeforeStep(page, step) : false;
    documents?.limitFormPosts(freeSearch
      ? FREE_SEARCH_POST_ORIGINS
      : stepPostOrigins(readingStep, sourceOrigin, pressSubmission, destination));
    assertStepOnTime();
    emitAction({
      type: "type",
      label: `Press ${pressKey}`,
      url: page.url(),
    });
    await target.locator.press(pressKey);
    await settleAfterAction(page);
    page = await resolveExpectedPage(browser);
    // Enter in a search field is a search, whoever allowed it.
    const pressKind = pressKey === "Enter" && step.category === "search" ? "search" : "press";
    return withActivity(
      await snapshotAfterStep(page, withholding),
      stepActivity(page, pressKind, freeSearch ? "free" : stepApproval()),
    );
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
    assertStepOnTime();
    emitAction({ type: "scroll", label: "Scroll", url: page.url() });
    await page.mouse.wheel(x, y);
    await page.waitForTimeout(200);
    page = await resolveExpectedPage(browser);
    return withActivity(await snapshotForResult(page), stepActivity(page, "scroll", readingApproval()));
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
      result = await executeWithinStepTime(browser, browserSession, method, requestPath, body || {});
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
  async (error) => {
    // What the step was, for the turn's line and Details, on stdout:
    // runtime-agent reads it only from a failed command's stdout, as a few
    // fixed words. Its kind when the browser judged it before it asked, and
    // "once" when the person said yes at its prompt: a step they allowed that
    // then did not happen still lists their yes. `changedAfterYes` when that
    // yes was not used because the control changed (controlChanged), which
    // runtime-agent counts for the run, and `pageChanged` when the page changed
    // under a step nobody was asked about, which it counts in a row.
    // `refused` when the browser refused the step as the person's own.
    const activity = {
      ...(FAILED_STEP_KINDS.has(stepKind) ? { step: stepKind } : {}),
      ...(stepAllowedAtPrompt ? { approval: "once" } : {}),
      ...(REFUSED_STEP_KINDS.has(refusedStep) ? { refused: refusedStep } : {}),
    };
    const pageChanged = pageChangedUnderStep && !changedAfterYes;
    if (Object.keys(activity).length || pageChanged) {
      await writeStdout(
        `${JSON.stringify({
          ok: false,
          ...(Object.keys(activity).length ? { activity } : {}),
          ...(changedAfterYes ? { changedAfterYes: true } : {}),
          ...(pageChanged ? { pageChanged: true } : {}),
        })}\n`,
      ).catch(() => {});
    }
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
