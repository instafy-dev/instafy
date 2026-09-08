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
};

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

  constructor(status: number, message: string) {
    super(message);
    this.name = "BrowserSessionUnavailableError";
    this.status = status;
  }
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
    .map((entry) => {
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
      return {
        id,
        url,
        host,
        label,
        title: title && title.length > 0 ? title : null,
        isActive,
        canGoBack: record.canGoBack === true,
        canGoForward: record.canGoForward === true,
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

  const response = await fetch(buildOriginEndpointUrl(token.endpoint, "/browser/capabilities"), {
    headers: {
      authorization: `Bearer ${token.token}`,
      accept: "application/json",
    },
  });

  if (browserSessionStatusIndicatesUnavailable(response.status)) {
    const text = await response.text().catch(() => "");
    throw new BrowserSessionUnavailableError(
      response.status,
      `browser capabilities unavailable (${response.status}): ${text}`,
    );
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

export async function fetchRuntimeBrowserSessionPages(params: {
  projectId: string;
  browserSessionId: string;
  preferRuntimeId?: string | null;
  accessToken?: string | null;
  includePlaceholder?: boolean;
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

  const endpoint = buildOriginEndpointUrl(token.endpoint, "/browser/pages");
  const response = await fetch(
    params.includePlaceholder ? `${endpoint}?includePlaceholder=true` : endpoint,
    {
      headers: {
        authorization: `Bearer ${token.token}`,
        accept: "application/json",
      },
    },
  );

  if (browserSessionStatusIndicatesUnavailable(response.status)) {
    const text = await response.text().catch(() => "");
    throw new BrowserSessionUnavailableError(
      response.status,
      `browser pages unavailable (${response.status}): ${text}`,
    );
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
    const text = await response.text().catch(() => "");
    throw new BrowserSessionUnavailableError(
      response.status,
      `browser actions unavailable (${response.status}): ${text}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`browser actions failed (${response.status}): ${text}`);
  }

  const payload = (await response.json()) as unknown;
  return mapRuntimeBrowserSessionActionsPayload(payload);
}
