import { requestOriginAccessToken } from "./origins";

export type RuntimeBrowserSessionPage = {
  id: string;
  url: string;
  host: string;
  label: string;
  title: string | null;
  isActive: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /**
   * Who opened the tab, when the browser says so. Only "agent" and "person"
   * are kept; anything else is dropped, and an absent value is the person's.
   */
  openedBy?: BrowserTabOpener;
  /** One of Octo's tabs a person kept open past the end of the turn. */
  kept?: boolean;
  /**
   * The number one of Octo's tabs was opened with, which it keeps while it is
   * open: prompts, Octo and Studio all call it "Octo's tab <number>".
   */
  agentTabNumber?: number;
};

/** The highest number a Shared Browser run gives one of Octo's tabs. */
const MAX_AGENT_TAB_NUMBER = 999;

export function parseAgentTabNumber(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_AGENT_TAB_NUMBER
    ? (value as number)
    : undefined;
}

/** Who opened a browser tab: the agent (Octo) or the person. */
export type BrowserTabOpener = "agent" | "person";

export function parseBrowserTabOpener(value: unknown): BrowserTabOpener | undefined {
  return value === "agent" || value === "person" ? value : undefined;
}

export type SharedBrowserViewerKind = "rfb" | "cdp-screencast" | "webrtc";

export type RuntimeBrowserSessionCapabilities = {
  version: 2;
  approvalModes?: Array<"ask" | "routine">;
  viewerKinds: SharedBrowserViewerKind[];
  preferredViewer: SharedBrowserViewerKind;
  viewportOnly: boolean;
  rfb: {
    renderScale: number;
    maxFramebufferPixels: number;
  } | null;
  webrtc: {
    relayOnly: boolean;
    iceServers: Array<{
      urls: string[];
      username?: string;
      credential?: string;
    }>;
  } | null;
  controls: {
    navigate: boolean;
    history: boolean;
    reload: boolean;
    focusPage: boolean;
  };
};

export type RuntimeBrowserSessionPageCommandAction =
  | "navigate"
  | "back"
  | "forward"
  | "reload";

export type RuntimeBrowserSessionActionType =
  | "navigate"
  | "nav_result"
  | "click"
  | "type"
  | "scroll"
  | "human_input";

export type RuntimeBrowserHumanInputRequest = {
  version: 1;
  handoffId: string;
  runId: string;
  initiatorUserId: string;
  browserPageId: string;
  origin: string;
  createdAtMs: number;
  expiresAtMs: number;
  fields: Array<{ label: string }>;
};

export type RuntimeBrowserSessionAction = {
  seq: number;
  ts: number;
  // Legacy runtimes may omit this; unscoped events must not be drawn over a
  // selected page. Never use a URL as a substitute for exact target identity.
  pageId?: string | null;
  type: RuntimeBrowserSessionActionType;
  label: string;
  url: string | null;
  // Click target in browser-viewport CSS px, with the viewport size at emit
  // time, so the UI can place the AI cursor exactly on the VNC canvas.
  x: number | null;
  y: number | null;
  viewportW: number | null;
  viewportH: number | null;
  humanInputRequest?: RuntimeBrowserHumanInputRequest;
};

export type RuntimeBrowserSessionActionsResult = {
  actions: RuntimeBrowserSessionAction[];
  // Byte offset into the append-only actions log; feed it back as `since`.
  cursor: number;
};

const BROWSER_SESSION_ACTION_TYPES = new Set<RuntimeBrowserSessionActionType>([
  "navigate",
  "nav_result",
  "click",
  "type",
  "scroll",
  "human_input",
]);

const SHARED_BROWSER_VIEWER_KINDS = new Set<SharedBrowserViewerKind>([
  "rfb",
  "cdp-screencast",
  "webrtc",
]);

const BROWSER_SESSION_PAGE_COMMAND_ACTIONS = new Set<RuntimeBrowserSessionPageCommandAction>([
  "navigate",
  "back",
  "forward",
  "reload",
]);
const BROWSER_SESSION_UNAVAILABLE_STATUSES = new Set([404, 410, 502, 503, 504]);
const WEBRTC_ICE_SERVER_MAX_COUNT = 8;
const WEBRTC_ICE_URLS_PER_SERVER_MAX_COUNT = 4;
const WEBRTC_ICE_URL_MAX_BYTES = 2048;
const WEBRTC_ICE_CREDENTIAL_MAX_BYTES = 4096;

export class BrowserSessionUnavailableError extends Error {
  readonly status: number;
  /** The origin's error `code`, when its JSON body carried one. */
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "BrowserSessionUnavailableError";
    this.status = status;
    this.code = code;
  }
}

/** Instafy's browser on the space's own machine refused to start. */
export class SharedBrowserHostRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SharedBrowserHostRefusedError";
    this.code = code;
  }
}

export function isSharedBrowserHostRefusedError(
  error: unknown,
): error is SharedBrowserHostRefusedError {
  return error instanceof SharedBrowserHostRefusedError;
}

/** The origin's 404 `code` on `browser/host` when its machine has no browser host. */
export const SHARED_BROWSER_HOST_ABSENT_CODE = "browser_host_absent";
/** The controller's 404 `code` on `browser/host` while the space's hosted browser policy is off. */
export const SHARED_BROWSER_HOST_POLICY_OFF_CODE = "browser_host_policy_off";

/**
 * A 404 on `browser/host` that is not the machine's own answer that it has no
 * browser host: the controller's policy-off answer (`code` is
 * SHARED_BROWSER_HOST_POLICY_OFF_CODE), or a 404 from the controller or
 * something in front of it, which does not say anything about the browser.
 */
export class SharedBrowserHostNotFoundError extends Error {
  readonly status = 404;
  readonly code: string | null;

  constructor(code: string | null, message: string) {
    super(message);
    this.name = "SharedBrowserHostNotFoundError";
    this.code = code;
  }
}

const BROWSER_ERROR_CODE_MAX_LENGTH = 64;

/** The `code` of an origin error body (`{error, code}`), when there is one. */
export function readBrowserErrorCode(text: string): string | null {
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const code = (parsed as { code?: unknown }).code;
    return typeof code === "string" &&
      code.length > 0 &&
      code.length <= BROWSER_ERROR_CODE_MAX_LENGTH &&
      /^[a-z0-9_]+$/.test(code)
      ? code
      : null;
  } catch {
    return null;
  }
}

async function browserSessionUnavailableError(
  response: Response,
  label: string,
): Promise<BrowserSessionUnavailableError> {
  const text = await response.text().catch(() => "");
  return new BrowserSessionUnavailableError(
    response.status,
    `${label} unavailable (${response.status}): ${text}`,
    readBrowserErrorCode(text),
  );
}

export class BrowserSessionCapabilitiesIncompatibleError extends Error {
  constructor() {
    super("Shared Browser capabilities require a newer Instafy client.");
    this.name = "BrowserSessionCapabilitiesIncompatibleError";
  }
}

export function browserSessionStatusIndicatesUnavailable(status: number): boolean {
  return BROWSER_SESSION_UNAVAILABLE_STATUSES.has(status);
}

export function isBrowserSessionUnavailableError(
  error: unknown,
): error is BrowserSessionUnavailableError {
  return error instanceof BrowserSessionUnavailableError;
}

export function isBrowserSessionCapabilitiesIncompatibleError(
  error: unknown,
): error is BrowserSessionCapabilitiesIncompatibleError {
  return error instanceof BrowserSessionCapabilitiesIncompatibleError;
}

function buildOriginEndpointUrl(base: string, path: string): string {
  const normalizedBase = base.replace(/\/+$/, "");
  const normalizedPath = path.replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedPath}`;
}

export function mapRuntimeBrowserSessionPagesPayload(payload: unknown): RuntimeBrowserSessionPage[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const pages = Array.isArray((payload as { pages?: unknown[] }).pages)
    ? ((payload as { pages: unknown[] }).pages ?? [])
    : [];

  return pages
    .map((entry): RuntimeBrowserSessionPage | null => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const url = typeof record.url === "string" ? record.url.trim() : "";
      const host = typeof record.host === "string" ? record.host.trim() : "";
      const label = typeof record.label === "string" ? record.label.trim() : "";
      const title =
        typeof record.title === "string"
          ? record.title.trim()
          : record.title === null
            ? null
            : null;
      const isActive = record.isActive === true;
      if (!id || !url || !label) {
        return null;
      }
      const openedBy = parseBrowserTabOpener(record.openedBy);
      const agentTabNumber = openedBy === "agent" ? parseAgentTabNumber(record.agentTabNumber) : undefined;
      return {
        id,
        url,
        host,
        label,
        title: title && title.length > 0 ? title : null,
        isActive,
        canGoBack: record.canGoBack === true,
        canGoForward: record.canGoForward === true,
        ...(openedBy ? { openedBy } : {}),
        ...(openedBy === "agent" && record.kept === true ? { kept: true } : {}),
        ...(agentTabNumber ? { agentTabNumber } : {}),
      } satisfies RuntimeBrowserSessionPage;
    })
    .filter((page): page is RuntimeBrowserSessionPage => Boolean(page));
}

export function mapRuntimeBrowserSessionCapabilitiesPayload(
  payload: unknown,
): RuntimeBrowserSessionCapabilities | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (record.version !== 2 || !Array.isArray(record.viewerKinds)) {
    return null;
  }

  const viewerKinds = record.viewerKinds.filter(
    (value): value is SharedBrowserViewerKind =>
      typeof value === "string" &&
      SHARED_BROWSER_VIEWER_KINDS.has(value as SharedBrowserViewerKind),
  );
  const advertisedPreferredViewer =
    typeof record.preferredViewer === "string" &&
    SHARED_BROWSER_VIEWER_KINDS.has(record.preferredViewer as SharedBrowserViewerKind)
      ? (record.preferredViewer as SharedBrowserViewerKind)
      : null;
  const preferredViewer =
    advertisedPreferredViewer && viewerKinds.includes(advertisedPreferredViewer)
      ? advertisedPreferredViewer
      : viewerKinds[0] ?? null;
  if (!preferredViewer) {
    return null;
  }

  const rawControls =
    record.controls && typeof record.controls === "object"
      ? (record.controls as Record<string, unknown>)
      : {};
  const rawRfb =
    record.rfb && typeof record.rfb === "object"
      ? (record.rfb as Record<string, unknown>)
      : null;
  const renderScale =
    typeof rawRfb?.renderScale === "number" &&
    Number.isFinite(rawRfb.renderScale) &&
    rawRfb.renderScale >= 1 &&
    rawRfb.renderScale <= 2
      ? rawRfb.renderScale
      : null;
  const maxFramebufferPixels =
    typeof rawRfb?.maxFramebufferPixels === "number" &&
    Number.isSafeInteger(rawRfb.maxFramebufferPixels) &&
    rawRfb.maxFramebufferPixels > 0
      ? rawRfb.maxFramebufferPixels
      : null;
  if (viewerKinds.includes("rfb") && (!renderScale || !maxFramebufferPixels)) {
    return null;
  }

  const rawWebRtc =
    record.webrtc && typeof record.webrtc === "object"
      ? (record.webrtc as Record<string, unknown>)
      : null;
  const rawIceServers = rawWebRtc?.iceServers;
  const relayOnly = typeof rawWebRtc?.relayOnly === "boolean" ? rawWebRtc.relayOnly : null;
  const iceServers = Array.isArray(rawIceServers)
    ? rawIceServers
        .slice(0, WEBRTC_ICE_SERVER_MAX_COUNT)
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const server = entry as Record<string, unknown>;
          if (!Array.isArray(server.urls)) {
            return null;
          }
          const urls = server.urls
            .slice(0, WEBRTC_ICE_URLS_PER_SERVER_MAX_COUNT)
            .filter((url): url is string => typeof url === "string")
            .map((url) => url.trim())
            .filter(
              (url) =>
                url.length > 0 &&
                url.length <= WEBRTC_ICE_URL_MAX_BYTES &&
                /^(?:stun|stuns|turn|turns):/i.test(url),
            );
          if (urls.length === 0) {
            return null;
          }
          const optionalCredential = (value: unknown) =>
            typeof value === "string" &&
            value.trim().length > 0 &&
            value.length <= WEBRTC_ICE_CREDENTIAL_MAX_BYTES
              ? value.trim()
              : undefined;
          return {
            urls,
            ...(optionalCredential(server.username)
              ? { username: optionalCredential(server.username) }
              : {}),
            ...(optionalCredential(server.credential)
              ? { credential: optionalCredential(server.credential) }
              : {}),
          };
        })
        .filter((server): server is NonNullable<typeof server> => server !== null)
    : null;
  if (viewerKinds.includes("webrtc") && (!iceServers || relayOnly === null)) {
    return null;
  }

  return {
    version: 2,
    ...(Array.isArray(record.approvalModes) &&
    record.approvalModes.length > 0 && record.approvalModes.length <= 2 &&
    record.approvalModes.includes("ask") &&
    record.approvalModes.every((mode) => mode === "ask" || mode === "routine")
      ? { approvalModes: [...new Set(record.approvalModes)] as Array<"ask" | "routine"> }
      : {}),
    viewerKinds,
    preferredViewer,
    viewportOnly: record.viewportOnly === true,
    rfb:
      renderScale && maxFramebufferPixels
        ? { renderScale, maxFramebufferPixels }
        : null,
    webrtc: iceServers && relayOnly !== null ? { iceServers, relayOnly } : null,
    controls: {
      navigate: rawControls.navigate === true,
      history: rawControls.history === true,
      reload: rawControls.reload === true,
      focusPage: rawControls.focusPage === true,
    },
  };
}

export async function fetchRuntimeBrowserSessionCapabilities(params: {
  projectId: string;
  browserSessionId: string;
  preferRuntimeId?: string | null;
  accessToken?: string | null;
  signal?: AbortSignal;
}): Promise<RuntimeBrowserSessionCapabilities | null> {
  const token = await requestOriginAccessToken({
    projectId: params.projectId,
    protocol: "http",
    scopes: ["browser.view"],
    preferRuntime: params.preferRuntimeId ?? null,
    accessToken: params.accessToken ?? null,
    browserSessionId: params.browserSessionId,
  });

  if (!token) {
    return null;
  }

  params.signal?.throwIfAborted();
  const response = await fetch(buildOriginEndpointUrl(token.endpoint, "/browser/capabilities"), {
    headers: {
      authorization: `Bearer ${token.token}`,
      accept: "application/json",
    },
    signal: params.signal,
  });

  if (browserSessionStatusIndicatesUnavailable(response.status)) {
    throw await browserSessionUnavailableError(response, "browser capabilities");
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`browser capabilities failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as unknown;
  const capabilities = mapRuntimeBrowserSessionCapabilitiesPayload(payload);
  if (!capabilities) {
    throw new BrowserSessionCapabilitiesIncompatibleError();
  }
  return capabilities;
}

/**
 * Instafy's browser on the space's own machine (`GET browser/host`), relative
 * to the person asking. `unknown` stands for any state this client does not
 * know yet; callers poll again on it.
 */
export type SharedBrowserHostState =
  | "idle"
  | "starting"
  | "ready"
  | "stopping"
  | "failed"
  | "poisoned"
  | "unknown";

export type SharedBrowserHostSnapshot = {
  version: 1;
  mode: "lazy";
  state: SharedBrowserHostState;
  /** New for every start; null while idle. */
  generation: string | null;
  /** Why it failed, as a short token; null unless failed or poisoned. */
  failure: string | null;
  /** The person asking started the current run of the browser. */
  startedByYou: boolean;
  /** Someone else has it open, or used it in the last 30 seconds. */
  othersPresent: boolean;
  /** Someone else has control of it. */
  controlledByOther: boolean;
  /** An agent run works in it, or that cannot be read. */
  agentRunActive: boolean;
  /** That agent run is the person's own. */
  agentRunStartedByYou: boolean;
};

const SHARED_BROWSER_HOST_STATES = new Set<SharedBrowserHostState>([
  "idle",
  "starting",
  "ready",
  "stopping",
  "failed",
  "poisoned",
]);
const SHARED_BROWSER_HOST_FLAGS = [
  "startedByYou",
  "othersPresent",
  "controlledByOther",
  "agentRunActive",
  "agentRunStartedByYou",
] as const;
const SHARED_BROWSER_HOST_TOKEN_MAX_LENGTH = 64;

function sharedBrowserHostToken(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= SHARED_BROWSER_HOST_TOKEN_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : null;
}

/**
 * Reads `GET browser/host`. Only version 1 in `lazy` mode is understood;
 * anything else is null. A state this client does not know maps to
 * `unknown`, so a later state does not break older tabs.
 */
export function mapSharedBrowserHostPayload(
  payload: unknown,
): SharedBrowserHostSnapshot | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record.version !== 1 || record.mode !== "lazy") {
    return null;
  }
  if (SHARED_BROWSER_HOST_FLAGS.some((flag) => typeof record[flag] !== "boolean")) {
    return null;
  }
  const state =
    typeof record.state === "string" &&
    SHARED_BROWSER_HOST_STATES.has(record.state as SharedBrowserHostState)
      ? (record.state as SharedBrowserHostState)
      : "unknown";
  return {
    version: 1,
    mode: "lazy",
    state,
    generation: sharedBrowserHostToken(record.generation),
    failure: sharedBrowserHostToken(record.failure),
    startedByYou: record.startedByYou === true,
    othersPresent: record.othersPresent === true,
    controlledByOther: record.controlledByOther === true,
    agentRunActive: record.agentRunActive === true,
    agentRunStartedByYou: record.agentRunStartedByYou === true,
  };
}

type SharedBrowserHostRequestParams = {
  projectId: string;
  runtimeId: string;
  browserSessionId: string;
  accessToken?: string | null;
  signal?: AbortSignal;
};

/** The origin token request failed; callers may ask again. */
export class SharedBrowserHostTokenError extends Error {
  constructor() {
    super("Instafy's browser could not be reached (origin token request failed).");
    this.name = "SharedBrowserHostTokenError";
  }
}

async function requestSharedBrowserHostToken(
  params: SharedBrowserHostRequestParams,
  scope: "browser.view" | "browser.control",
) {
  const token = await requestOriginAccessToken({
    projectId: params.projectId,
    protocol: "http",
    scopes: [scope],
    preferRuntime: params.runtimeId,
    accessToken: params.accessToken ?? null,
    browserSessionId: params.browserSessionId,
    signal: params.signal,
  });
  if (!token) {
    throw new SharedBrowserHostTokenError();
  }
  return token;
}

/**
 * Whether a 404 body on `browser/host` is the origin's own answer that its
 * machine has no browser host: the `browser_host_absent` code, or (from an
 * origin that predates it) the origin's `{error, code: "not_found"}` body.
 * The controller's own errors carry `message`, never `error`.
 */
export function isSharedBrowserHostAbsentAnswer(text: string): boolean {
  const code = readBrowserErrorCode(text);
  if (code === SHARED_BROWSER_HOST_ABSENT_CODE) {
    return true;
  }
  if (code !== "not_found") {
    return false;
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string";
  } catch {
    return false;
  }
}

async function readSharedBrowserHostResponse(
  response: Response,
  label: string,
): Promise<SharedBrowserHostSnapshot | null> {
  if (response.status === 404) {
    const text = await response.text().catch(() => "");
    if (isSharedBrowserHostAbsentAnswer(text)) {
      return null;
    }
    const code = readBrowserErrorCode(text);
    throw new SharedBrowserHostNotFoundError(code, `${label} not found (404)${code ? `: ${code}` : ""}`);
  }
  if (response.status === 409) {
    const text = await response.text().catch(() => "");
    const code = readBrowserErrorCode(text) ?? "conflict";
    throw new SharedBrowserHostRefusedError(code, `${label} refused (409): ${code}`);
  }
  if (browserSessionStatusIndicatesUnavailable(response.status)) {
    throw await browserSessionUnavailableError(response, label);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${label} failed (${response.status}): ${text}`);
  }
  const payload = (await response.json()) as unknown;
  const snapshot = mapSharedBrowserHostPayload(payload);
  if (!snapshot) {
    throw new BrowserSessionCapabilitiesIncompatibleError();
  }
  return snapshot;
}

/**
 * Instafy's browser on the space's own machine, as the person sees it. Null
 * only when the machine itself answers that it has none (see
 * isSharedBrowserHostAbsentAnswer). Any other 404 throws
 * SharedBrowserHostNotFoundError, whose `code` is `browser_host_policy_off`
 * when the space's policy is off. Throws BrowserSessionUnavailableError on
 * 502, 503 and 504.
 */
export async function fetchSharedBrowserHost(
  params: SharedBrowserHostRequestParams,
): Promise<SharedBrowserHostSnapshot | null> {
  const token = await requestSharedBrowserHostToken(params, "browser.view");
  const response = await fetch(buildOriginEndpointUrl(token.endpoint, "/browser/host"), {
    headers: {
      authorization: `Bearer ${token.token}`,
      accept: "application/json",
    },
    cache: "no-store",
    signal: params.signal,
  });
  return readSharedBrowserHostResponse(response, "browser host");
}

/**
 * Asks the space's machine to start Instafy's browser. It never waits for
 * the browser to be ready; poll fetchSharedBrowserHost for that. A refusal
 * (409) throws SharedBrowserHostRefusedError with the origin's code, such as
 * `browser_host_stopping`, `browser_host_poisoned` or `machine_stopping`.
 */
export async function startSharedBrowserHost(
  params: SharedBrowserHostRequestParams,
): Promise<SharedBrowserHostSnapshot | null> {
  const token = await requestSharedBrowserHostToken(params, "browser.control");
  const response = await fetch(buildOriginEndpointUrl(token.endpoint, "/browser/host/start"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.token}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ version: 1 }),
    signal: params.signal,
  });
  return readSharedBrowserHostResponse(response, "browser host start");
}

export async function fetchRuntimeBrowserSessionPages(params: {
  projectId: string;
  browserSessionId: string;
  preferRuntimeId?: string | null;
  accessToken?: string | null;
  includePlaceholder?: boolean;
  signal?: AbortSignal;
}): Promise<RuntimeBrowserSessionPage[] | null> {
  const token = await requestOriginAccessToken({
    projectId: params.projectId,
    protocol: "http",
    scopes: ["browser.view"],
    preferRuntime: params.preferRuntimeId ?? null,
    accessToken: params.accessToken ?? null,
    browserSessionId: params.browserSessionId,
  });

  if (!token) {
    return null;
  }
  // The token request keeps its own timeout and shared in-flight request; the
  // signal ends the page read itself.
  params.signal?.throwIfAborted();

  const endpoint = buildOriginEndpointUrl(token.endpoint, "/browser/pages");
  const response = await fetch(
    params.includePlaceholder ? `${endpoint}?includePlaceholder=true` : endpoint,
    {
      headers: {
        authorization: `Bearer ${token.token}`,
        accept: "application/json",
      },
      signal: params.signal,
    },
  );

  if (browserSessionStatusIndicatesUnavailable(response.status)) {
    throw await browserSessionUnavailableError(response, "browser pages");
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`browser pages failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as unknown;
  return mapRuntimeBrowserSessionPagesPayload(payload);
}

export async function commandRuntimeBrowserSessionPage(params: {
  projectId: string;
  browserSessionId: string;
  pageId: string;
  action: RuntimeBrowserSessionPageCommandAction;
  url?: string | null;
  preferRuntimeId?: string | null;
  accessToken?: string | null;
}): Promise<boolean> {
  const pageId = params.pageId.trim();
  if (!pageId || !BROWSER_SESSION_PAGE_COMMAND_ACTIONS.has(params.action)) {
    return false;
  }

  const url = params.url?.trim() ?? "";
  if (params.action === "navigate" && !url) {
    return false;
  }

  const token = await requestOriginAccessToken({
    projectId: params.projectId,
    protocol: "http",
    scopes: ["browser.control"],
    preferRuntime: params.preferRuntimeId ?? null,
    accessToken: params.accessToken ?? null,
    browserSessionId: params.browserSessionId,
  });

  if (!token) {
    return false;
  }

  const response = await fetch(
    buildOriginEndpointUrl(token.endpoint, `/browser/pages/${encodeURIComponent(pageId)}/command`),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(
        params.action === "navigate" ? { action: params.action, url } : { action: params.action },
      ),
    },
  );

  if (browserSessionStatusIndicatesUnavailable(response.status)) {
    return false;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`browser page command failed (${response.status}): ${text}`);
  }

  return true;
}

/** A workspace browser page read for Send page to Octo, masked on its machine. */
export type RuntimeBrowserSessionPageCapture = {
  pageId: string;
  url: string;
  title: string;
  text: string;
  secretScreen: boolean;
  truncated: boolean;
  readAt: string;
};

/** Why the workspace browser did not hand over a page. */
export class BrowserSessionPageCaptureError extends Error {
  readonly status: number;
  /** From the origin's own answer: the tab shows no web page, or the page changed mid-read. */
  readonly reason: "not_web_page" | "changed" | null;

  constructor(status: number, message: string, reason: "not_web_page" | "changed" | null = null) {
    super(message);
    this.name = "BrowserSessionPageCaptureError";
    this.status = status;
    this.reason = reason;
  }
}

function browserPageCaptureRefusalReason(status: number, text: string): "not_web_page" | "changed" | null {
  if (status !== 409) return null;
  let message = "";
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    message = typeof parsed?.error === "string" ? parsed.error : "";
  } catch {
    return null;
  }
  if (message === "this tab has no web page to send") return "not_web_page";
  if (message.startsWith("the page changed while it was being read")) return "changed";
  return null;
}

const BROWSER_PAGE_CAPTURE_TEXT_MAX_CHARS = 50_000;

export function mapRuntimeBrowserSessionPageCapturePayload(
  payload: unknown,
  pageId: string,
): RuntimeBrowserSessionPageCapture | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const row = payload as Record<string, unknown>;
  if (
    row.pageId !== pageId ||
    typeof row.url !== "string" || row.url.length > 32_768 ||
    typeof row.title !== "string" || row.title.length > 4_000 ||
    typeof row.text !== "string" || row.text.length > BROWSER_PAGE_CAPTURE_TEXT_MAX_CHARS ||
    typeof row.secretScreen !== "boolean" ||
    typeof row.truncated !== "boolean" ||
    typeof row.readAt !== "string" || Number.isNaN(Date.parse(row.readAt))
  ) {
    return null;
  }
  // A withheld page never carries text, whatever answered.
  return {
    pageId,
    url: row.url,
    title: row.secretScreen ? "" : row.title,
    text: row.secretScreen ? "" : row.text,
    secretScreen: row.secretScreen,
    truncated: row.truncated,
    readAt: row.readAt,
  };
}

/**
 * Send page to Octo: asks the workspace browser to read one page once. The
 * page is read and masked on the browser's own machine; this returns only the
 * masked copy. Needs `browser.control`. Call it only for a person's press.
 */
export async function captureRuntimeBrowserSessionPage(params: {
  projectId: string;
  browserSessionId: string;
  pageId: string;
  preferRuntimeId?: string | null;
  accessToken?: string | null;
}): Promise<RuntimeBrowserSessionPageCapture> {
  const pageId = params.pageId.trim();
  if (!pageId) {
    throw new BrowserSessionPageCaptureError(400, "browser page capture needs a page");
  }
  const token = await requestOriginAccessToken({
    projectId: params.projectId,
    protocol: "http",
    scopes: ["browser.control"],
    preferRuntime: params.preferRuntimeId ?? null,
    accessToken: params.accessToken ?? null,
    browserSessionId: params.browserSessionId,
  });
  if (!token) {
    throw new BrowserSessionPageCaptureError(401, "browser page capture was not allowed");
  }
  const response = await fetch(
    buildOriginEndpointUrl(token.endpoint, `/browser/pages/${encodeURIComponent(pageId)}/capture`),
    {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${token.token}`,
        accept: "application/json",
      },
    },
  );
  if (!response.ok) {
    // The origin's error text is never shown; only its fixed refusals are told apart.
    const text = await response.text().catch(() => "");
    throw new BrowserSessionPageCaptureError(
      response.status,
      `browser page capture failed (${response.status})`,
      browserPageCaptureRefusalReason(response.status, text),
    );
  }
  const capture = mapRuntimeBrowserSessionPageCapturePayload(await response.json().catch(() => null), pageId);
  if (!capture) {
    throw new BrowserSessionPageCaptureError(502, "browser page capture returned an invalid page");
  }
  return capture;
}

export async function focusRuntimeBrowserSessionPage(params: {
  projectId: string;
  browserSessionId: string;
  pageId: string;
  preferRuntimeId?: string | null;
  accessToken?: string | null;
}): Promise<boolean> {
  const pageId = params.pageId.trim();
  if (!pageId) {
    return false;
  }

  const token = await requestOriginAccessToken({
    projectId: params.projectId,
    protocol: "http",
    scopes: ["browser.control"],
    preferRuntime: params.preferRuntimeId ?? null,
    accessToken: params.accessToken ?? null,
    browserSessionId: params.browserSessionId,
  });

  if (!token) {
    return false;
  }

  const response = await fetch(
    buildOriginEndpointUrl(token.endpoint, `/browser/pages/${encodeURIComponent(pageId)}/focus`),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.token}`,
      },
    },
  );

  if (browserSessionStatusIndicatesUnavailable(response.status)) {
    return false;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`browser page focus failed (${response.status}): ${text}`);
  }

  return true;
}

/**
 * Keep tab: one of Octo's tabs stays open when its turn ends, as an ordinary
 * tab. It gives nobody any access.
 */
export async function keepRuntimeBrowserSessionPage(params: {
  projectId: string;
  browserSessionId: string;
  pageId: string;
  preferRuntimeId?: string | null;
  accessToken?: string | null;
}): Promise<boolean> {
  const pageId = params.pageId.trim();
  if (!pageId) {
    return false;
  }

  const token = await requestOriginAccessToken({
    projectId: params.projectId,
    protocol: "http",
    scopes: ["browser.control"],
    preferRuntime: params.preferRuntimeId ?? null,
    accessToken: params.accessToken ?? null,
    browserSessionId: params.browserSessionId,
  });

  if (!token) {
    return false;
  }

  const response = await fetch(
    buildOriginEndpointUrl(token.endpoint, `/browser/pages/${encodeURIComponent(pageId)}/keep`),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.token}`,
      },
    },
  );

  // The origin answers 404 once the turn has ended or the tab is not Octo's.
  if (response.status === 404) {
    throw new Error("This tab is no longer one of Octo's tabs, so there is nothing to keep.");
  }

  if (browserSessionStatusIndicatesUnavailable(response.status)) {
    return false;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Keeping the tab failed (${response.status}): ${text}`);
  }

  return true;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const BROWSER_HANDOFF_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isBrowserActionPageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !/[^A-Za-z0-9_-]/.test(value);
}

function isBrowserHandoffUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && BROWSER_HANDOFF_UUID_PATTERN.test(value);
}

function mapBrowserHumanInputRequest(value: unknown): RuntimeBrowserHumanInputRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  const keys = ["version", "handoffId", "runId", "initiatorUserId", "browserPageId", "origin", "createdAtMs", "expiresAtMs", "fields"];
  if (Object.keys(row).length !== keys.length || !keys.every((key) => Object.hasOwn(row, key))) {
    return null;
  }
  if (row.version !== 1
    || !isBrowserHandoffUuid(row.handoffId)
    || !isBrowserHandoffUuid(row.runId)
    || !isBrowserHandoffUuid(row.initiatorUserId)
    || !isBrowserActionPageId(row.browserPageId)
    || typeof row.origin !== "string" || new TextEncoder().encode(row.origin).length > 512
    || typeof row.createdAtMs !== "number" || !Number.isSafeInteger(row.createdAtMs) || row.createdAtMs <= 0
    || typeof row.expiresAtMs !== "number" || !Number.isSafeInteger(row.expiresAtMs)
    || row.expiresAtMs <= row.createdAtMs || row.expiresAtMs - row.createdAtMs > 600_000
    || !Array.isArray(row.fields) || row.fields.length < 1 || row.fields.length > 8) {
    return null;
  }
  try {
    const origin = new URL(row.origin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.origin !== row.origin) {
      return null;
    }
  } catch {
    return null;
  }
  const fields: Array<{ label: string }> = [];
  for (const field of row.fields) {
    if (!field || typeof field !== "object" || Array.isArray(field)
      || Object.keys(field).length !== 1 || !Object.hasOwn(field, "label")
      || typeof field.label !== "string" || !field.label.trim()
      || new TextEncoder().encode(field.label).length > 80
      || Array.from(field.label as string).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      })) {
      return null;
    }
    fields.push({ label: field.label });
  }
  return {
    version: 1,
    handoffId: row.handoffId,
    runId: row.runId,
    initiatorUserId: row.initiatorUserId,
    browserPageId: row.browserPageId,
    origin: row.origin,
    createdAtMs: row.createdAtMs,
    expiresAtMs: row.expiresAtMs,
    fields,
  };
}

export function mapRuntimeBrowserSessionActionsPayload(
  payload: unknown,
): RuntimeBrowserSessionActionsResult {
  if (!payload || typeof payload !== "object") {
    return { actions: [], cursor: 0 };
  }
  const record = payload as { actions?: unknown[]; cursor?: unknown };
  const cursor = typeof record.cursor === "number" && record.cursor >= 0 ? record.cursor : 0;
  const rawActions = Array.isArray(record.actions) ? record.actions : [];

  const actions = rawActions
    .map((entry): RuntimeBrowserSessionAction | null => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const row = entry as Record<string, unknown>;
      const type = typeof row.type === "string" ? row.type.trim() : "";
      const seq = toFiniteNumber(row.seq);
      if (seq === null || !BROWSER_SESSION_ACTION_TYPES.has(type as RuntimeBrowserSessionActionType)) {
        return null;
      }
      const url = typeof row.url === "string" && row.url.trim().length > 0 ? row.url.trim() : null;
      const pageId = isBrowserActionPageId(row.pageId)
        ? row.pageId
        : null;
      const humanInputRequest = type === "human_input"
        ? mapBrowserHumanInputRequest(row.humanInputRequest)
        : null;
      if (type === "human_input" && (!humanInputRequest || humanInputRequest.browserPageId !== pageId)) {
        return null;
      }
      return {
        seq,
        ts: toFiniteNumber(row.ts) ?? 0,
        pageId,
        type: type as RuntimeBrowserSessionActionType,
        label: typeof row.label === "string" ? row.label.trim() : "",
        url,
        x: toFiniteNumber(row.x),
        y: toFiniteNumber(row.y),
        viewportW: toFiniteNumber(row.viewportW),
        viewportH: toFiniteNumber(row.viewportH),
        ...(humanInputRequest ? { humanInputRequest } : {}),
      } satisfies RuntimeBrowserSessionAction;
    })
    .filter((action): action is RuntimeBrowserSessionAction => Boolean(action));

  return { actions, cursor };
}

export async function fetchRuntimeBrowserSessionActions(params: {
  projectId: string;
  browserSessionId: string;
  preferRuntimeId?: string | null;
  accessToken?: string | null;
  sinceCursor?: number;
}): Promise<RuntimeBrowserSessionActionsResult | null> {
  const token = await requestOriginAccessToken({
    projectId: params.projectId,
    protocol: "http",
    scopes: ["browser.view"],
    preferRuntime: params.preferRuntimeId ?? null,
    accessToken: params.accessToken ?? null,
    browserSessionId: params.browserSessionId,
  });

  if (!token) {
    return null;
  }

  const since = Math.max(0, Math.floor(params.sinceCursor ?? 0));
  const response = await fetch(
    buildOriginEndpointUrl(token.endpoint, `/browser/actions?since=${since}`),
    {
      headers: {
        authorization: `Bearer ${token.token}`,
        accept: "application/json",
      },
    },
  );

  if (browserSessionStatusIndicatesUnavailable(response.status)) {
    throw await browserSessionUnavailableError(response, "browser actions");
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`browser actions failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as unknown;
  return mapRuntimeBrowserSessionActionsPayload(payload);
}
