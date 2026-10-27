globalThis.__instafyCreateSharedBrowserApprovalProtocol = (() => {
  const fs = require("fs");
  const path = require("path");
  const crypto = require("crypto");

  const MARKER_MAX_BYTES = 4 * 1024;
  const REQUEST_MAX_BYTES = 16 * 1024;
  const DECISION_MAX_BYTES = 8 * 1024;
  const STATE_MAX_BYTES = 16 * 1024;
  const WITHHOLD_MAX_BYTES = 4 * 1024;
  const MAX_APPROVED_ORIGINS = 32;
  // A site the person declined stays closed for the rest of the run, without
  // another prompt. The first site declined in a run leaves the run going, so
  // Octo can take another route that fits the person's request (the site they
  // named, opened directly); declining another site ends the run, so a denial
  // never turns into a chain of prompts. A declined step (not a site) ends the
  // run at once.
  const MAX_DECLINED_ORIGINS = 1;
  const MAX_CONSUMED_APPROVALS = 64;
  const MAX_ORIGIN_BYTES = 512;
  const MAX_OPERATION_BYTES = 64;
  const MAX_LABEL_BYTES = 240;
  const MAX_PAGE_ID_BYTES = 256;
  // How long a person has to answer the prompts of one browser tool call.
  // One helper process runs one tool call, and every prompt it shows ends by
  // the same deadline, so a site prompt and the step prompt after it share
  // this budget. runtime-agent sizes the browser tool's timeout from these
  // values, and origin-http-server caps a request's lifetime at the maximum:
  // change all three together (`shared_browser_tests.rs` checks they agree).
  const MAX_APPROVAL_WAIT_MS = 300_000;
  const DEFAULT_APPROVAL_WAIT_MS = 120_000;
  // The origin refuses a request that lives less than this, so a call whose
  // budget is spent ends as unanswered instead of publishing one.
  const MIN_REQUEST_WINDOW_MS = 100;
  const POLL_INTERVAL_MS = 50;
  const CLOCK_SKEW_MS = 1_000;
  const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
  const PAGE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
  const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
  const TABS_MAX_BYTES = 8 * 1024;
  const KEPT_TABS_MAX_BYTES = 4 * 1024;
  // Octo may have at most this many tabs of its own open at once, next to the
  // page the person chose for the run. runtime-agent and the origin read the
  // same files and hold the same bound.
  const MAX_AGENT_TABS = 3;
  // Each of Octo's tabs keeps the number it was opened with ("Octo's tab 2")
  // for as long as it is open; a run numbers its tabs 1, 2, 3, ... and never
  // reuses a number. The origin shows the same number to every viewer.
  const MAX_AGENT_TAB_NUMBER = 999;
  const FIXED_FILES = new Set([
    "request.json",
    "decision.json",
    "state.json",
    "withhold-next.json",
    // The tabs Octo opened in this run, each with its number and its own site
    // approvals.
    "tabs.json",
    // The tabs the person kept, which stay open when the run ends. The origin
    // writes it; this script only reads it.
    "kept-tabs.json",
    // Octo's tabs from an earlier run that could not be closed yet. runtime-
    // agent writes it; it gives this run nothing, and this script never reads it.
    "leftover-tabs.json",
  ]);
  // Every writer of the approval directory publishes through a temporary
  // file with this prefix (runtime-agent's cleanup accepts the same prefix).
  const TEMPORARY_FILE_PREFIX = ".instafy-approval-";

  function fail(code, message) {
    throw new Error(`${message} [${code}_non_retryable]`);
  }

  // Not a terminal code: the run goes on, so Octo can take another route that
  // fits the person's request. The site itself stays closed for the run.
  function siteDeclinedError(origin) {
    return new Error(
      `The person declined ${origin} for this run, so nothing there was opened or read, and Octo does not ask for it again in this run. Take another route that fits their request, such as opening the site they named directly, or end the turn and ask them how to continue. Declining another site ends the run. [site_declined]`,
    );
  }

  function storageCall(message, operation) {
    try {
      return operation();
    } catch (error) {
      if (
        error instanceof Error &&
        /\[approval_[a-z_]+_non_retryable\]/.test(error.message)
      ) {
        throw error;
      }
      fail("approval_storage_invalid", message);
    }
  }

  function byteLength(value) {
    return Buffer.byteLength(String(value || ""), "utf8");
  }

  // The origin accepts a label only when it equals its own whitespace-joined
  // form (Rust `split_whitespace`, which also splits on U+0085) and is valid
  // UTF-8. Cut on code points and trim again after the cut, so a long label
  // never ends in a space or half of a surrogate pair.
  function boundedText(value, maxBytes) {
    const normalized = String(value || "")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
      .replace(/[\s\u0085]+/g, " ")
      .trim();
    if (byteLength(normalized) <= maxBytes) {
      return normalized;
    }
    let bounded = "";
    let bytes = 0;
    for (const character of normalized) {
      const size = byteLength(character);
      if (bytes + size > maxBytes) {
        break;
      }
      bounded += character;
      bytes += size;
    }
    return bounded.trimEnd();
  }

  function sha256(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex");
  }

  function exactObject(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("approval_protocol_invalid", `${label} must be an object`);
    }
    const expected = new Set(keys);
    if (
      Object.keys(value).length !== expected.size ||
      Object.keys(value).some((key) => !expected.has(key))
    ) {
      fail("approval_protocol_invalid", `${label} has unsupported or missing fields`);
    }
    return value;
  }

  function assertUuid(value, label) {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      fail("approval_protocol_invalid", `${label} must be a UUID`);
    }
    return value.toLowerCase();
  }

  function assertHex64(value, label, nullable = false) {
    if (nullable && value === null) {
      return null;
    }
    if (typeof value !== "string" || !HEX_64_PATTERN.test(value)) {
      fail("approval_protocol_invalid", `${label} must be a SHA-256 fingerprint`);
    }
    return value;
  }

  function assertPageId(value) {
    if (
      typeof value !== "string" ||
      !value ||
      byteLength(value) > MAX_PAGE_ID_BYTES ||
      !PAGE_ID_PATTERN.test(value)
    ) {
      fail("approval_protocol_invalid", "browserPageId is invalid");
    }
    return value;
  }

  function ensureApprovalDirectory(directory) {
    if (!path.isAbsolute(directory)) {
      fail("approval_storage_invalid", "Shared Browser approval directory must be absolute");
    }
    storageCall("Shared Browser approval directory could not be created", () =>
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 }),
    );
    const metadata = storageCall(
      "Shared Browser approval directory could not be inspected",
      () => fs.lstatSync(directory),
    );
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail("approval_storage_invalid", "Shared Browser approval path must be a real directory");
    }
    storageCall("Shared Browser approval directory could not be protected", () =>
      fs.chmodSync(directory, 0o700),
    );
    const entries = storageCall(
      "Shared Browser approval directory could not be listed",
      () => fs.readdirSync(directory),
    );
    // A record being published right now: this script, the origin (Keep tab)
    // and runtime-agent (the leftover record) each write a temporary file
    // with this prefix and rename it into place. It is never read, and
    // runtime-agent clears one a write left behind with the run.
    const inFlight = (entry) => entry.startsWith(TEMPORARY_FILE_PREFIX);
    if (entries.length > 16 || entries.some((entry) => !FIXED_FILES.has(entry) && !inFlight(entry))) {
      fail("approval_storage_invalid", "Shared Browser approval directory is outside its fixed bounds");
    }
  }

  function readRegularFile(filePath, maxBytes, required) {
    let metadata;
    try {
      metadata = fs.lstatSync(filePath);
    } catch (error) {
      if (!required && error && error.code === "ENOENT") {
        return null;
      }
      fail("approval_storage_invalid", `${path.basename(filePath)} could not be inspected`);
    }
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > maxBytes ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
      fail(
        "approval_storage_invalid",
        `${path.basename(filePath)} is not a protected bounded regular file`,
      );
    }
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const fd = storageCall(`${path.basename(filePath)} could not be opened`, () =>
      fs.openSync(filePath, fs.constants.O_RDONLY | noFollow),
    );
    try {
      const opened = storageCall(
        `${path.basename(filePath)} could not be verified after opening`,
        () => fs.fstatSync(fd),
      );
      if (!opened.isFile() || opened.size !== metadata.size || opened.size > maxBytes) {
        fail("approval_storage_invalid", `${path.basename(filePath)} changed while opening`);
      }
      return storageCall(`${path.basename(filePath)} could not be read`, () =>
        fs.readFileSync(fd, "utf8"),
      );
    } finally {
      storageCall(`${path.basename(filePath)} could not be closed`, () =>
        fs.closeSync(fd),
      );
    }
  }

  function readJson(filePath, maxBytes, required) {
    const raw = readRegularFile(filePath, maxBytes, required);
    if (raw === null) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (_) {
      fail("approval_protocol_invalid", `${path.basename(filePath)} is invalid JSON`);
    }
  }

  function removeRegularFile(filePath, required = false) {
    let metadata;
    try {
      metadata = fs.lstatSync(filePath);
    } catch (error) {
      if (!required && error && error.code === "ENOENT") {
        return;
      }
      fail("approval_storage_invalid", `${path.basename(filePath)} could not be inspected`);
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail("approval_storage_invalid", `${path.basename(filePath)} is not a regular file`);
    }
    storageCall(`${path.basename(filePath)} could not be removed`, () =>
      fs.unlinkSync(filePath),
    );
  }

  function atomicWriteJson(filePath, value, maxBytes) {
    const payload = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(payload, "utf8") > maxBytes) {
      fail("approval_protocol_invalid", `${path.basename(filePath)} exceeds its size bound`);
    }
    const tempPath = path.join(
      path.dirname(filePath),
      `${TEMPORARY_FILE_PREFIX}${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
    );
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const fd = storageCall(
      `${path.basename(filePath)} temporary file could not be created`,
      () =>
        fs.openSync(
          tempPath,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            noFollow,
          0o600,
        ),
    );
    try {
      storageCall(`${path.basename(filePath)} could not be written`, () =>
        fs.writeFileSync(fd, payload, "utf8"),
      );
      storageCall(`${path.basename(filePath)} could not be synchronized`, () =>
        fs.fsyncSync(fd),
      );
    } finally {
      storageCall(`${path.basename(filePath)} could not be closed`, () =>
        fs.closeSync(fd),
      );
    }
    try {
      storageCall(`${path.basename(filePath)} could not be protected`, () =>
        fs.chmodSync(tempPath, 0o600),
      );
      storageCall(`${path.basename(filePath)} could not be published`, () =>
        fs.renameSync(tempPath, filePath),
      );
    } catch (error) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {
        // Preserve the original storage error.
      }
      throw error;
    }
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function normalizedOrigin(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ""));
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
        return null;
      }
      return url.origin;
    } catch (_) {
      return null;
    }
  }

  function destinationBinding(rawUrl) {
    if (!rawUrl) {
      return { destinationOrigin: null, destinationFingerprint: sha256("no-destination") };
    }
    const url = new URL(String(rawUrl));
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      fail("approval_protocol_invalid", "Shared Browser approval destination is invalid");
    }
    return {
      destinationOrigin: url.origin,
      destinationFingerprint: sha256(url.toString()),
    };
  }

  function create(config) {
    const approvalDir = String(config.approvalDir || "");
    const markerPath = String(config.markerPath || "");
    const expectedPageId = assertPageId(String(config.browserPageId || ""));
    const requestedTimeout = Number(config.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout)
      ? Math.max(100, Math.min(MAX_APPROVAL_WAIT_MS, Math.floor(requestedTimeout)))
      : DEFAULT_APPROVAL_WAIT_MS;
    const callDeadlineMs = Date.now() + timeoutMs;
    if (!path.isAbsolute(markerPath)) {
      fail("approval_storage_invalid", "Shared Browser authority marker path must be absolute");
    }
    ensureApprovalDirectory(approvalDir);
    const requestPath = path.join(approvalDir, "request.json");
    const decisionPath = path.join(approvalDir, "decision.json");
    const statePath = path.join(approvalDir, "state.json");
    const withholdPath = path.join(approvalDir, "withhold-next.json");

    function readAuthority(expected = null) {
      const marker = exactObject(
        readJson(markerPath, MARKER_MAX_BYTES, true),
        [
          "version",
          "ownerId",
          "runId",
          "initiatorUserId",
          "browserPageId",
          "displayName",
          "expiresAtMs",
        ],
        "Shared Browser authority marker",
      );
      if (
        marker.version !== 2 ||
        typeof marker.displayName !== "string" ||
        byteLength(marker.displayName) > 80 ||
        !Number.isSafeInteger(marker.expiresAtMs) ||
        marker.expiresAtMs <= Date.now()
      ) {
        fail("approval_authority_revoked", "Shared Browser authority is stale or invalid");
      }
      const authority = {
        ownerId: assertUuid(marker.ownerId, "ownerId"),
        runId: assertUuid(marker.runId, "runId"),
        initiatorUserId: assertUuid(marker.initiatorUserId, "initiatorUserId"),
        browserPageId: assertPageId(marker.browserPageId),
      };
      if (authority.browserPageId !== expectedPageId) {
        fail("approval_authority_revoked", "Shared Browser page authority changed");
      }
      if (
        expected &&
        Object.keys(authority).some((key) => authority[key] !== expected[key])
      ) {
        fail("approval_authority_revoked", "Shared Browser run authority changed while awaiting approval");
      }
      return authority;
    }

    const initialAuthority = readAuthority();

    function emptyState(authority) {
      return {
        version: 1,
        ...authority,
        approvedOrigins: [],
        consumedApprovalIds: [],
        routineBrowsingAllowed: false,
      };
    }

    function readState(authority) {
      const raw = readJson(statePath, STATE_MAX_BYTES, false);
      if (raw === null) {
        return emptyState(authority);
      }
      const state = exactObject(
        raw,
        [
          "version",
          "ownerId",
          "runId",
          "initiatorUserId",
          "browserPageId",
          "approvedOrigins",
          "consumedApprovalIds",
          ...(Object.hasOwn(raw, "routineBrowsingAllowed") ? ["routineBrowsingAllowed"] : []),
          ...(Object.hasOwn(raw, "declinedOrigins") ? ["declinedOrigins"] : []),
        ],
        "Shared Browser approval state",
      );
      const validOrigins = (origins, max) =>
        Array.isArray(origins) &&
        origins.length <= max &&
        !origins.some(
          (origin) =>
            typeof origin !== "string" ||
            byteLength(origin) > MAX_ORIGIN_BYTES ||
            normalizedOrigin(origin) !== origin,
        ) &&
        new Set(origins).size === origins.length;
      if (
        state.version !== 1 ||
        state.ownerId !== authority.ownerId ||
        state.runId !== authority.runId ||
        state.initiatorUserId !== authority.initiatorUserId ||
        state.browserPageId !== authority.browserPageId ||
        (Object.hasOwn(state, "routineBrowsingAllowed") &&
          typeof state.routineBrowsingAllowed !== "boolean") ||
        !validOrigins(state.approvedOrigins, MAX_APPROVED_ORIGINS) ||
        (Object.hasOwn(state, "declinedOrigins") &&
          !validOrigins(state.declinedOrigins, MAX_DECLINED_ORIGINS)) ||
        !Array.isArray(state.consumedApprovalIds) ||
        state.consumedApprovalIds.length > MAX_CONSUMED_APPROVALS ||
        state.consumedApprovalIds.some((id) => !UUID_PATTERN.test(id)) ||
        new Set(state.consumedApprovalIds).size !== state.consumedApprovalIds.length
      ) {
        fail("approval_state_invalid", "Shared Browser approval state is invalid or belongs to another run");
      }
      return state;
    }

    function writeState(state) {
      atomicWriteJson(statePath, state, STATE_MAX_BYTES);
    }

    // The tabs Octo opened in this run. `currentTabId` is the tab its tools
    // act on (null: the page the person chose), each tab holds its number and
    // the sites the person approved in that tab, and `lastTabNumber` is the
    // number the run last gave a tab. Bound to the run like the state.
    function emptyTabs(authority) {
      return { version: 2, ...authority, currentTabId: null, lastTabNumber: 0, tabs: [] };
    }

    function validTabNumbers(record) {
      const numbers = record.tabs.map((tab) => tab.number);
      return (
        Number.isSafeInteger(record.lastTabNumber) &&
        record.lastTabNumber >= 0 &&
        record.lastTabNumber <= MAX_AGENT_TAB_NUMBER &&
        numbers.every((number) => Number.isSafeInteger(number) && number >= 1 && number <= record.lastTabNumber) &&
        new Set(numbers).size === numbers.length
      );
    }

    function validTabOrigins(origins) {
      return (
        Array.isArray(origins) &&
        origins.length <= MAX_APPROVED_ORIGINS &&
        origins.every(
          (origin) =>
            typeof origin === "string" &&
            byteLength(origin) <= MAX_ORIGIN_BYTES &&
            normalizedOrigin(origin) === origin,
        ) &&
        new Set(origins).size === origins.length
      );
    }

    function readTabsFor(authority) {
      const raw = readJson(path.join(approvalDir, "tabs.json"), TABS_MAX_BYTES, false);
      if (raw === null) {
        return emptyTabs(authority);
      }
      const record = exactObject(
        raw,
        ["version", "ownerId", "runId", "initiatorUserId", "browserPageId", "currentTabId", "lastTabNumber", "tabs"],
        "Shared Browser tab record",
      );
      const tabIds = Array.isArray(record.tabs)
        ? record.tabs.map((tab) => exactObject(tab, ["tabId", "number", "approvedOrigins"], "Shared Browser tab").tabId)
        : [];
      if (
        record.version !== 2 ||
        Object.keys(authority).some((key) => record[key] !== authority[key]) ||
        !Array.isArray(record.tabs) ||
        record.tabs.length > MAX_AGENT_TABS ||
        tabIds.some((tabId) => {
          try {
            return assertPageId(tabId) === authority.browserPageId;
          } catch (_) {
            return true;
          }
        }) ||
        new Set(tabIds).size !== tabIds.length ||
        record.tabs.some((tab) => !validTabOrigins(tab.approvedOrigins)) ||
        !validTabNumbers(record) ||
        (record.currentTabId !== null && !tabIds.includes(record.currentTabId))
      ) {
        fail("approval_state_invalid", "Shared Browser tab record is invalid or belongs to another run");
      }
      return record;
    }

    function readTabs() {
      return readTabsFor(readAuthority(initialAuthority));
    }

    function writeTabs(record) {
      const authority = readAuthority(initialAuthority);
      const next = {
        version: 2,
        ...authority,
        currentTabId: record.currentTabId ?? null,
        // A number once given is never given again in this run.
        lastTabNumber: Math.max(readTabsFor(authority).lastTabNumber, record.lastTabNumber ?? 0),
        tabs: record.tabs.map((tab) => ({
          tabId: tab.tabId,
          number: tab.number,
          approvedOrigins: [...tab.approvedOrigins],
        })),
      };
      // Checked the way it is read back, so a bad record is never published.
      const tabIds = next.tabs.map((tab) => tab.tabId);
      if (
        next.tabs.length > MAX_AGENT_TABS ||
        tabIds.some((tabId) => assertPageId(tabId) === authority.browserPageId) ||
        new Set(tabIds).size !== tabIds.length ||
        next.tabs.some((tab) => !validTabOrigins(tab.approvedOrigins)) ||
        !validTabNumbers(next) ||
        (next.currentTabId !== null && !tabIds.includes(next.currentTabId))
      ) {
        fail("approval_protocol_invalid", "Shared Browser tab record is out of bounds");
      }
      atomicWriteJson(path.join(approvalDir, "tabs.json"), next, TABS_MAX_BYTES);
      return next;
    }

    // The tabs the person kept open past the end of the run. Read only; the
    // origin writes it when the person presses Keep tab.
    function keptTabIds() {
      const authority = readAuthority(initialAuthority);
      const raw = readJson(path.join(approvalDir, "kept-tabs.json"), KEPT_TABS_MAX_BYTES, false);
      if (raw === null) {
        return new Set();
      }
      const record = exactObject(
        raw,
        ["version", "ownerId", "runId", "initiatorUserId", "browserPageId", "tabIds"],
        "Shared Browser kept-tab record",
      );
      if (
        record.version !== 1 ||
        Object.keys(authority).some((key) => record[key] !== authority[key]) ||
        !Array.isArray(record.tabIds) ||
        record.tabIds.length > MAX_AGENT_TABS
      ) {
        fail("approval_state_invalid", "Shared Browser kept-tab record is invalid or belongs to another run");
      }
      return new Set(record.tabIds.map((tabId) => assertPageId(tabId)));
    }

    // Sites approved in one of Octo's own tabs are that tab's: approving a
    // site on the page the person chose does not open it to Octo's tabs, nor
    // the other way round. Routine browsing covers the whole run.
    function tabApprovedOrigins(authority, tabId) {
      const tab = readTabsFor(authority).tabs.find((entry) => entry.tabId === tabId);
      if (!tab) {
        fail("approval_authority_revoked", "Shared Browser tab is not one of this run's tabs");
      }
      return tab.approvedOrigins;
    }

    function isOriginApproved(rawUrl, tabId = null) {
      const origin = normalizedOrigin(rawUrl);
      if (!origin) {
        return false;
      }
      const authority = readAuthority(initialAuthority);
      const state = readState(authority);
      if (state.routineBrowsingAllowed === true) {
        return true;
      }
      return tabId === null
        ? state.approvedOrigins.includes(origin)
        : tabApprovedOrigins(authority, tabId).includes(origin);
    }

    // Whether the run has routine browsing now: the person's own choice at a
    // site prompt, or runtime-agent's at the start of a run on an attested
    // browser host. Never a tool argument.
    function routineBrowsingAllowed() {
      return readState(readAuthority(initialAuthority)).routineBrowsingAllowed === true;
    }

    function buildRequest(kind, details) {
      const authority = readAuthority(initialAuthority);
      const now = Date.now();
      const approvalId = crypto.randomUUID();
      const operation = boundedText(details.operation, MAX_OPERATION_BYTES);
      if (!operation) {
        fail("approval_protocol_invalid", "Shared Browser approval operation is missing");
      }
      // The step's category leads the label, so the person sees what kind of
      // step this is ("Download or export: Export CSV") without a protocol
      // change. Callers pass labels that are already masked.
      const categoryTitle = boundedText(details.categoryTitle, MAX_LABEL_BYTES);
      const label = boundedText(details.label, MAX_LABEL_BYTES);
      const display = {
        label: boundedText(categoryTitle && label ? `${categoryTitle}: ${label}` : label || categoryTitle, MAX_LABEL_BYTES),
        destinationOrigin: details.destinationOrigin || null,
      };
      const requestCore = {
        version: 1,
        approvalId,
        kind,
        ...authority,
        operation,
        sourceOrigin: details.sourceOrigin || null,
        destinationOrigin: details.destinationOrigin || null,
        destinationFingerprint: assertHex64(
          details.destinationFingerprint,
          "destinationFingerprint",
        ),
        snapshotId: assertHex64(details.snapshotId ?? null, "snapshotId", true),
        targetFingerprint: assertHex64(
          details.targetFingerprint ?? null,
          "targetFingerprint",
          true,
        ),
        payloadFingerprint: assertHex64(
          details.payloadFingerprint ?? null,
          "payloadFingerprint",
          true,
        ),
        requestedAtMs: now,
        expiresAtMs: Math.min(now + timeoutMs, callDeadlineMs),
      };
      const requestFingerprint = sha256(JSON.stringify(requestCore));
      return { ...requestCore, requestFingerprint, display };
    }

    function validateDecision(raw, request, state) {
      const decision = exactObject(
        raw,
        [
          "version",
          "approvalId",
          "requestFingerprint",
          "decision",
          "decidedByUserId",
          "decidedAtMs",
          "expiresAtMs",
        ],
        "Shared Browser approval decision",
      );
      if (
        decision.version !== 1 ||
        !UUID_PATTERN.test(decision.approvalId) ||
        decision.approvalId !== request.approvalId ||
        !HEX_64_PATTERN.test(decision.requestFingerprint) ||
        decision.requestFingerprint !== request.requestFingerprint ||
        decision.decidedByUserId !== request.initiatorUserId ||
        !["allow_origin", "allow_routine", "allow_once", "deny"].includes(decision.decision) ||
        !Number.isSafeInteger(decision.decidedAtMs) ||
        !Number.isSafeInteger(decision.expiresAtMs) ||
        decision.decidedAtMs < request.requestedAtMs - CLOCK_SKEW_MS ||
        decision.decidedAtMs > Date.now() + CLOCK_SKEW_MS ||
        decision.expiresAtMs > request.expiresAtMs ||
        decision.expiresAtMs <= Date.now()
      ) {
        fail("approval_stale_or_replayed", "Shared Browser approval is stale, mismatched, or replayed");
      }
      if (state.consumedApprovalIds.includes(decision.approvalId)) {
        fail("approval_stale_or_replayed", "Shared Browser approval was already consumed");
      }
      const expectedAllow = request.kind === "origin" ? "allow_origin" : "allow_once";
      if (
        decision.decision !== "deny" &&
        decision.decision !== expectedAllow &&
        !(request.kind === "origin" && decision.decision === "allow_routine")
      ) {
        fail("approval_stale_or_replayed", "Shared Browser approval has the wrong grant type");
      }
      return decision;
    }

    async function awaitDecision(request) {
      if (fs.existsSync(requestPath)) {
        // A helper killed between publishing and cleaning a request must not
        // permanently wedge the fixed slot. Consume the protected regular
        // file, fail this attempt closed, and require a fresh user-initiated
        // action before another request may be published.
        removeRegularFile(requestPath, true);
        fail("approval_stale_or_replayed", "A stale Shared Browser approval request is still present");
      }
      if (fs.existsSync(decisionPath)) {
        removeRegularFile(decisionPath);
        fail("approval_stale_or_replayed", "A stale Shared Browser approval decision was rejected");
      }
      if (request.expiresAtMs - Date.now() < MIN_REQUEST_WINDOW_MS) {
        // An earlier prompt of this call used up the shared budget.
        fail("approval_timeout", "Shared Browser approval timed out; the action was not performed");
      }
      atomicWriteJson(requestPath, request, REQUEST_MAX_BYTES);
      let cleanupRequired = true;
      try {
        while (Date.now() < request.expiresAtMs) {
          const authority = readAuthority(initialAuthority);
          const rawDecision = readJson(decisionPath, DECISION_MAX_BYTES, false);
          if (rawDecision !== null) {
            // Consume the transport slot before validating or acting. A bad,
            // denied, or replayed decision can never be edited into an allow.
            removeRegularFile(decisionPath, true);
            const state = readState(authority);
            const decision = validateDecision(rawDecision, request, state);
            state.consumedApprovalIds = [
              ...state.consumedApprovalIds,
              decision.approvalId,
            ].slice(-MAX_CONSUMED_APPROVALS);
            const declined = state.declinedOrigins || [];
            const siteDeclined =
              decision.decision === "deny" &&
              request.kind === "origin" &&
              declined.length < MAX_DECLINED_ORIGINS;
            if (siteDeclined) {
              state.declinedOrigins = [...declined, request.sourceOrigin];
            }
            writeState(state);
            if (siteDeclined) {
              throw siteDeclinedError(request.sourceOrigin);
            }
            if (decision.decision === "deny") {
              fail("approval_denied", "The user denied this Shared Browser action; it was not performed");
            }
            return { decision, state };
          }
          await sleep(POLL_INTERVAL_MS);
        }
        fail("approval_timeout", "Shared Browser approval timed out; the action was not performed");
      } finally {
        if (cleanupRequired) {
          removeRegularFile(requestPath, false);
          cleanupRequired = false;
        }
      }
    }

    // `destinationUrl`: the exact address the step that asks will load. The
    // prompt is then bound to it (and its label names it), not only to its
    // site.
    async function ensureOriginApproved(rawUrl, label = "", tabId = null, { destinationUrl = null } = {}) {
      const origin = normalizedOrigin(rawUrl);
      if (!origin) {
        // Not a consent decision, so not final: navigating to an http(s)
        // address goes through that site's own approval.
        throw new Error(
          "Shared Browser cannot expose or act on this page origin. It has no http(s) address to approve; navigate to the address the task names first [origin_not_approvable]",
        );
      }
      const authority = readAuthority(initialAuthority);
      const current = readState(authority);
      const approved = tabId === null ? current.approvedOrigins : tabApprovedOrigins(authority, tabId);
      if (current.routineBrowsingAllowed === true || approved.includes(origin)) {
        return origin;
      }
      if ((current.declinedOrigins || []).includes(origin)) {
        throw siteDeclinedError(origin);
      }
      if (approved.length >= MAX_APPROVED_ORIGINS) {
        fail("approval_state_full", "Shared Browser reached its per-run approved-origin limit");
      }
      const destination = destinationBinding(
        destinationUrl && normalizedOrigin(destinationUrl) === origin ? destinationUrl : origin,
      );
      // A label given as a function is made only now, when a prompt shows.
      const shownLabel = typeof label === "function" ? label() : label;
      const request = buildRequest("origin", {
        operation: "approve-origin",
        label: shownLabel || `Allow ${origin} for this run`,
        sourceOrigin: origin,
        ...destination,
        snapshotId: null,
        targetFingerprint: null,
        payloadFingerprint: null,
      });
      const { decision, state } = await awaitDecision(request);
      readAuthority(initialAuthority);
      // Routine browsing comes only from the authenticated initiating user's
      // explicit origin-prompt choice, or from runtime-agent itself, which
      // writes it into the run's state before the run starts on a
      // controller-attested browser host. It never comes from tool arguments
      // or job metadata.
      if (decision.decision === "allow_routine") {
        state.routineBrowsingAllowed = true;
      }
      if (tabId === null) {
        if (!state.approvedOrigins.includes(origin)) {
          state.approvedOrigins = [...state.approvedOrigins, origin];
        }
      } else {
        // The site is approved in this tab only.
        const tabs = readTabsFor(authority);
        const tab = tabs.tabs.find((entry) => entry.tabId === tabId);
        if (!tab) {
          fail("approval_authority_revoked", "Shared Browser tab closed while its site approval was pending");
        }
        if (!tab.approvedOrigins.includes(origin)) {
          tab.approvedOrigins = [...tab.approvedOrigins, origin];
          writeTabs(tabs);
        }
      }
      writeState(state);
      return origin;
    }

    async function allowOnce(details, options = {}) {
      const request = buildRequest("action", details);
      const authority = readAuthority(initialAuthority);
      if (options.routine === true && readState(authority).routineBrowsingAllowed === true) {
        readAuthority(initialAuthority);
        return request;
      }
      await awaitDecision(request);
      readAuthority(initialAuthority);
      return request;
    }

    // A key change or "may show a secret" step can open its page later than
    // the step's own call waits. The step records the document it ran on; the
    // next snapshot of any other document withholds that document and clears
    // the record. The run's approval directory, and with it the record, is
    // cleared when the run starts and ends.
    function withholdNextDocumentAfter() {
      const authority = readAuthority(initialAuthority);
      const raw = readJson(withholdPath, WITHHOLD_MAX_BYTES, false);
      if (raw === null) {
        return null;
      }
      const record = exactObject(
        raw,
        ["version", "ownerId", "runId", "initiatorUserId", "browserPageId", "afterDocument"],
        "Shared Browser withheld-document record",
      );
      if (
        record.version !== 1 ||
        Object.keys(authority).some((key) => record[key] !== authority[key]) ||
        typeof record.afterDocument !== "string" ||
        !DOCUMENT_ID_PATTERN.test(record.afterDocument)
      ) {
        fail("approval_state_invalid", "Shared Browser withheld-document record is invalid or belongs to another run");
      }
      return record.afterDocument;
    }

    function withholdNextDocument(afterDocument) {
      if (typeof afterDocument !== "string" || !DOCUMENT_ID_PATTERN.test(afterDocument)) {
        fail("approval_protocol_invalid", "Shared Browser document identity is invalid");
      }
      const authority = readAuthority(initialAuthority);
      atomicWriteJson(
        withholdPath,
        { version: 1, ...authority, afterDocument },
        WITHHOLD_MAX_BYTES,
      );
    }

    function clearWithholdNextDocument() {
      removeRegularFile(withholdPath, false);
    }

    function redactedPageResult(extra = {}) {
      return {
        ...extra,
        browserPageId: expectedPageId,
        originApproved: false,
        redacted: true,
        url: null,
        title: null,
        visibleText: "",
        interactiveElements: [],
        message:
          "The visible page changed to an origin that has not been approved for this run. Take a snapshot to request access.",
      };
    }

    return {
      authority: () => readAuthority(initialAuthority),
      normalizedOrigin,
      destinationBinding,
      sha256,
      isOriginApproved,
      ensureOriginApproved,
      routineBrowsingAllowed,
      allowOnce,
      withholdNextDocumentAfter,
      withholdNextDocument,
      clearWithholdNextDocument,
      redactedPageResult,
      readTabs,
      writeTabs,
      keptTabIds,
      maxAgentTabs: MAX_AGENT_TABS,
      maxAgentTabNumber: MAX_AGENT_TAB_NUMBER,
    };
  }

  return create;
})();
