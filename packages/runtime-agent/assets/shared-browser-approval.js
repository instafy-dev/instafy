globalThis.__instafyCreateSharedBrowserApprovalProtocol = (() => {
  const fs = require("fs");
  const path = require("path");
  const crypto = require("crypto");

  const MARKER_MAX_BYTES = 4 * 1024;
  const REQUEST_MAX_BYTES = 16 * 1024;
  const DECISION_MAX_BYTES = 8 * 1024;
  const STATE_MAX_BYTES = 16 * 1024;
  const MAX_APPROVED_ORIGINS = 32;
  const MAX_CONSUMED_APPROVALS = 64;
  const MAX_ORIGIN_BYTES = 512;
  const MAX_OPERATION_BYTES = 64;
  const MAX_LABEL_BYTES = 240;
  const MAX_PAGE_ID_BYTES = 256;
  const MAX_APPROVAL_WAIT_MS = 60_000;
  const DEFAULT_APPROVAL_WAIT_MS = 30_000;
  const POLL_INTERVAL_MS = 50;
  const CLOCK_SKEW_MS = 1_000;
  const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
  const PAGE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
  const FIXED_FILES = new Set(["request.json", "decision.json", "state.json"]);

  function fail(code, message) {
    throw new Error(`${message} [${code}_non_retryable]`);
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

  function boundedText(value, maxBytes) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    if (byteLength(normalized) <= maxBytes) {
      return normalized;
    }
    let end = normalized.length;
    while (end > 0 && byteLength(normalized.slice(0, end)) > maxBytes) {
      end -= 1;
    }
    return normalized.slice(0, end);
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
    if (entries.length > 16 || entries.some((entry) => !FIXED_FILES.has(entry))) {
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
      `.instafy-approval-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
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
    if (!path.isAbsolute(markerPath)) {
      fail("approval_storage_invalid", "Shared Browser authority marker path must be absolute");
    }
    ensureApprovalDirectory(approvalDir);
    const requestPath = path.join(approvalDir, "request.json");
    const decisionPath = path.join(approvalDir, "decision.json");
    const statePath = path.join(approvalDir, "state.json");

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
        ],
        "Shared Browser approval state",
      );
      if (
        state.version !== 1 ||
        state.ownerId !== authority.ownerId ||
        state.runId !== authority.runId ||
        state.initiatorUserId !== authority.initiatorUserId ||
        state.browserPageId !== authority.browserPageId ||
        (Object.hasOwn(state, "routineBrowsingAllowed") &&
          typeof state.routineBrowsingAllowed !== "boolean") ||
        !Array.isArray(state.approvedOrigins) ||
        state.approvedOrigins.length > MAX_APPROVED_ORIGINS ||
        state.approvedOrigins.some(
          (origin) =>
            typeof origin !== "string" ||
            byteLength(origin) > MAX_ORIGIN_BYTES ||
            normalizedOrigin(origin) !== origin,
        ) ||
        new Set(state.approvedOrigins).size !== state.approvedOrigins.length ||
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

    function isOriginApproved(rawUrl) {
      const origin = normalizedOrigin(rawUrl);
      if (!origin) {
        return false;
      }
      const authority = readAuthority(initialAuthority);
      const state = readState(authority);
      return state.routineBrowsingAllowed === true || state.approvedOrigins.includes(origin);
    }

    function buildRequest(kind, details) {
      const authority = readAuthority(initialAuthority);
      const now = Date.now();
      const approvalId = crypto.randomUUID();
      const operation = boundedText(details.operation, MAX_OPERATION_BYTES);
      if (!operation) {
        fail("approval_protocol_invalid", "Shared Browser approval operation is missing");
      }
      const display = {
        label: boundedText(details.label, MAX_LABEL_BYTES),
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
        expiresAtMs: now + timeoutMs,
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
            writeState(state);
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

    async function ensureOriginApproved(rawUrl, label = "") {
      const origin = normalizedOrigin(rawUrl);
      if (!origin) {
        fail("origin_not_approvable", "Shared Browser cannot expose or act on this page origin");
      }
      const authority = readAuthority(initialAuthority);
      const current = readState(authority);
      if (current.routineBrowsingAllowed === true || current.approvedOrigins.includes(origin)) {
        return origin;
      }
      if (current.approvedOrigins.length >= MAX_APPROVED_ORIGINS) {
        fail("approval_state_full", "Shared Browser reached its per-run approved-origin limit");
      }
      const destination = destinationBinding(origin);
      const request = buildRequest("origin", {
        operation: "approve-origin",
        label: label || `Allow ${origin} for this run`,
        sourceOrigin: origin,
        ...destination,
        snapshotId: null,
        targetFingerprint: null,
        payloadFingerprint: null,
      });
      const { decision, state } = await awaitDecision(request);
      readAuthority(initialAuthority);
      // Only the authenticated initiating user's explicit origin-prompt choice
      // can grant this policy. It never comes from tool arguments or job metadata.
      if (decision.decision === "allow_routine") {
        state.routineBrowsingAllowed = true;
      }
      if (!state.approvedOrigins.includes(origin)) {
        state.approvedOrigins = [...state.approvedOrigins, origin];
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
      allowOnce,
      redactedPageResult,
    };
  }

  return create;
})();
