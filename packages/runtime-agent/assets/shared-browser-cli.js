const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
let actionOrdinal = 0;

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

function emitAction(event) {
  try {
    fs.mkdirSync(path.dirname(ACTIONS_FILE), { recursive: true });
    fs.appendFileSync(
      ACTIONS_FILE,
      `${JSON.stringify({
        seq: Date.now() * 100 + ++actionOrdinal,
        ts: Date.now(),
        type: event.type,
        label: event.label || "",
        url: event.url || null,
        x: event.x ?? null,
        y: event.y ?? null,
        viewportW: event.viewportW ?? null,
        viewportH: event.viewportH ?? null,
        pageId: EXPECTED_BROWSER_PAGE_ID,
      })}\n`,
    );
  } catch (_) {
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
      return page;
    }
  }
  throw new Error(
    `Shared Browser selected page ${EXPECTED_BROWSER_PAGE_ID} is unavailable; select a live browser tab and retry`,
  );
}

async function describeElement(locator, index) {
  const box = await locator.boundingBox().catch(() => null);
  const attributes = await locator
    .evaluate((element) => {
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
          element instanceof HTMLInputElement ? bounded(element.type || "text", 64) : "",
        autocomplete: bounded(element.getAttribute("autocomplete"), 512),
        inputMode: bounded(element.getAttribute("inputmode"), 64),
        formAction,
        formMethod,
        formActionText: form
          ? `form ${formMethod} ${formAction} ${formText}`.slice(0, 2_000)
          : "",
        labels,
        text: bounded(element.textContent || ""),
      };
    })
    .catch(() => null);
  if (!attributes || !box) {
    return null;
  }
  const label = [
    attributes.ariaLabel,
    attributes.ariaLabelledByText,
    attributes.labels,
    attributes.placeholder,
    attributes.titleAttribute,
    attributes.text,
    attributes.nameAttribute,
  ]
    .find((value) => typeof value === "string" && value.trim())
    ?.trim()
    .slice(0, 240) || `${attributes.tag} ${index}`;
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
    box: {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    },
  };
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
  }));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ pageId: EXPECTED_BROWSER_PAGE_ID, url, elements }))
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

async function snapshot(page) {
  const interactive = await collectInteractiveElements(page);
  const visibleText = await page
    .locator("body")
    .innerText({ timeout: 5_000 })
    .catch(() => "");
  return {
    snapshotId: snapshotFingerprint(page.url(), interactive),
    browserPageId: EXPECTED_BROWSER_PAGE_ID,
    url: page.url(),
    title: await page.title().catch(() => ""),
    visibleText: visibleText.slice(0, MAX_VISIBLE_TEXT_CHARS),
    interactiveElements: interactive.map(({ description }) =>
      publicElementDescription(description),
    ),
  };
}

async function snapshotForResult(page) {
  if (!approvalProtocol.isOriginApproved(page.url())) {
    return approvalProtocol.redactedPageResult();
  }
  return await snapshot(page);
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
  emitAction({
    type: "nav_result",
    label: await page.title().catch(() => page.url()),
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
  if (requestPath === "/v1/navigate") {
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
    if (!approvalProtocol.isOriginApproved(page.url())) {
      return approvalProtocol.redactedPageResult(shared);
    }
    return {
      ...shared,
      originApproved: true,
      redacted: false,
      url: page.url(),
      title: await page.title().catch(() => ""),
    };
  }

  if (method === "GET" && requestPath === "/v1/snapshot") {
    const approvedOrigin = await approvalProtocol.ensureOriginApproved(
      page.url(),
      "Allow the assistant to read and interact with this site for this run",
    );
    page = await resolveExpectedPage(browser);
    assertSameOrigin(page.url(), approvedOrigin);
    const result = await snapshot(page);
    emitAction({
      type: "nav_result",
      label: result.title || result.url,
      url: result.url,
    });
    return result;
  }

  if (method === "POST" && requestPath === "/v1/navigate") {
    const url = validateNavigationUrl(body.url);
    const sourceOrigin = approvalProtocol.normalizedOrigin(page.url());
    await approvalProtocol.ensureOriginApproved(
      url,
      "Allow the assistant to access this destination for this run",
    );
    const destination = approvalProtocol.destinationBinding(url);
    await approvalProtocol.allowOnce({
      operation: "navigate",
      label: "Navigate the Shared Browser",
      sourceOrigin,
      ...destination,
      snapshotId: null,
      targetFingerprint: null,
      payloadFingerprint: approvalProtocol.sha256("navigate"),
    });
    page = await resolveExpectedPage(browser);
    if (sourceOrigin) {
      assertSameOrigin(page.url(), sourceOrigin);
    }
    const revalidatedUrl = validateNavigationUrl(body.url);
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
      label: target.description.label || "Activate this control",
      sourceOrigin,
      ...destination,
      snapshotId: body.snapshotId,
      targetFingerprint: approvedTargetFingerprint,
      payloadFingerprint: approvalProtocol.sha256("click"),
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
    const box = target.description.box;
    const size = await viewport(page);
    emitAction({
      type: "click",
      label: `Click "${target.description.label}"`,
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
    return await snapshotForResult(page);
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
    const approvedTargetFingerprint = targetFingerprint(target.description);
    const submitting = body.submit === true;
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
        ? target.description.label || "Submit this form"
        : target.description.label || "Type into this field",
      sourceOrigin,
      ...destination,
      snapshotId: body.snapshotId,
      targetFingerprint: approvedTargetFingerprint,
      payloadFingerprint: approvalProtocol.sha256(
        JSON.stringify({ text: body.text, submit: submitting }),
      ),
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
      label: `Type into "${target.description.label}"`,
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
    await target.locator.fill(body.text);
    if (submitting) {
      await target.locator.press("Enter");
      await settleAfterAction(page);
      page = await resolveExpectedPage(browser);
      await emitNavigationResult(page);
    }
    page = await resolveExpectedPage(browser);
    return await snapshotForResult(page);
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
        ? target.description.label || "Activate this control"
        : `Press ${pressKey} on ${target.description.label || "this field"}`,
      sourceOrigin,
      ...destination,
      snapshotId: body.snapshotId,
      targetFingerprint: approvedTargetFingerprint,
      payloadFingerprint: approvalProtocol.sha256(body.key),
    });
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
    emitAction({
      type: "type",
      label: `Press ${pressKey}`,
      url: page.url(),
    });
    await target.locator.press(pressKey);
    await settleAfterAction(page);
    page = await resolveExpectedPage(browser);
    return await snapshotForResult(page);
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

async function main() {
  const method = String(process.argv[1] || "").toUpperCase();
  const requestPath = String(process.argv[2] || "");
  const body = process.argv[3] ? JSON.parse(process.argv[3]) : null;
  if (method === "POST") {
    validateRequestBody(requestPath, body);
  }
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15_000 });
  try {
    const result = await execute(browser, method, requestPath, body || {});
    await writeStdout(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } finally {
    if (typeof browser.disconnect === "function") {
      await browser.disconnect().catch(() => {});
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    const message = error && error.message ? error.message : String(error);
    process.stderr.write(`Shared Browser command failed: ${message}\n`);
    process.exit(1);
  },
);
