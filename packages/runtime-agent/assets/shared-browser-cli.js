const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// Redaction and step classification come from @instafy/browser-action-policy,
// embedded ahead of this script by the runtime agent.
const redaction = globalThis.__instafyBrowserRedaction;
const actionPolicy = globalThis.__instafyBrowserActionPolicy;
if (
  !redaction || typeof redaction.redactPageObservation !== "function" ||
  !actionPolicy || typeof actionPolicy.classifyStep !== "function"
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
        pageId: EXPECTED_BROWSER_PAGE_ID,
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

async function resolveExpectedPage(browser) {
  const pages = browser.contexts().flatMap((context) => context.pages());
  for (const page of pages) {
    const targetId = await cdpTargetIdForPage(page).catch(() => "");
    if (targetId === EXPECTED_BROWSER_PAGE_ID) {
      resolvedPage = page;
      return page;
    }
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

// Runs inside the page through Playwright, so it must not use anything from
// this file's scope. It reads attributes and structure around the element,
// never field values; `policy` holds the structural facts the step classifier
// needs, the same ones the Desktop Personal Browser collects.
function describeInPage(element, sources) {
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

  return {
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

async function describeElement(locator, index) {
  const box = await locator.boundingBox().catch(() => null);
  const attributes = await locator
    .evaluate(describeInPage, PAGE_POLICY_SOURCES)
    .catch(() => null);
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

async function collectInteractiveElements(page) {
  const matches = page.locator(INTERACTIVE_SELECTOR);
  const count = Math.min(await matches.count(), MAX_INTERACTIVE_ELEMENTS * 3);
  const elements = [];
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    const locator = await matches.nth(ordinal).elementHandle().catch(() => null);
    if (!locator) {
      continue;
    }
    if (!(await locator.isVisible().catch(() => false))) {
      continue;
    }
    const description = await describeElement(locator, elements.length);
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
    .update(JSON.stringify({ ownerId, runId, pageId: EXPECTED_BROWSER_PAGE_ID, url, elements }))
    .digest("hex");
}

function targetFingerprint(description) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        pageId: EXPECTED_BROWSER_PAGE_ID,
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

function publicElementDescription(description) {
  return {
    index: description.index,
    label: description.label,
    tag: description.tag,
    role: description.role,
    href: description.href,
    inputType: description.inputType,
    autocomplete: description.autocomplete,
    box: description.box,
  };
}

// Runs inside the page. Every check returns a boolean; no field value, code
// block text or masked text is part of the result. Open shadow roots are
// searched too. A failure returns null and the page is withheld.
function pageSecretSignalsInPage(sources) {
  try {
    const clean = (value, limit = 2_000) =>
      typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
    const secretPatterns = sources.secretPatterns.map((source) => new RegExp(source));
    const credentialContextPattern = new RegExp(sources.credentialContext, "iu");
    const placeholderPattern = new RegExp(sources.placeholder, "i");
    const maskedTextPattern = new RegExp(sources.maskedText, "u");
    const revealLabelPattern = /(?<![\p{L}\p{N}])(?:reveal|show|view|copy|unhide|display|anzeigen|einblenden|kopieren|zeigen|ansehen)(?![\p{L}\p{N}])|(?<![\p{L}])eye(?:[-_]?(?:icon|open|off|slash|closed|fill|outline))?(?![\p{L}])|(?<![\p{L}])eye(?=icon|open|off|slash)|visibility|clipboard/iu;
    const uuidValuePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const hexValuePattern = /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/i;
    const valueEntropy = (value) => {
      const counts = new Map();
      for (const character of value) counts.set(character, (counts.get(character) || 0) + 1);
      let entropy = 0;
      for (const count of counts.values()) {
        const probability = count / value.length;
        entropy -= probability * Math.log2(probability);
      }
      return entropy;
    };
    const looksLikeSecretValue = (raw, credentialContext) => {
      if (typeof raw !== "string") return false;
      const value = raw.trim();
      if (value.length < 16 || value.length > 16_384 || placeholderPattern.test(value)) return false;
      if (secretPatterns.some((pattern) => pattern.test(value))) return true;
      if (/\s/.test(value) || value.length < 20 || value.length > 512) return false;
      if (!credentialContext && (uuidValuePattern.test(value) || hexValuePattern.test(value))) return false;
      return /[A-Za-z]/.test(value) && /[0-9]/.test(value) && valueEntropy(value) >= 3.5;
    };
    const scanElements = (visit) => {
      const roots = [document];
      let scanned = 0;
      while (roots.length > 0 && scanned < 20_000) {
        const root = roots.shift();
        const elements = typeof root?.querySelectorAll === "function" ? Array.from(root.querySelectorAll("*")) : [];
        for (const element of elements) {
          scanned += 1;
          if (visit(element) === true) return true;
          if (element && element.shadowRoot && typeof element.shadowRoot.querySelectorAll === "function") {
            roots.push(element.shadowRoot);
          }
          if (scanned >= 20_000) break;
        }
      }
      return false;
    };
    const elementTag = (element) => (typeof element?.tagName === "string" ? element.tagName.toUpperCase() : "");
    const elementAttribute = (element, name) =>
      typeof element?.getAttribute === "function" ? element.getAttribute(name) : null;
    const elementText = (element) => clean(element?.textContent ?? element?.innerText ?? "", 2_000);
    const isDialog = (element) =>
      elementTag(element) === "DIALOG" ||
      ["dialog", "alertdialog"].includes(elementAttribute(element, "role")) ||
      elementAttribute(element, "aria-modal") === "true";
    const labelTags = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "LEGEND", "TH", "LABEL", "DT", "CAPTION"]);
    const credentialContext =
      credentialContextPattern.test(clean(document.title, 1_000)) ||
      scanElements((element) => {
        const label =
          labelTags.has(elementTag(element)) || elementAttribute(element, "role") === "heading"
            ? elementText(element)
            : isDialog(element)
              ? clean(elementAttribute(element, "aria-label"))
              : "";
        return Boolean(label) && credentialContextPattern.test(label);
      });
    const codeTags = new Set(["CODE", "PRE", "KBD", "SAMP", "OUTPUT"]);
    let secretField = false;
    let secretCode = false;
    let maskedNearReveal = false;
    scanElements((element) => {
      const tag = elementTag(element);
      if (!secretField && (tag === "INPUT" || tag === "TEXTAREA")) {
        const type = String(element.type || elementAttribute(element, "type") || "").toLowerCase();
        const readOnly =
          element.readOnly === true || elementAttribute(element, "readonly") !== null ||
          element.disabled === true || elementAttribute(element, "disabled") !== null;
        if (readOnly && type !== "password" && type !== "hidden" && looksLikeSecretValue(element.value, credentialContext)) {
          secretField = true;
        }
      }
      if (!secretCode && codeTags.has(tag) && looksLikeSecretValue(elementText(element), credentialContext)) {
        secretCode = true;
      }
      if (
        !maskedNearReveal &&
        (tag === "BUTTON" || tag === "A" || elementAttribute(element, "role") === "button" ||
          elementAttribute(element, "onclick") !== null)
      ) {
        const label = [
          elementAttribute(element, "aria-label"), elementAttribute(element, "title"),
          elementAttribute(element, "class"), elementAttribute(element, "data-icon"), elementText(element),
        ].filter(Boolean).join(" ");
        // A link to another page counts only when its own label names a
        // credential; "View invoice" beside a masked card number does not.
        let pageLink = false;
        if (tag === "A") {
          try {
            pageLink =
              ["http:", "https:"].includes(new URL(String(element.href || "")).protocol) &&
              !String(elementAttribute(element, "href") || "").startsWith("#");
          } catch (_) {
            pageLink = false;
          }
        }
        if (revealLabelPattern.test(label) && (!pageLink || credentialContextPattern.test(label))) {
          let ancestor = element.parentElement;
          for (let depth = 0; ancestor && depth < 3; depth += 1, ancestor = ancestor.parentElement) {
            // Only a small container around the control, never a whole card or page.
            const ancestorText = typeof ancestor.textContent === "string" ? ancestor.textContent : "";
            if (ancestorText.length <= 400 && maskedTextPattern.test(elementText(ancestor))) {
              maskedNearReveal = true;
              break;
            }
          }
        }
      }
      return secretField && secretCode && maskedNearReveal;
    });
    return { credentialContext, secretField, secretCode, maskedNearReveal };
  } catch (_) {
    return null;
  }
}

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

// The model-facing view of the page. Text, title, address, control names and
// link targets are masked on every site and in every approval mode; a secret
// screen withholds the text and stays withheld until a new page loads.
async function snapshot(page, { withhold = false } = {}) {
  const interactive = await collectInteractiveElements(page);
  const rawUrl = page.url();
  const visibleText = await page
    .locator("body")
    .innerText({ timeout: 5_000 })
    .catch(() => "");
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
  const observe = (forceWithhold) =>
    redaction.redactPageObservation({
      url: rawUrl,
      title,
      text: String(visibleText || "").slice(0, MAX_VISIBLE_TEXT_CHARS * 5),
      names: interactive.map(({ description }) => description.label),
      signals,
      withhold: forceWithhold,
    });
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
  const maskLink = (href) => {
    if (!href) return href;
    const masked = redaction.redactUrl(href).text;
    return view.secretScreen ? strictlyMasked(masked) : masked;
  };
  return {
    snapshotId: snapshotFingerprint(rawUrl, interactive),
    browserPageId: EXPECTED_BROWSER_PAGE_ID,
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
  if (!approvalProtocol.isOriginApproved(page.url())) {
    return approvalProtocol.redactedPageResult();
  }
  return await snapshot(page, options);
}

async function emitNavigationResult(page) {
  if (!approvalProtocol.isOriginApproved(page.url())) {
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

async function settleAfterAction(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(250).catch(() => {});
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

function validateNavigationUrl(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_URL_CHARS) {
    throw new Error("Shared Browser navigation requires a bounded URL string");
  }
  const url = new URL(raw.trim());
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
    requireOnlyKeys(body, new Set(["url"]));
    validateNavigationUrl(body.url);
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

async function execute(browser, method, requestPath, body) {
  approvalProtocol.authority();
  let page = await resolveExpectedPage(browser);
  page.setDefaultTimeout(15_000);
  await page.bringToFront();

  if (method === "GET" && requestPath === "/v1/status") {
    const shared = {
      ready: true,
      browserPageId: EXPECTED_BROWSER_PAGE_ID,
      pageCount: browser.contexts().flatMap((context) => context.pages()).length,
    };
    if (isBlankPage(page)) {
      return blankPageResult(page, shared);
    }
    if (!approvalProtocol.isOriginApproved(page.url())) {
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

  if (method === "GET" && requestPath === "/v1/snapshot") {
    // A blank observation is not action evidence: like status, it only shows
    // that the browser is reachable, so a turn that stops here is retried.
    if (isBlankPage(page)) {
      return blankPageResult(page);
    }
    const approvedOrigin = await approvalProtocol.ensureOriginApproved(
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
    const sourceOrigin = await approvalProtocol.ensureOriginApproved(page.url(), "Allow the assistant to identify fields for your input");
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
    const url = validateNavigationUrl(body.url);
    const sourceOrigin = approvalProtocol.normalizedOrigin(page.url());
    // Risky addresses (sign-out, exports, files, one-time links, action
    // addresses) are judged by the address alone and ask even under routine
    // browsing. Under routine browsing, an address for a site the run has not
    // used yet does not ask on its own.
    const step = classifyStep("navigate", null, { url });
    await approvalProtocol.ensureOriginApproved(
      url,
      "Allow the assistant to access this destination for this run",
    );
    const destination = approvalProtocol.destinationBinding(url);
    await approvalProtocol.allowOnce({
      operation: "navigate",
      label: "Navigate the Shared Browser",
      categoryTitle: step.verdict === "ask" ? approvalCategoryTitle(step) : "",
      sourceOrigin,
      ...destination,
      snapshotId: null,
      targetFingerprint: null,
      payloadFingerprint: approvalProtocol.sha256("navigate"),
    }, { routine: step.verdict !== "ask" && !CONSEQUENTIAL_ACTION_PATTERN.test(url) });
    page = await resolveExpectedPage(browser);
    if (sourceOrigin) {
      assertSameOrigin(page.url(), sourceOrigin);
    }
    const revalidatedUrl = validateNavigationUrl(body.url);
    // An address the agent opens itself is not the page a credential step
    // opened.
    approvalProtocol.clearWithholdNextDocument();
    emitAction({ type: "navigate", label: `Go to ${url}`, url });
    await page.goto(revalidatedUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await settleAfterAction(page);
    page = await resolveExpectedPage(browser);
    await emitNavigationResult(page);
    return await snapshotForResult(page);
  }

  if (method === "POST" && requestPath === "/v1/click") {
    const sourceOrigin = await approvalProtocol.ensureOriginApproved(
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
    if (
      destination.destinationOrigin &&
      destination.destinationOrigin !== sourceOrigin
    ) {
      await approvalProtocol.ensureOriginApproved(
        rawDestination,
        "Allow the assistant to follow this control to another site for this run",
      );
    }
    await approvalProtocol.allowOnce({
      operation: "click",
      label: controlLabel(target.description) || "Activate this control",
      categoryTitle: approvalCategoryTitle(step),
      sourceOrigin,
      ...destination,
      snapshotId: body.snapshotId,
      targetFingerprint: approvedTargetFingerprint,
      payloadFingerprint: approvalProtocol.sha256("click"),
    }, {
      routine: routineCovers(step, target.description) &&
        !isFormSubmissionControl(target.description),
    });
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
    const sourceOrigin = await approvalProtocol.ensureOriginApproved(
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
    const approvedTargetFingerprint = targetFingerprint(target.description);
    const rawDestination = submitting
      ? resolvedTargetDestination(target.description, page.url()) || page.url()
      : null;
    const destination = approvalProtocol.destinationBinding(rawDestination);
    if (submitting) {
      if (
        destination.destinationOrigin &&
        destination.destinationOrigin !== sourceOrigin
      ) {
        await approvalProtocol.ensureOriginApproved(
          rawDestination,
          "Allow this form destination for this run",
        );
      }
    }
    await approvalProtocol.allowOnce({
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
    }, {
      routine: !submitting && routineCovers(step, target.description, { consequential: false }),
    });
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
    const sourceOrigin = await approvalProtocol.ensureOriginApproved(
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
    const destination = approvalProtocol.destinationBinding(rawDestination);
    if (activationKey) {
      if (
        destination.destinationOrigin &&
        destination.destinationOrigin !== sourceOrigin
      ) {
        await approvalProtocol.ensureOriginApproved(
          rawDestination,
          "Allow this activation destination for this run",
        );
      }
    }
    await approvalProtocol.allowOnce({
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
    }, { routine: !activationKey && routineCovers(step, target.description) });
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
    const sourceOrigin = await approvalProtocol.ensureOriginApproved(
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
    await denyDownloads(browser);
    let result;
    try {
      result = await execute(browser, method, requestPath, body || {});
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
