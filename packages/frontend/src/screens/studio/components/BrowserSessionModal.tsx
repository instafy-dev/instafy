import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Collapse, Expand, Safari, Xmark } from "iconoir-react";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { Button, IconButton } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import { Text } from "../../../components/Text";
import {
  controllerClient,
  type RuntimeBrowserSessionCapabilities,
} from "../../../sdk/instafy";
import { beginBrowserRuntimeClaim } from "../../../runtime/browserRuntimeClaimRegistry";
import {
  hostedRuntimeLimitDetailsFromError,
  parseHostedRuntimeLimitError,
  type HostedRuntimeLimitErrorDetails,
} from "../../../runtime/hostedRuntimeLimitError";
import {
  getWebdevRuntimeEnv,
  WEBDEV_RUNTIME_FLAVOR,
} from "../../../runtime/utils/webdevRuntime";
import { runtimeDebugLog } from "../../../runtime/utils/runtimeDebug";
import { generateUUID } from "../../../utils/uuid";
import { useBrowserSessionActions } from "./useBrowserSessionActions";
import { BrowserCursorOverlay } from "./BrowserCursorOverlay";
import { ActionTicker } from "./ActionTicker";
import { SharedBrowserCollaborationControls } from "./SharedBrowserCollaborationControls";
import { SharedBrowserParticipantPointers } from "./SharedBrowserParticipantPointers";
import { collaborationSelfOwnsControl } from "./sharedBrowserCollaboration";
import { useSharedBrowserCollaboration } from "./useSharedBrowserCollaboration";
import { BrowserIdentityBadge } from "./BrowserIdentityBadge";
import {
  shouldForceDockedBrowserFullscreen,
  shouldRenderBrowserSessionFullscreen,
} from "./browserSessionLayout";
import { browserSessionWsDebugFields } from "./browserSessionDebug";
import {
  coalesceBrowserRuntimeEnsure,
  resolveBrowserRuntimeCandidate,
  resolveAutoRecyclableBrowserRuntimeIdentity,
  waitForBrowserRuntimeOrigin,
} from "./browserSessionRuntimeEnsure";
import {
  SharedBrowserChrome,
  type SharedBrowserChromeProps,
} from "./SharedBrowserChrome";
import { BrowserStatusPill, type BrowserChromeState } from "./BrowserChromeShell";
import {
  CdpScreencastViewer,
  type CdpScreencastDisconnect,
} from "./CdpScreencastViewer";
import {
  WebRtcBrowserViewer,
  type WebRtcBrowserDisconnect,
} from "./WebRtcBrowserViewer";
import { RemoteBrowserMobileKeyboard } from "./RemoteBrowserMobileKeyboard";
import { SharedBrowserApprovalPrompt } from "./SharedBrowserApprovalPrompt";
import { useSharedBrowserApproval } from "./useSharedBrowserApproval";
import {
  dispatchRemoteBrowserVirtualInput,
  type RemoteBrowserVirtualInputMessage,
} from "./remoteBrowserInput";
import { normalizedRemoteBrowserPoint } from "./remoteBrowserSurfaceGeometry";
import {
  resolveSharedBrowserFallbackViewerKind,
  resolveSharedBrowserViewerForParticipant,
  sharedBrowserGrantRefreshDelayMs,
  webRtcInputTargetsActivePage,
  type SupportedSharedBrowserViewerKind,
} from "./sharedBrowserViewer";
import {
  applyAdaptiveBrowserRfbEncoding,
  DEFAULT_BROWSER_RFB_MAX_FRAMEBUFFER_PIXELS,
  installBrowserRfbScaledResize,
  resolveBrowserRfbFramebufferSize,
  selectBrowserRfbRenderScale,
} from "./browserSessionRfbQuality";
import {
  applySharedBrowserRfbHumanInput,
  HUMAN_SHARED_BROWSER_CONTROL_OWNER,
  sharedBrowserHumanInputEnabled,
  type SharedBrowserControlOwner,
} from "./sharedBrowserControlOwner";

type BrowserSessionStatus = "idle" | "connecting" | "connected" | "error";
type BrowserSessionPresentation = "modal" | "docked";
type BrowserViewportMode = "fit" | "native";
type DockedBrowserLayoutMetrics = {
  height: number;
  maxWidth: number;
  compact: boolean;
};
type BrowserSessionRfbLike = {
  addEventListener?: (type: "connect" | "disconnect", listener: () => void) => void;
  clipViewport?: boolean;
  disconnect?: () => void;
  dragViewport?: boolean;
  compressionLevel?: number;
  qualityLevel?: number;
  resizeSession?: boolean;
  scaleViewport?: boolean;
  viewOnly?: boolean;
  showDotCursor?: boolean;
};
type BrowserSessionRfbConstructor = new (
  container: HTMLDivElement,
  url: string,
  options: Record<string, never>,
) => BrowserSessionRfbLike;
type BrowserSessionRfbModule = {
  default?: BrowserSessionRfbConstructor;
  RFB?: BrowserSessionRfbConstructor;
};
const BROWSER_RUNTIME_DISPLAY_NAME = "Browser session";
const controllerBaseUrl = controllerClient.core.baseUrl;
const CDP_SCREENCAST_REQUESTED =
  (import.meta.env.VITE_INSTAFY_SHARED_BROWSER_CDP_SCREENCAST ?? "").trim() === "1";
const WEBRTC_REQUESTED =
  (import.meta.env.VITE_INSTAFY_SHARED_BROWSER_WEBRTC ?? "").trim() === "1";
const MAX_AUTO_CONNECT_RETRIES = 5;
const AUTO_CONNECT_RETRY_BASE_DELAY_MS = 1000;
const DOCKED_BROWSER_ASPECT_RATIO = 1280 / 720;
const connectedBrowserSessionScopes = new Set<string>();
const BROWSER_SESSION_SAFE_ZONE_SELECTOR = "[data-browser-session-safe-zone='true']";
const EMPTY_WEBRTC_ICE_SERVERS: RTCIceServer[] = [];
const DEFAULT_SHARED_BROWSER_VIEWER_KINDS: SupportedSharedBrowserViewerKind[] = ["rfb"];

type WebRtcBrowserConnection = {
  offerUrl: string;
  inputWsUrl: string | null;
  accessToken: string;
  pageId: string | null;
};

type BrowserOriginConnection = {
  projectId: string;
  runtimeId: string;
  originId: string;
  endpoint: string;
  accessToken: string;
  expiresAtMs: number | null;
};

const BROWSER_ORIGIN_TOKEN_REFRESH_RETRY_MS = 5_000;

function eventTargetWithinBrowserSessionSafeZone(target: Node | null): boolean {
  if (!target) {
    return false;
  }
  const element = target instanceof Element ? target : target.parentElement;
  if (!element) {
    return false;
  }
  return Boolean(element.closest(BROWSER_SESSION_SAFE_ZONE_SELECTOR));
}

function collectBrowserViewerDebugMetrics(container: HTMLDivElement | null) {
  if (!container) {
    return {
      container: null,
      canvases: [],
    };
  }
  const containerRect = container.getBoundingClientRect();
  const canvases = Array.from(container.querySelectorAll("canvas")).map((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return {
      width: canvas.width,
      height: canvas.height,
      rect: {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  });
  return {
    container: {
      width: Math.round(containerRect.width),
      height: Math.round(containerRect.height),
      childElementCount: container.childElementCount,
      scrollWidth: container.scrollWidth,
      scrollHeight: container.scrollHeight,
    },
    canvases,
  };
}

function isSmallBrowserViewport(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia("(max-width: 640px)").matches;
}

function resolveDockedBrowserLayoutMetrics(viewportHeight: number): DockedBrowserLayoutMetrics {
  const safeHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 900;
  const height = Math.min(Math.max(Math.round(safeHeight * 0.42), 220), 520);
  const maxWidth = Math.min(Math.max(Math.round(safeHeight * 1.2), 720), 1200);
  return {
    height,
    maxWidth,
    compact: safeHeight < 860,
  };
}

function resolveBrowserViewportMode(params: {
  fullscreen: boolean;
  smallViewport: boolean;
}): BrowserViewportMode {
  if (params.smallViewport && params.fullscreen) {
    return "native";
  }
  return "fit";
}

function resolveBrowserSessionRfbConstructor(mod: unknown): BrowserSessionRfbConstructor {
  if (typeof mod === "function") {
    return mod as BrowserSessionRfbConstructor;
  }
  if (typeof mod === "object" && mod !== null) {
    const module = mod as BrowserSessionRfbModule;
    if (typeof module.default === "function") {
      return module.default;
    }
    if (typeof module.RFB === "function") {
      return module.RFB;
    }
  }
  throw new Error("Unable to load the browser viewer runtime.");
}

function applyBrowserViewportMode(
  rfb: BrowserSessionRfbLike | null,
  mode: BrowserViewportMode,
  resizeSession = false,
): void {
  if (!rfb) {
    return;
  }
  if (mode === "native") {
    // Legacy sessions stay at native size for panning. Viewport-only sessions
    // instead negotiate the actual panel size with TigerVNC so the webpage is
    // responsive on narrow surfaces instead of behaving like a desktop crop.
    rfb.resizeSession = resizeSession;
    rfb.scaleViewport = false;
    rfb.clipViewport = false;
    rfb.dragViewport = false;
    return;
  }
  // Fit mode keeps the entire session visible in the panel.
  rfb.scaleViewport = true;
  rfb.clipViewport = false;
  rfb.dragViewport = false;
  rfb.resizeSession = resizeSession;
}

function BrowserSessionStatusPill({
  status,
  compact = false,
}: {
  status: BrowserSessionStatus;
  compact?: boolean;
}) {
  const state: BrowserChromeState =
    status === "connected" ? "ready" : status === "error" ? "unavailable" : "starting";
  const detail =
    status === "connected"
      ? "Shared Browser is connected and ready."
      : status === "error"
        ? "Shared Browser is unavailable."
        : status === "connecting"
          ? "Connecting to Shared Browser…"
          : "Preparing Shared Browser…";
  return (
    <BrowserStatusPill
      compact={compact}
      detail={detail}
      state={state}
      testId="browser-session-status"
    />
  );
}

function SharedBrowserControlOwnerPill({
  controlOwner,
}: {
  controlOwner: Extract<SharedBrowserControlOwner, { kind: "agent" }>;
}) {
  const label = `${controlOwner.displayName} has control`;
  return (
    <span
      aria-live="polite"
      className="inline-flex h-7 max-w-40 shrink-0 items-center rounded-full border border-violet-500/30 bg-violet-500/10 px-2 text-xxs font-medium text-violet-700 dark:text-violet-300"
      data-testid="shared-browser-control-owner"
      role="status"
      title={label}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}

function shouldProxyVncThroughController(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized === "rt.instafy.dev" ||
    normalized.endsWith(".rt.instafy.dev") ||
    normalized === "rt.test" ||
    normalized.endsWith(".rt.test") ||
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "host.docker.internal"
  );
}

function buildBrowserWebSocketUrl(params: {
  endpoint: string;
  token: string;
  browserPath: "vnc" | "screencast" | "input" | "collaboration";
  originId?: string | null;
  pageId?: string | null;
}): string {
  const url = new URL(params.endpoint);
  const originId = params.originId?.trim() ?? "";
  if (originId && controllerBaseUrl && shouldProxyVncThroughController(url.hostname)) {
    const controllerUrl = new URL(controllerBaseUrl);
    controllerUrl.protocol = controllerUrl.protocol === "https:" ? "wss:" : "ws:";
    controllerUrl.pathname = `/origin/${encodeURIComponent(originId)}/browser/${params.browserPath}`;
    controllerUrl.search = "";
    controllerUrl.searchParams.set("token", params.token);
    if (params.pageId?.trim()) {
      controllerUrl.searchParams.set("pageId", params.pageId.trim());
    }
    return controllerUrl.toString();
  }

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // Preserve any origin proxy prefix (e.g. controller endpoints like /origin/<id>).
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/browser/${params.browserPath}`;
  url.search = "";
  url.searchParams.set("token", params.token);
  if (params.pageId?.trim()) {
    url.searchParams.set("pageId", params.pageId.trim());
  }
  return url.toString();
}

function buildVncWebSocketUrl(params: {
  endpoint: string;
  token: string;
  originId?: string | null;
}): string {
  return buildBrowserWebSocketUrl({ ...params, browserPath: "vnc" });
}

function buildBrowserHttpUrl(params: {
  endpoint: string;
  browserPath: "webrtc/offer";
  originId?: string | null;
}): string {
  const url = new URL(params.endpoint);
  const originId = params.originId?.trim() ?? "";
  if (originId && controllerBaseUrl && shouldProxyVncThroughController(url.hostname)) {
    const controllerUrl = new URL(controllerBaseUrl);
    controllerUrl.pathname = `/origin/${encodeURIComponent(originId)}/browser/${params.browserPath}`;
    controllerUrl.search = "";
    return controllerUrl.toString();
  }

  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/browser/${params.browserPath}`;
  url.search = "";
  return url.toString();
}

export function BrowserSessionModal({
  isOpen,
  onOpenChange,
  projectId,
  browserSessionId: suppliedBrowserSessionId,
  preferRuntimeId,
  onRuntimeIdResolved,
  presentation = "modal",
  hideCollapsedConnectedCard = false,
  expandRequestToken = 0,
  fillContainer = false,
  toolbarLeading,
  transportActive = true,
  canControlBrowser = false,
  controlOwner = HUMAN_SHARED_BROWSER_CONTROL_OWNER,
  onBackToChat,
  onApprovalPendingChange,
  sharedBrowserChrome = null,
  sharedBrowserViewerKind = "rfb",
  sharedBrowserCapabilitiesResolved = true,
  sharedBrowserCapabilitiesAvailable = true,
  sharedBrowserAvailableViewerKinds = DEFAULT_SHARED_BROWSER_VIEWER_KINDS,
  sharedBrowserRfbCapabilities = null,
  sharedBrowserWebRtcCapabilities = null,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  browserSessionId?: string | null;
  preferRuntimeId: string | null;
  onRuntimeIdResolved?: ((runtimeId: string) => void) | null;
  presentation?: BrowserSessionPresentation;
  hideCollapsedConnectedCard?: boolean;
  expandRequestToken?: number;
  fillContainer?: boolean;
  toolbarLeading?: ReactNode;
  transportActive?: boolean;
  canControlBrowser?: boolean;
  controlOwner?: SharedBrowserControlOwner;
  onBackToChat?: (() => void) | null;
  onApprovalPendingChange?: ((pending: boolean) => void) | null;
  sharedBrowserChrome?: SharedBrowserChromeProps | null;
  sharedBrowserViewerKind?: SupportedSharedBrowserViewerKind | null;
  sharedBrowserCapabilitiesResolved?: boolean;
  sharedBrowserCapabilitiesAvailable?: boolean;
  sharedBrowserAvailableViewerKinds?: SupportedSharedBrowserViewerKind[];
  sharedBrowserRfbCapabilities?: RuntimeBrowserSessionCapabilities["rfb"] | null;
  sharedBrowserWebRtcCapabilities?: RuntimeBrowserSessionCapabilities["webrtc"] | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerNode, setContainerNode] = useState<HTMLDivElement | null>(null);
  const dockedRootRef = useRef<HTMLElement | null>(null);
  const rfbRef = useRef<BrowserSessionRfbLike | null>(null);
  const generatedBrowserSessionId = useMemo(() => generateUUID(), []);
  const browserSessionId = suppliedBrowserSessionId?.trim() || generatedBrowserSessionId;
  const [collaborationWsUrl, setCollaborationWsUrl] = useState<string | null>(null);
  const [collaborationConnectionKey, setCollaborationConnectionKey] =
    useState<string | null>(null);
  const sharedBrowserViewportOnly = sharedBrowserChrome !== null;
  const sharedBrowserPageId =
    sharedBrowserChrome?.pages.find((page) => page.isActive)?.id ??
    sharedBrowserChrome?.pages[0]?.id ??
    null;
  const collaboration = useSharedBrowserCollaboration({
    active: isOpen && transportActive && Boolean(sharedBrowserPageId),
    pageId: sharedBrowserPageId,
    sessionId: browserSessionId,
    wsUrl: collaborationWsUrl,
    connectionKey: collaborationConnectionKey,
  });
  const publishCollaborationCursor = collaboration.publishCursor;
  const serverAgentOwner =
    collaboration.client.state?.controlOwner?.kind === "agent"
      ? collaboration.client.state.controlOwner
      : null;
  const effectiveAgentControlOwner: Extract<SharedBrowserControlOwner, { kind: "agent" }> | null =
    serverAgentOwner
      ? { kind: "agent", displayName: serverAgentOwner.displayName }
      : controlOwner.kind === "agent"
        ? controlOwner
        : null;
  const humanInputEnabled =
    canControlBrowser &&
    collaborationSelfOwnsControl(collaboration.client) &&
    sharedBrowserHumanInputEnabled({ controlOwner, transportActive });
  const inputAuthorityKey = effectiveAgentControlOwner
    ? `agent:${effectiveAgentControlOwner.displayName}`
    : collaboration.client.state?.controlOwner?.kind === "human"
      ? `human:${collaboration.client.state.controlOwner.participantId}`
      : collaboration.client.state
        ? "none"
        : null;
  const requestedRfbRenderScaleRef = useRef<1 | 2>(
    selectBrowserRfbRenderScale({
      devicePixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio,
      viewportWidth: typeof window === "undefined" ? 1280 : window.innerWidth,
      viewportHeight: typeof window === "undefined" ? 720 : window.innerHeight,
      maxFramebufferPixels: DEFAULT_BROWSER_RFB_MAX_FRAMEBUFFER_PIXELS,
    }),
  );
  const rfbRenderScale =
    sharedBrowserRfbCapabilities?.renderScale ?? requestedRfbRenderScaleRef.current;
  const rfbMaxFramebufferPixels =
    sharedBrowserRfbCapabilities?.maxFramebufferPixels ??
    DEFAULT_BROWSER_RFB_MAX_FRAMEBUFFER_PIXELS;
  const sharedBrowserViewportOnlyRef = useRef(sharedBrowserViewportOnly);
  sharedBrowserViewportOnlyRef.current = sharedBrowserViewportOnly;
  const reconnectTimerRef = useRef<number | null>(null);
  const autoRetryCountRef = useRef(0);
  const [status, setStatus] = useState<BrowserSessionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [runtimeLimitDetails, setRuntimeLimitDetails] =
    useState<HostedRuntimeLimitErrorDetails | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [browserInputWsUrl, setBrowserInputWsUrl] = useState<string | null>(null);
  const [webRtcConnection, setWebRtcConnection] =
    useState<WebRtcBrowserConnection | null>(null);
  const [browserOriginConnection, setBrowserOriginConnection] =
    useState<BrowserOriginConnection | null>(null);
  const browserOriginConnectionRef = useRef<BrowserOriginConnection | null>(null);
  const webRtcConnectionRef = useRef<WebRtcBrowserConnection | null>(null);
  const webRtcProjectIdRef = useRef<string | null>(null);
  const preferRuntimeIdRef = useRef(preferRuntimeId);
  const humanInputEnabledRef = useRef(humanInputEnabled);
  preferRuntimeIdRef.current = preferRuntimeId;
  humanInputEnabledRef.current = humanInputEnabled;
  webRtcConnectionRef.current = webRtcConnection;
  browserOriginConnectionRef.current = browserOriginConnection;
  const sharedBrowserApproval = useSharedBrowserApproval({
    // The signed origin marker/request remains authoritative even if the user
    // switches conversations or hides the Shared transport. The endpoint is
    // initiator-scoped, so a writable mounted surface can safely keep polling.
    active: isOpen && canControlBrowser,
    projectId: browserOriginConnection?.projectId ?? projectId,
    browserSessionId,
    runtimeId: browserOriginConnection?.runtimeId ?? null,
    browserPageId: sharedBrowserPageId,
    originEndpoint: browserOriginConnection?.endpoint ?? null,
    originAccessToken: browserOriginConnection?.accessToken ?? null,
  });
  useEffect(() => {
    onApprovalPendingChange?.(Boolean(sharedBrowserApproval.pending));
  }, [onApprovalPendingChange, sharedBrowserApproval.pending]);
  useEffect(
    () => () => {
      onApprovalPendingChange?.(false);
    },
    [onApprovalPendingChange],
  );
  const [viewerOverride, setViewerOverride] =
    useState<SupportedSharedBrowserViewerKind | null>(null);
  const [connectAttempt, setConnectAttempt] = useState(0);
  const [hasConnectedOnce, setHasConnectedOnce] = useState(false);
  const [frozenFrameUrl, setFrozenFrameUrl] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [smallViewport, setSmallViewport] = useState<boolean>(() =>
    isSmallBrowserViewport(),
  );
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const [viewportHeight, setViewportHeight] = useState<number>(() =>
    typeof window === "undefined" ? 900 : window.innerHeight,
  );
  const [desktopDockedCard, setDesktopDockedCard] = useState(false);
  const viewportMode = useMemo<BrowserViewportMode>(
    () => resolveBrowserViewportMode({ fullscreen, smallViewport }),
    [fullscreen, smallViewport],
  );
  const dockedLayout = useMemo(
    () => resolveDockedBrowserLayoutMetrics(viewportHeight),
    [viewportHeight],
  );
  const [runtimeLimitActionBusy, setRuntimeLimitActionBusy] = useState(false);
  const [forcedRuntimeId, setForcedRuntimeId] = useState<string | null>(null);
  const permittedSharedBrowserViewerKinds = useMemo(
    () =>
      humanInputEnabled
        ? sharedBrowserAvailableViewerKinds
        : sharedBrowserAvailableViewerKinds.filter((kind) => kind !== "rfb"),
    [humanInputEnabled, sharedBrowserAvailableViewerKinds],
  );
  const requestedSharedBrowserViewerKind = viewerOverride ?? sharedBrowserViewerKind;
  const activeSharedBrowserViewerKind = resolveSharedBrowserViewerForParticipant({
    requested: requestedSharedBrowserViewerKind,
    available: sharedBrowserAvailableViewerKinds,
    humanOwnsControl: humanInputEnabled,
  });
  const sharedBrowserConnectionPageId =
    activeSharedBrowserViewerKind === "rfb" ? null : sharedBrowserPageId;
  const webRtcIceServers =
    sharedBrowserWebRtcCapabilities?.iceServers ?? EMPTY_WEBRTC_ICE_SERVERS;
  const webRtcRelayOnly = sharedBrowserWebRtcCapabilities?.relayOnly ?? false;
  const limitDetails = useMemo(
    () => parseHostedRuntimeLimitError(error, runtimeLimitDetails),
    [error, runtimeLimitDetails],
  );
  const limitReached = limitDetails.limitReached;
  const blockerRuntimeLabel =
    limitDetails.blockerRuntimeLabel ?? "Active runtime";
  const blockerProjectLabel = limitDetails.blockerProjectLabel?.trim() || null;
  const blockerProjectCopy = blockerProjectLabel
    ? `“${blockerRuntimeLabel}” is running in “${blockerProjectLabel}”.`
    : limitDetails.blockerProjectId
      ? `“${blockerRuntimeLabel}” is running in another space.`
      : null;
  const runtimeSlotSummary =
    typeof limitDetails.activeCount === "number" &&
    typeof limitDetails.maxActiveCount === "number"
      ? limitDetails.maxActiveCount === 1
        ? "The team's Instafy Cloud runtime is already in use."
        : `All ${limitDetails.maxActiveCount} Instafy Cloud runtimes for this team are in use.`
      : "All Instafy Cloud runtime slots are in use.";
  const hasTakeoverBlocker = Boolean(limitDetails.blockerRuntimeId);
  const setContainerElement = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    setContainerNode((current) => (current === node ? current : node));
  }, []);
  const dispatchMobileBrowserInput = useCallback(
    (message: RemoteBrowserVirtualInputMessage) => {
      const surface = containerRef.current?.querySelector<HTMLElement>(
        '[data-active="true"][data-input-enabled="true"]',
      );
      if (surface) {
        dispatchRemoteBrowserVirtualInput(surface, message);
      }
    },
    [],
  );

  const modalClassName = useMemo(
    () =>
      [
        "max-w-[calc(100vw-2rem)]",
        "h-[calc(100vh-2rem)]",
        "lg:max-w-[min(96vw,78rem)]",
        "lg:h-[min(92vh,54rem)]",
        "overflow-hidden",
      ].join(" "),
    [],
  );
  const fullscreenOverlayClassName = useMemo(
    () => "!items-stretch !justify-stretch !bg-transparent !p-0 !backdrop-blur-none",
    [],
  );
  const fullscreenModalClassName = useMemo(
    () =>
      "!h-screen !w-screen !max-w-none !rounded-none !border-0 !bg-transparent !shadow-none !overflow-hidden",
    [],
  );
  const fullscreenDialogClassName = useMemo(
    () => "!m-0 !h-full !w-full !border-0 !p-0 !outline-none",
    [],
  );
  const forceViewportFullscreenDocked = shouldForceDockedBrowserFullscreen({
    fillContainer,
    presentation,
    isOpen,
    smallViewport,
    viewportHeight,
  });
  const renderFullscreen = shouldRenderBrowserSessionFullscreen({
    forceViewportFullscreen: forceViewportFullscreenDocked,
    fullscreen,
    transportActive,
  });
  const isInlineDocked = presentation === "docked" && !renderFullscreen;
  const shouldViewportCollapseDocked =
    isInlineDocked && !fillContainer && (viewportHeight < 760 || smallViewport);
  const shouldUseDesktopDockedCard =
    isInlineDocked && !shouldViewportCollapseDocked && desktopDockedCard;
  const connectedScopeKey = projectId?.trim() || null;
  const hasConnectedHint =
    hasConnectedOnce ||
    (connectedScopeKey ? connectedBrowserSessionScopes.has(connectedScopeKey) : false);
  const displayStatus = !error && status === "connecting" && hasConnectedHint ? "connected" : status;
  const shouldCollapseDocked =
    shouldUseDesktopDockedCard || (shouldViewportCollapseDocked && displayStatus !== "connected");
  // Tail the agent's browser actions while the live view is shown, so we can draw
  // the AI cursor and caption what it's doing. Gated to match where the overlay
  // renders (connected and not collapsed) so a hidden/collapsed session doesn't
  // keep polling. Uses the same runtime the VNC stream resolved to.
  const { actions: browserActions, latestClick: browserLatestClick } = useBrowserSessionActions({
    enabled: isOpen && displayStatus === "connected" && !shouldCollapseDocked,
    browserSessionId,
    projectId,
    preferRuntimeId: forcedRuntimeId ?? preferRuntimeId,
  });
  const collapsedCardMode = shouldCollapseDocked
    ? error
      ? limitReached
        ? "limit"
        : "error"
      : displayStatus === "connected"
        ? "connected"
      : "connecting"
    : null;
  const renderCollapsedConnectedIntoShelf =
    shouldUseDesktopDockedCard &&
    collapsedCardMode === "connected" &&
    hideCollapsedConnectedCard;
  const dockedStageHeight =
    shouldCollapseDocked
      ? collapsedCardMode === "connected"
        ? smallViewport
          ? 80
          : 86
        : collapsedCardMode === "connecting"
          ? smallViewport
            ? 92
            : 96
          : smallViewport
            ? 148
            : 156
      : dockedLayout.height;
  const dockedStageIdealWidth = shouldCollapseDocked
    ? null
    : Math.round(dockedStageHeight * DOCKED_BROWSER_ASPECT_RATIO);
  const dockedStageMaxWidth = shouldCollapseDocked
    ? Math.min(
        dockedLayout.maxWidth,
        Math.max(260, viewportWidth - (smallViewport ? 32 : 64)),
        collapsedCardMode === "connected"
          ? smallViewport
            ? 320
            : 420
          : collapsedCardMode === "connecting"
            ? smallViewport
              ? 340
              : 460
            : smallViewport
              ? 360
              : 560,
      )
    : Math.min(dockedLayout.maxWidth, dockedStageIdealWidth ?? dockedLayout.maxWidth);
  const expandDockedViewer = useCallback(() => {
    setDesktopDockedCard(false);
  }, []);
  const minimizeBrowserSessionToShelf = useCallback(() => {
    if (typeof window === "undefined") {
      onOpenChange(false);
      return;
    }
    window.requestAnimationFrame(() => {
      onOpenChange(false);
    });
  }, [onOpenChange]);
  const toggleFullscreen = useCallback(() => {
    if (forceViewportFullscreenDocked) {
      return;
    }
    setFullscreen((value) => !value);
  }, [forceViewportFullscreenDocked]);
  const freezeCurrentBrowserFrame = useCallback(() => {
    const surface = containerRef.current?.querySelector<
      HTMLCanvasElement | HTMLVideoElement
    >("canvas, video");
    if (!surface) {
      return;
    }
    const sourceWidth =
      surface instanceof HTMLCanvasElement ? surface.width : surface.videoWidth;
    const sourceHeight =
      surface instanceof HTMLCanvasElement ? surface.height : surface.videoHeight;
    if (!sourceWidth || !sourceHeight) {
      return;
    }
    const width = Math.min(sourceWidth, 1280);
    const height = Math.max(1, Math.round((width / sourceWidth) * sourceHeight));
    const snapshot = document.createElement("canvas");
    snapshot.width = width;
    snapshot.height = height;
    const context = snapshot.getContext("2d", { alpha: false });
    if (!context) {
      return;
    }
    try {
      context.drawImage(surface, 0, 0, width, height);
      setFrozenFrameUrl(snapshot.toDataURL("image/jpeg", 0.78));
    } catch {
      // A frozen frame is a visual optimization; transport fallback still works
      // when a platform refuses to snapshot its current video surface.
    }
  }, []);

  const retryConnection = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    autoRetryCountRef.current = 0;
    setRuntimeLimitActionBusy(false);
    setStatus("connecting");
    setError(null);
    setRuntimeLimitDetails(null);
    setHasConnectedOnce(false);
    if (connectedScopeKey) {
      connectedBrowserSessionScopes.delete(connectedScopeKey);
    }
    setWsUrl(null);
    setBrowserInputWsUrl(null);
    setWebRtcConnection(null);
    setViewerOverride(null);
    setConnectAttempt((value) => value + 1);
    runtimeDebugLog("browser-session:retry", {
      projectId,
      preferRuntimeId,
      forcedRuntimeId,
    });
  }, [connectedScopeKey, forcedRuntimeId, preferRuntimeId, projectId]);
  const scheduleReconnectAttempt = useCallback(
    (reason: "disconnect" | "connect_failure", debugWsUrl: string): boolean => {
      if (autoRetryCountRef.current < MAX_AUTO_CONNECT_RETRIES) {
        freezeCurrentBrowserFrame();
        autoRetryCountRef.current += 1;
        const retryCount = autoRetryCountRef.current;
        const delayMs = Math.min(AUTO_CONNECT_RETRY_BASE_DELAY_MS * retryCount, 5000);
        setStatus("connecting");
        setError(null);
        if (reconnectTimerRef.current !== null) {
          window.clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          setConnectAttempt((value) => value + 1);
        }, delayMs);
        runtimeDebugLog("browser-session:retry-scheduled", {
          ...browserSessionWsDebugFields(debugWsUrl),
          reason,
          retryCount,
          delayMs,
          forcedRuntimeId,
          viewer: activeSharedBrowserViewerKind,
        });
        return true;
      }
      if (!forcedRuntimeId) {
        autoRetryCountRef.current = 0;
        setStatus("connecting");
        setError(null);
        setWsUrl(null);
        setBrowserInputWsUrl(null);
        setWebRtcConnection(null);
        setForcedRuntimeId(generateUUID());
        setConnectAttempt((value) => value + 1);
        runtimeDebugLog("browser-session:fresh-runtime-retry", {
          ...browserSessionWsDebugFields(debugWsUrl),
          reason,
          forcedRuntimeId,
          viewer: activeSharedBrowserViewerKind,
        });
        return true;
      }
      return false;
    },
    [activeSharedBrowserViewerKind, forcedRuntimeId, freezeCurrentBrowserFrame],
  );
  const fallBackFromViewer = useCallback(
    (reason: string): boolean => {
      if (!activeSharedBrowserViewerKind) {
        return false;
      }
      const nextViewer = resolveSharedBrowserFallbackViewerKind(
        activeSharedBrowserViewerKind,
        permittedSharedBrowserViewerKinds,
      );
      if (!nextViewer) {
        return false;
      }
      freezeCurrentBrowserFrame();
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      autoRetryCountRef.current = 0;
      setStatus("connecting");
      setError(null);
      setWsUrl(null);
      setBrowserInputWsUrl(null);
      setWebRtcConnection(null);
      webRtcConnectionRef.current = null;
      webRtcProjectIdRef.current = null;
      setViewerOverride(nextViewer);
      runtimeDebugLog("browser-session:transport-fallback", {
        from: activeSharedBrowserViewerKind,
        to: nextViewer,
        reason,
        forcedRuntimeId,
      });
      return true;
    },
    [
      activeSharedBrowserViewerKind,
      forcedRuntimeId,
      freezeCurrentBrowserFrame,
      permittedSharedBrowserViewerKinds,
    ],
  );
  const closeBrowserSession = useCallback(() => {
    if (connectedScopeKey) {
      connectedBrowserSessionScopes.delete(connectedScopeKey);
    }
    onOpenChange(false);
  }, [connectedScopeKey, onOpenChange]);
  const returnToChat = useCallback(() => {
    setFullscreen(false);
    if (fillContainer && onBackToChat) {
      onBackToChat();
      return;
    }
    closeBrowserSession();
  }, [closeBrowserSession, fillContainer, onBackToChat]);
  const returnToChatLabel = fillContainer && onBackToChat
    ? "Back to chat"
    : "Hide browser session";

  const handleRuntimeLimitTakeover = useCallback(async () => {
    const blockerRuntimeId = limitDetails.blockerRuntimeId?.trim() ?? "";
    if (!blockerRuntimeId) {
      retryConnection();
      return;
    }
    setRuntimeLimitActionBusy(true);
    try {
      await controllerClient.runtimes.stop({
        runtimeId: blockerRuntimeId,
        reason: "browser_session_runtime_limit_takeover",
      });
      retryConnection();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setStatus("error");
      setError(
        message
          ? `Unable to stop the blocking runtime. ${message}`
          : "Unable to stop the blocking runtime.",
      );
      setRuntimeLimitDetails(null);
    } finally {
      setRuntimeLimitActionBusy(false);
    }
  }, [limitDetails.blockerRuntimeId, retryConnection]);

  useEffect(() => {
    if (!transportActive && fullscreen) {
      setFullscreen(false);
    }
  }, [fullscreen, transportActive]);

  useEffect(() => {
    setViewerOverride(null);
  }, [canControlBrowser, projectId, sharedBrowserViewerKind]);

  useEffect(() => {
    if (!isOpen || !projectId) {
      return;
    }
    return beginBrowserRuntimeClaim(projectId);
  }, [isOpen, projectId]);

  useEffect(() => {
    if (!isOpen) {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      autoRetryCountRef.current = 0;
      setStatus("idle");
      setError(null);
      setRuntimeLimitDetails(null);
      setHasConnectedOnce(false);
      setFrozenFrameUrl(null);
      setWsUrl(null);
      setBrowserInputWsUrl(null);
      setCollaborationWsUrl(null);
      setCollaborationConnectionKey(null);
      setBrowserOriginConnection(null);
      setWebRtcConnection(null);
      setViewerOverride(null);
      setRuntimeLimitActionBusy(false);
      setForcedRuntimeId(null);
      setDesktopDockedCard(false);
      setFullscreen(false);
      return;
    }

    if (!projectId) {
      setStatus("error");
      setError("Space is missing.");
      return;
    }
    let cancelled = false;
    const startupAbortController = new AbortController();
    const existingConnection = browserOriginConnectionRef.current;
    const preservingConnection =
      existingConnection?.projectId === projectId &&
      (!forcedRuntimeId || existingConnection.runtimeId === forcedRuntimeId);
    if (!preservingConnection) {
      setStatus("connecting");
      setError(null);
      setRuntimeLimitDetails(null);
      setWsUrl(null);
      setBrowserInputWsUrl(null);
      setCollaborationWsUrl(null);
      setCollaborationConnectionKey(null);
      setBrowserOriginConnection(null);
      setWebRtcConnection(null);
      webRtcConnectionRef.current = null;
      webRtcProjectIdRef.current = null;
    }

    void (async () => {
      // When launched from the UI (or a tool call) we may not have a runtime yet.
      // Ensure a hosted runtime so we can route the browser session to it.
      const requestedPreferRuntimeId = preferRuntimeIdRef.current;
      let runtimeId: string | null = null;
      let originId: string | null = null;
      let originEndpoint: string | null = null;
      const statusSnapshot = await controllerClient.runtimes.fetchStatus({
        projectId,
        signal: startupAbortController.signal,
        quietOnAbort: true,
      }).catch(() => null);
      if (cancelled) {
        return;
      }
      const statusEntries = Array.isArray(statusSnapshot?.runtimes) ? statusSnapshot.runtimes : [];
      if (!forcedRuntimeId) {
        const existingBrowserRuntime = resolveBrowserRuntimeCandidate(
          statusEntries,
          requestedPreferRuntimeId,
        );
        if (existingBrowserRuntime) {
          runtimeId = existingBrowserRuntime.runtimeId;
          originId = existingBrowserRuntime.originId;
          originEndpoint = existingBrowserRuntime.endpoint;
          runtimeDebugLog("browser-session:reuse-runtime", {
            projectId,
            runtimeId,
            originId,
            originEndpoint,
          });
        }
      }

      if (!runtimeId || !originId) {
        const webdevRuntimeEnv = getWebdevRuntimeEnv();
        const browserRect = containerRef.current?.getBoundingClientRect();
        const requestedRfbRenderScale = selectBrowserRfbRenderScale({
          devicePixelRatio: window.devicePixelRatio,
          viewportWidth:
            browserRect && browserRect.width >= 1 ? browserRect.width : window.innerWidth,
          viewportHeight:
            browserRect && browserRect.height >= 1 ? browserRect.height : window.innerHeight,
          maxFramebufferPixels: DEFAULT_BROWSER_RFB_MAX_FRAMEBUFFER_PIXELS,
        });
        requestedRfbRenderScaleRef.current = requestedRfbRenderScale;
        try {
          const pixelTransport = WEBRTC_REQUESTED
            ? "webrtc"
            : CDP_SCREENCAST_REQUESTED
              ? "cdp-screencast"
              : `rfb-${requestedRfbRenderScale}x`;
          const ensureBrowserRuntime = (
            requestedRuntimeId: string | null,
            reuseResolved: boolean,
          ) => {
            const ensureKey = `${projectId}:${requestedRuntimeId?.trim() || "automatic"}:${pixelTransport}`;
            return coalesceBrowserRuntimeEnsure(
              ensureKey,
              () =>
                controllerClient.runtimes.ensure({
                  projectId,
                  provider: "instafy-cloud",
                  displayName: BROWSER_RUNTIME_DISPLAY_NAME,
                  runtimeId: requestedRuntimeId ?? undefined,
                  idleTtlSeconds: 300,
                  metadata: {
                    runtimeFlavor: WEBDEV_RUNTIME_FLAVOR,
                    source: "browser-session",
                    // Ensure the runtime starts its local VNC server / X session when supported.
                    env: {
                      ...webdevRuntimeEnv,
                      INSTAFY_ENABLE_BROWSER_SESSION: "1",
                      INSTAFY_BROWSER_VIEWPORT_ONLY: "1",
                      INSTAFY_BROWSER_RENDER_SCALE: String(requestedRfbRenderScale),
                      INSTAFY_BROWSER_MAX_FRAMEBUFFER_PIXELS: String(
                        DEFAULT_BROWSER_RFB_MAX_FRAMEBUFFER_PIXELS,
                      ),
                      ...(CDP_SCREENCAST_REQUESTED || WEBRTC_REQUESTED
                        ? { INSTAFY_BROWSER_CDP_SCREENCAST: "1" }
                        : {}),
                      ...(WEBRTC_REQUESTED
                        ? {
                            INSTAFY_BROWSER_WEBRTC_ENABLED: "1",
                            INSTAFY_BROWSER_PREFERRED_VIEWER: "webrtc",
                          }
                        : {}),
                      INSTAFY_BROWSER_DISPLAY: ":1",
                      DISPLAY: ":1",
                    },
                  },
                  originMode: "hosted",
                  originProtocols: ["http"],
                }),
              { reuseResolved },
            );
          };

          let ensured: Awaited<ReturnType<typeof ensureBrowserRuntime>>;
          let ensuredRuntimeId = forcedRuntimeId;
          try {
            ensured = await ensureBrowserRuntime(
              ensuredRuntimeId,
              connectAttempt === 0,
            );
          } catch (initialError) {
            const initialLimitDetails = hostedRuntimeLimitDetailsFromError(initialError);
            let recyclableRuntime = initialLimitDetails
              ? resolveAutoRecyclableBrowserRuntimeIdentity({
                  activeProjectId: projectId,
                  blockerProjectId: initialLimitDetails.blockerProjectId,
                  blockerRuntimeId: initialLimitDetails.blockerRuntimeId,
                  blockerRuntimeLabel: initialLimitDetails.blockerRuntimeLabel,
                  projectStatusSnapshot: {
                    projectId,
                    runtimes: statusEntries,
                  },
                })
              : null;
            if (initialLimitDetails && !recyclableRuntime) {
              // The generic Studio ensure and the browser ensure can overlap on
              // a fresh project. Refresh once after the limit response so the
              // blocker identified by the controller is not missed merely
              // because it was absent from the pre-ensure snapshot.
              const refreshedStatus = await controllerClient.runtimes.fetchStatus({
                projectId,
                signal: startupAbortController.signal,
                quietOnAbort: true,
              }).catch(() => null);
              if (cancelled) {
                return;
              }
              recyclableRuntime = resolveAutoRecyclableBrowserRuntimeIdentity({
                activeProjectId: projectId,
                blockerProjectId: initialLimitDetails.blockerProjectId,
                blockerRuntimeId: initialLimitDetails.blockerRuntimeId,
                blockerRuntimeLabel: initialLimitDetails.blockerRuntimeLabel,
                projectStatusSnapshot: {
                  projectId,
                  runtimes: Array.isArray(refreshedStatus?.runtimes)
                    ? refreshedStatus.runtimes
                    : statusEntries,
                },
              });
            }
            if (!recyclableRuntime) {
              throw initialError;
            }
            const recyclableRuntimeId = recyclableRuntime.runtimeId;

            let stopOutcome;
            try {
              stopOutcome = await controllerClient.runtimes.stopIfIdle({
                runtimeId: recyclableRuntimeId,
                reason: "runtime_limit_takeover",
                expectedProjectId: recyclableRuntime.projectId,
                expectedProvider: recyclableRuntime.provider,
                expectedDisplayName: recyclableRuntime.displayName,
              });
            } catch (stopError) {
              runtimeDebugLog("browser-session:auto-recycle-stop-failed", {
                projectId,
                runtimeId: recyclableRuntimeId,
                error:
                  stopError instanceof Error ? stopError.message : String(stopError),
              });
              throw initialError;
            }
            if (cancelled) {
              return;
            }

            const runtimeSlotReleased =
              stopOutcome?.statusChanged === true ||
              stopOutcome?.skipReason === "already_stopped";
            runtimeDebugLog("browser-session:auto-recycle-runtime", {
              projectId,
              runtimeId: recyclableRuntimeId,
              statusChanged: stopOutcome?.statusChanged ?? false,
              skipReason: stopOutcome?.skipReason ?? null,
              runtimeSlotReleased,
            });
            if (!runtimeSlotReleased) {
              throw initialError;
            }

            ensuredRuntimeId = recyclableRuntimeId;
            ensured = await ensureBrowserRuntime(ensuredRuntimeId, false);
          }
          if (cancelled) {
            return;
          }
          runtimeId = ensured?.runtimeId ?? null;
          runtimeDebugLog("browser-session:ensure-runtime", {
            projectId,
            runtimeId,
            forcedRuntimeId,
            ensuredRuntimeId,
            preferRuntimeId: requestedPreferRuntimeId,
            requestedRfbRenderScale,
          });
        } catch (err) {
          if (cancelled) {
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          setStatus("error");
          setError(message || "Unable to start a runtime for the browser session.");
          setRuntimeLimitDetails(hostedRuntimeLimitDetailsFromError(err));
          return;
        }
      }

      if (!runtimeId) {
        setStatus("error");
        setError("Browser session is unavailable (runtime id missing).");
        return;
      }

      if (!originId) {
        const awaitedOrigin = await waitForBrowserRuntimeOrigin({
          projectId,
          runtimeId,
          fetchStatus: controllerClient.runtimes.fetchStatus,
          signal: startupAbortController.signal,
        });
        originId = awaitedOrigin.originId;
        originEndpoint = awaitedOrigin.endpoint;
        runtimeDebugLog("browser-session:wait-origin", {
          projectId,
          runtimeId,
          originId,
          originEndpoint,
        });
      }
      if (cancelled) {
        return;
      }
      if (!originId) {
        setStatus("error");
        setError("Browser session is unavailable (runtime origin not ready yet).");
        return;
      }

      onRuntimeIdResolved?.(runtimeId);

      // Runtime discovery is also what unlocks the versioned capability
      // request in the parent. Do not briefly connect the legacy RFB lane and
      // then tear it down when the final WebRTC/CDP choice arrives.
      if (!sharedBrowserCapabilitiesResolved || !sharedBrowserCapabilitiesAvailable) {
        runtimeDebugLog("browser-session:wait-capabilities", {
          projectId,
          runtimeId,
          resolved: sharedBrowserCapabilitiesResolved,
        });
        return;
      }

      const token = await controllerClient.workspace.origin.requestAccessToken({
        projectId,
        protocol: "http",
        scopes: canControlBrowser
          ? ["browser.view", "browser.control"]
          : ["browser.view"],
        originId: originId,
        preferRuntime: runtimeId,
        browserSessionId,
      });
      if (cancelled) {
        return;
      }
      if (!token) {
        setStatus("error");
        setError("Browser session is unavailable (origin token request failed).");
        return;
      }
      const endpoint = token.endpoint.trim() || originEndpoint;
      if (!endpoint) {
        setStatus("error");
        setError("Browser session is unavailable (origin endpoint missing).");
        return;
      }
      const connection: BrowserOriginConnection = {
        projectId,
        runtimeId,
        originId,
        endpoint,
        accessToken: token.token,
        expiresAtMs:
          token.expiresIn > 0 ? Date.now() + token.expiresIn * 1_000 : null,
      };
      setBrowserOriginConnection(connection);
      setCollaborationWsUrl(
        buildBrowserWebSocketUrl({
          endpoint,
          token: token.token,
          originId,
          browserPath: "collaboration",
        }),
      );
      setCollaborationConnectionKey(`${projectId}:${runtimeId}:${originId}`);
    })();

    return () => {
      cancelled = true;
      startupAbortController.abort();
    };
  }, [
    browserSessionId,
    canControlBrowser,
    connectAttempt,
    forcedRuntimeId,
    isOpen,
    onRuntimeIdResolved,
    projectId,
    sharedBrowserCapabilitiesAvailable,
    sharedBrowserCapabilitiesResolved,
  ]);

  useEffect(() => {
    const connection = browserOriginConnection;
    if (!isOpen || !connection || !activeSharedBrowserViewerKind) {
      setWsUrl(null);
      setBrowserInputWsUrl(null);
      setWebRtcConnection(null);
      webRtcConnectionRef.current = null;
      webRtcProjectIdRef.current = null;
      return;
    }

    setStatus("connecting");
    setError(null);
    const inputUrl =
      canControlBrowser && activeSharedBrowserViewerKind !== "rfb"
        ? buildBrowserWebSocketUrl({
            endpoint: connection.endpoint,
            token: connection.accessToken,
            originId: connection.originId,
            browserPath: "input",
            pageId: sharedBrowserConnectionPageId,
          })
        : null;
    const url =
      activeSharedBrowserViewerKind === "webrtc"
        ? inputUrl
        : activeSharedBrowserViewerKind === "cdp-screencast"
          ? buildBrowserWebSocketUrl({
              endpoint: connection.endpoint,
              token: connection.accessToken,
              originId: connection.originId,
              browserPath: "screencast",
              pageId: sharedBrowserConnectionPageId,
            })
          : buildVncWebSocketUrl({
              endpoint: connection.endpoint,
              token: connection.accessToken,
              originId: connection.originId,
            });

    runtimeDebugLog("browser-session:resolved-ws-url", {
      projectId: connection.projectId,
      runtimeId: connection.runtimeId,
      originId: connection.originId,
      endpoint: connection.endpoint,
      viewer: activeSharedBrowserViewerKind,
      wsUrlHost: (() => {
        try {
          return url ? new URL(url).host : "none";
        } catch {
          return "invalid";
        }
      })(),
      wsUrlPath: (() => {
        try {
          return url ? new URL(url).pathname : "none";
        } catch {
          return "invalid";
        }
      })(),
    });
    setWsUrl(url);
    setBrowserInputWsUrl(inputUrl);

    if (activeSharedBrowserViewerKind === "webrtc") {
      const webRtc: WebRtcBrowserConnection = {
        offerUrl: buildBrowserHttpUrl({
          endpoint: connection.endpoint,
          originId: connection.originId,
          browserPath: "webrtc/offer",
        }),
        inputWsUrl: inputUrl,
        accessToken: connection.accessToken,
        pageId: sharedBrowserConnectionPageId,
      };
      webRtcProjectIdRef.current = connection.projectId;
      webRtcConnectionRef.current = webRtc;
      setWebRtcConnection(webRtc);
    } else {
      webRtcProjectIdRef.current = null;
      webRtcConnectionRef.current = null;
      setWebRtcConnection(null);
    }
  }, [
    activeSharedBrowserViewerKind,
    browserOriginConnection,
    canControlBrowser,
    isOpen,
    sharedBrowserConnectionPageId,
  ]);

  useEffect(() => {
    const connection = browserOriginConnection;
    if (!isOpen || !connection?.expiresAtMs) {
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;
    const connectionKey = `${connection.projectId}:${connection.runtimeId}:${connection.originId}`;

    const refreshToken = async () => {
      const token = await controllerClient.workspace.origin.requestAccessToken({
        projectId: connection.projectId,
        protocol: "http",
        scopes: canControlBrowser
          ? ["browser.view", "browser.control"]
          : ["browser.view"],
        originId: connection.originId,
        preferRuntime: connection.runtimeId,
        browserSessionId,
        forceRefresh: true,
      });
      if (cancelled) {
        return;
      }
      if (!token) {
        timerId = window.setTimeout(refreshToken, BROWSER_ORIGIN_TOKEN_REFRESH_RETRY_MS);
        return;
      }
      const endpoint = token.endpoint.trim() || connection.endpoint;
      const nextConnection: BrowserOriginConnection = {
        ...connection,
        endpoint,
        accessToken: token.token,
        expiresAtMs:
          token.expiresIn > 0 ? Date.now() + token.expiresIn * 1_000 : null,
      };
      setBrowserOriginConnection((current) => {
        if (!current) {
          return current;
        }
        const currentKey = `${current.projectId}:${current.runtimeId}:${current.originId}`;
        return currentKey === connectionKey ? nextConnection : current;
      });
      // The collaboration hook keeps its live socket while this URL rotates,
      // then uses the fresh token if it has to reconnect.
      setCollaborationWsUrl(
        buildBrowserWebSocketUrl({
          endpoint,
          token: token.token,
          originId: connection.originId,
          browserPath: "collaboration",
        }),
      );
    };

    timerId = window.setTimeout(
      refreshToken,
      sharedBrowserGrantRefreshDelayMs(connection.expiresAtMs),
    );
    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [browserOriginConnection, browserSessionId, canControlBrowser, isOpen]);

  useEffect(() => {
    if (!isOpen || activeSharedBrowserViewerKind !== null) {
      return;
    }
    if (!sharedBrowserCapabilitiesResolved) {
      return;
    }
    if (sharedBrowserCapabilitiesAvailable && !collaboration.client.state) {
      setStatus("connecting");
      setError(null);
      return;
    }
    setStatus("error");
    setError(
      !sharedBrowserCapabilitiesAvailable
        ? "This Shared Browser viewer requires a newer version of Instafy."
        : canControlBrowser
          ? "This runtime's RFB renderer is available only to the current controller. Request control to view and interact with it."
          : "This Shared Browser runtime does not provide a safe view-only renderer.",
    );
  }, [
    activeSharedBrowserViewerKind,
    canControlBrowser,
    collaboration.client.state,
    isOpen,
    sharedBrowserCapabilitiesAvailable,
    sharedBrowserCapabilitiesResolved,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const media = window.matchMedia("(max-width: 640px)");
    const update = () => {
      setSmallViewport(media.matches);
      setViewportWidth(window.innerWidth);
      setViewportHeight(window.innerHeight);
    };
    update();
    media.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    if (!shouldViewportCollapseDocked && desktopDockedCard && smallViewport) {
      setDesktopDockedCard(false);
    }
  }, [desktopDockedCard, shouldViewportCollapseDocked, smallViewport]);

  useEffect(() => {
    if (
      fillContainer ||
      !isOpen ||
      presentation !== "docked" ||
      !smallViewport ||
      fullscreen
    ) {
      return;
    }
    setFullscreen(true);
  }, [fillContainer, fullscreen, isOpen, presentation, smallViewport]);

  useEffect(() => {
    if (!isOpen || expandRequestToken <= 0) {
      return;
    }
    setDesktopDockedCard(false);
    if (shouldViewportCollapseDocked) {
      setFullscreen(true);
    }
  }, [expandRequestToken, isOpen, shouldViewportCollapseDocked]);

  useEffect(() => {
    if (
      !isInlineDocked ||
      fillContainer ||
      !isOpen ||
      fullscreen ||
      smallViewport ||
      status !== "connected" ||
      shouldViewportCollapseDocked ||
      desktopDockedCard
    ) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (dockedRootRef.current?.contains(target)) {
        return;
      }
      if (eventTargetWithinBrowserSessionSafeZone(target)) {
        return;
      }
      minimizeBrowserSessionToShelf();
    };

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (dockedRootRef.current?.contains(target)) {
        return;
      }
      if (eventTargetWithinBrowserSessionSafeZone(target)) {
        return;
      }
      minimizeBrowserSessionToShelf();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn);
    };
  }, [
    desktopDockedCard,
    fillContainer,
    fullscreen,
    isInlineDocked,
    isOpen,
    minimizeBrowserSessionToShelf,
    shouldViewportCollapseDocked,
    smallViewport,
    status,
  ]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (activeSharedBrowserViewerKind !== "rfb") {
      return;
    }

    if (!humanInputEnabled) {
      return;
    }

    const container = containerNode;
    if (!container) {
      return;
    }

    if (!wsUrl) {
      return;
    }

    let cancelled = false;
    let rfb: BrowserSessionRfbLike | null = null;

    void (async () => {
      try {
        const mod = await import("@novnc/novnc/lib/rfb");
        if (cancelled) {
          return;
        }
        const RFB = resolveBrowserSessionRfbConstructor(mod);
        rfb = new RFB(container, wsUrl, {});
        rfbRef.current = rfb;
        applySharedBrowserRfbHumanInput(rfb, humanInputEnabledRef.current);
        const scaledResizeInstalled = installBrowserRfbScaledResize(rfb, {
          renderScale: rfbRenderScale,
          maxFramebufferPixels: rfbMaxFramebufferPixels,
        });
        if (!scaledResizeInstalled && rfbRenderScale > 1) {
          throw new Error("Unable to initialize the HiDPI Shared Browser viewer.");
        }
        applyBrowserViewportMode(rfb, viewportMode, sharedBrowserViewportOnlyRef.current);
        const initialRect = container.getBoundingClientRect();
        const initialFramebuffer = resolveBrowserRfbFramebufferSize({
          logicalWidth: initialRect.width,
          logicalHeight: initialRect.height,
          renderScale: rfbRenderScale,
          maxFramebufferPixels: rfbMaxFramebufferPixels,
        });
        applyAdaptiveBrowserRfbEncoding(rfb, {
          framebufferPixels: initialFramebuffer.pixels,
          maxFramebufferPixels: rfbMaxFramebufferPixels,
          renderScale: rfbRenderScale,
          viewportOnly: sharedBrowserViewportOnlyRef.current,
        });
        rfb.showDotCursor = true;
        runtimeDebugLog("browser-session:rfb-init", {
          ...browserSessionWsDebugFields(wsUrl),
          fullscreen,
          presentation,
          viewportMode,
          renderScale: rfbRenderScale,
          maxFramebufferPixels: rfbMaxFramebufferPixels,
          metrics: collectBrowserViewerDebugMetrics(container),
        });

        let connected = false;
        const handleConnect = () => {
          if (cancelled) {
            return;
          }
          connected = true;
          autoRetryCountRef.current = 0;
          if (reconnectTimerRef.current !== null) {
            window.clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          setError(null);
          setHasConnectedOnce(true);
          setFrozenFrameUrl(null);
          if (connectedScopeKey) {
            connectedBrowserSessionScopes.add(connectedScopeKey);
          }
          setStatus("connected");
          runtimeDebugLog("browser-session:rfb-connected", {
            ...browserSessionWsDebugFields(wsUrl),
            viewportMode,
            metrics: collectBrowserViewerDebugMetrics(containerRef.current),
          });
          window.setTimeout(() => {
            runtimeDebugLog("browser-session:rfb-connected-postpaint", {
              ...browserSessionWsDebugFields(wsUrl),
              viewportMode,
              metrics: collectBrowserViewerDebugMetrics(containerRef.current),
            });
          }, 800);
        };
        const handleDisconnect = () => {
          if (cancelled) {
            return;
          }
          runtimeDebugLog("browser-session:rfb-disconnected", {
            ...browserSessionWsDebugFields(wsUrl),
            connected,
            retryCount: autoRetryCountRef.current,
            forcedRuntimeId,
            metrics: collectBrowserViewerDebugMetrics(containerRef.current),
          });
          if (
            scheduleReconnectAttempt(
              connected ? "disconnect" : "connect_failure",
              wsUrl,
            )
          ) {
            return;
          }
          setStatus("error");
          setError(
            connected
              ? "Browser session disconnected. Click Retry to reconnect."
              : "Browser session failed to connect. Click Retry to start a fresh session.",
          );
        };

        rfb.addEventListener?.("connect", handleConnect);
        rfb.addEventListener?.("disconnect", handleDisconnect);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        runtimeDebugLog("browser-session:rfb-init-error", {
          ...browserSessionWsDebugFields(wsUrl),
          message,
        });
        setStatus("error");
        setError(message || "Unable to load the browser viewer.");
      }
    })();

    return () => {
      cancelled = true;
      try {
        rfb?.disconnect?.();
      } catch {
        // ignore
      }
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (rfbRef.current === rfb) {
        rfbRef.current = null;
      }
    };
  }, [
    connectedScopeKey,
    containerNode,
    forcedRuntimeId,
    fullscreen,
    humanInputEnabled,
    isOpen,
    presentation,
    rfbMaxFramebufferPixels,
    rfbRenderScale,
    scheduleReconnectAttempt,
    activeSharedBrowserViewerKind,
    viewportMode,
    wsUrl,
  ]);

  useLayoutEffect(() => {
    applySharedBrowserRfbHumanInput(rfbRef.current, humanInputEnabled);
    if (!humanInputEnabled) {
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLElement &&
        containerNode?.contains(activeElement)
      ) {
        activeElement.blur();
      }
    }
  }, [containerNode, humanInputEnabled]);

  useEffect(() => {
    if (!isOpen || !transportActive || !sharedBrowserPageId || !containerNode) {
      return;
    }
    const handlePointerMove = (event: PointerEvent) => {
      const surface = containerNode.querySelector<HTMLCanvasElement | HTMLVideoElement>(
        "canvas, video",
      );
      if (!surface) {
        return;
      }
      const cursor = normalizedRemoteBrowserPoint(
        surface,
        event.clientX,
        event.clientY,
      );
      if (!cursor) {
        return;
      }
      publishCollaborationCursor(cursor);
    };
    containerNode.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => containerNode.removeEventListener("pointermove", handlePointerMove);
  }, [
    containerNode,
    isOpen,
    publishCollaborationCursor,
    sharedBrowserPageId,
    transportActive,
  ]);

  useEffect(() => {
    if (!isOpen) {
      try {
        rfbRef.current?.disconnect?.();
      } catch {
        // ignore
      }
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      rfbRef.current = null;
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const container = containerNode;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      const rfb = rfbRef.current;
      if (!rfb) {
        return;
      }
      const rect = container.getBoundingClientRect();
      // A mounted Shared viewer is intentionally hidden while Personal is
      // active. Do not let that display:none transition become a 0x0 remote
      // desktop resize, which can tear down an otherwise healthy RFB session.
      if (rect.width < 1 || rect.height < 1) {
        return;
      }
      try {
        if (sharedBrowserViewportOnly) {
          applyBrowserViewportMode(rfb, viewportMode, true);
        } else if (viewportMode === "fit") {
          // noVNC recalculates viewport scaling when this flag is toggled.
          rfb.scaleViewport = false;
          rfb.scaleViewport = true;
        } else {
          applyBrowserViewportMode(rfb, "native");
        }
        const framebuffer = resolveBrowserRfbFramebufferSize({
          logicalWidth: rect.width,
          logicalHeight: rect.height,
          renderScale: rfbRenderScale,
          maxFramebufferPixels: rfbMaxFramebufferPixels,
        });
        applyAdaptiveBrowserRfbEncoding(rfb, {
          framebufferPixels: framebuffer.pixels,
          maxFramebufferPixels: rfbMaxFramebufferPixels,
          renderScale: rfbRenderScale,
          viewportOnly: sharedBrowserViewportOnly,
        });
      } catch {
        // ignore resize recalculation failures
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [
    containerNode,
    isOpen,
    rfbMaxFramebufferPixels,
    rfbRenderScale,
    sharedBrowserViewportOnly,
    viewportMode,
  ]);

  useEffect(() => {
    const rect = containerNode?.getBoundingClientRect();
    const framebuffer = resolveBrowserRfbFramebufferSize({
      logicalWidth: rect?.width ?? window.innerWidth,
      logicalHeight: rect?.height ?? window.innerHeight,
      renderScale: rfbRenderScale,
      maxFramebufferPixels: rfbMaxFramebufferPixels,
    });
    applyAdaptiveBrowserRfbEncoding(rfbRef.current, {
      framebufferPixels: framebuffer.pixels,
      maxFramebufferPixels: rfbMaxFramebufferPixels,
      renderScale: rfbRenderScale,
      viewportOnly: sharedBrowserViewportOnly,
    });
  }, [
    containerNode,
    rfbMaxFramebufferPixels,
    rfbRenderScale,
    sharedBrowserViewportOnly,
  ]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const rfb = rfbRef.current;
    if (!rfb) {
      return;
    }
    try {
      applyBrowserViewportMode(rfb, viewportMode, sharedBrowserViewportOnly);
    } catch {
      // ignore viewport mode updates when session is reconnecting
    }
  }, [isOpen, sharedBrowserViewportOnly, viewportMode]);

  const handleCdpScreencastConnected = useCallback(() => {
    autoRetryCountRef.current = 0;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setError(null);
    setHasConnectedOnce(true);
    setFrozenFrameUrl(null);
    if (connectedScopeKey) {
      connectedBrowserSessionScopes.add(connectedScopeKey);
    }
    setStatus("connected");
    runtimeDebugLog("browser-session:cdp-screencast-connected", {
      ...(wsUrl ? browserSessionWsDebugFields(wsUrl) : {}),
      pageId: sharedBrowserPageId,
      metrics: collectBrowserViewerDebugMetrics(containerRef.current),
    });
  }, [connectedScopeKey, sharedBrowserPageId, wsUrl]);

  const handleCdpScreencastDisconnected = useCallback(
    (detail: CdpScreencastDisconnect) => {
      if (!wsUrl) {
        return;
      }
      runtimeDebugLog("browser-session:cdp-screencast-disconnected", {
        ...browserSessionWsDebugFields(wsUrl),
        ...detail,
        retryCount: autoRetryCountRef.current,
        forcedRuntimeId,
      });
      if (fallBackFromViewer(detail.reason)) {
        return;
      }
      if (
        scheduleReconnectAttempt(
          detail.connected ? "disconnect" : "connect_failure",
          wsUrl,
        )
      ) {
        return;
      }
      setStatus("error");
      setError(
        detail.connected
          ? "Browser session disconnected. Click Retry to reconnect."
          : "Browser renderer failed to connect. Click Retry to start a fresh session.",
      );
    },
    [fallBackFromViewer, forcedRuntimeId, scheduleReconnectAttempt, wsUrl],
  );

  const handleCdpScreencastError = useCallback(
    (message: string, fatal: boolean) => {
      runtimeDebugLog("browser-session:cdp-screencast-error", {
        ...(wsUrl ? browserSessionWsDebugFields(wsUrl) : {}),
        message,
        fatal,
      });
      if (!fatal) {
        return;
      }
      if (fallBackFromViewer(message)) {
        return;
      }
      setStatus("connecting");
      setError(null);
    },
    [fallBackFromViewer, wsUrl],
  );

  const handleWebRtcConnected = useCallback(() => {
    autoRetryCountRef.current = 0;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setError(null);
    setHasConnectedOnce(true);
    setFrozenFrameUrl(null);
    if (connectedScopeKey) {
      connectedBrowserSessionScopes.add(connectedScopeKey);
    }
    setStatus("connected");
    runtimeDebugLog("browser-session:webrtc-connected", {
      pageId: sharedBrowserPageId,
      metrics: collectBrowserViewerDebugMetrics(containerRef.current),
    });
  }, [connectedScopeKey, sharedBrowserPageId]);

  const handleWebRtcDisconnected = useCallback(
    (detail: WebRtcBrowserDisconnect) => {
      runtimeDebugLog("browser-session:webrtc-disconnected", {
        ...detail,
        forcedRuntimeId,
      });
      if (fallBackFromViewer(detail.reason)) {
        return;
      }
      setStatus("error");
      setError(
        detail.connected
          ? "Browser video disconnected. Click Retry to reconnect."
          : "Browser video failed to connect. Click Retry to start a fresh session.",
      );
    },
    [fallBackFromViewer, forcedRuntimeId],
  );

  const handleWebRtcError = useCallback(
    (message: string, fatal: boolean) => {
      runtimeDebugLog("browser-session:webrtc-error", { message, fatal });
      if (!fatal) {
        return;
      }
      if (fallBackFromViewer(message)) {
        return;
      }
      setStatus("error");
      setError(message || "Shared Browser video is unavailable.");
    },
    [fallBackFromViewer],
  );

  const compactGhostButtonClass =
    "text-slate-500 hover:bg-slate-100 hover:text-slate-700 data-[hovered]:bg-slate-100 data-[hovered]:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-200 dark:data-[hovered]:bg-slate-900 dark:data-[hovered]:text-slate-200";
  const compactPrimaryButtonClass =
    "bg-primary-600 text-white hover:bg-primary-700 data-[hovered]:bg-primary-700";
  const viewportSurfaceClass =
    displayStatus === "connected" && !error
      ? "bg-black"
      : "bg-slate-100 dark:bg-slate-950";
  const disconnectedCardClass =
    "border border-slate-200 bg-white text-left text-slate-700 dark:border-[color:var(--color-studio-dark-panel-border)] dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-200";
  const compactCardBody = shouldCollapseDocked ? (
    <div
      className={[
        "absolute inset-0 rounded-[1.35rem] border shadow-sm",
        collapsedCardMode === "limit"
          ? "border-amber-300/70 bg-amber-50/90 dark:border-amber-500/30 dark:bg-amber-500/10"
          : collapsedCardMode === "error"
            ? "border-rose-200/80 bg-rose-50/90 dark:border-rose-500/30 dark:bg-rose-500/10"
            : "border-slate-200/70 bg-white/96 dark:border-slate-800 dark:bg-slate-950/95",
      ].join(" ")}
      data-testid="browser-session-collapsed-card"
    >
          {collapsedCardMode === "limit" ? (
            <div className="space-y-3 px-3.5 py-3">
              <div className="min-w-0 space-y-1">
                <Text as="p" variant="bodyStrong" tone="primary">
                  Cloud runtime already in use
                </Text>
                <Text as="p" variant="caption" tone="muted" className="leading-snug">
                  {runtimeSlotSummary}
                </Text>
                {blockerProjectCopy ? (
                  <Text as="p" variant="caption" tone="muted" className="leading-snug">
                    {blockerProjectCopy}
                  </Text>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {hasTakeoverBlocker ? (
                  <Button
                    onPress={handleRuntimeLimitTakeover}
                    variant="primary"
                    size="sm"
                    radius="full"
                    isDisabled={runtimeLimitActionBusy}
                  >
                    {runtimeLimitActionBusy ? "Opening here..." : "Stop and open here"}
                  </Button>
                ) : null}
                <Button
                  onPress={retryConnection}
                  variant="ghost"
                  size="sm"
                  radius="full"
                  isDisabled={runtimeLimitActionBusy}
                >
                  Try again
                </Button>
              </div>
            </div>
          ) : collapsedCardMode === "error" ? (
            <div className="space-y-3 px-3.5 py-3">
              <div className="min-w-0 space-y-1">
                <Text as="p" variant="bodyStrong" tone="primary">
                  Browser unavailable
                </Text>
                <Text as="p" variant="caption" tone="muted" className="leading-snug">
                  {error}
                </Text>
              </div>
              <div className="flex items-center gap-2">
                <Button onPress={retryConnection} variant="ghost" size="sm" radius="full">
                  Retry
                </Button>
                <Button onPress={closeBrowserSession} variant="ghost" size="sm" radius="full">
                  Hide
                </Button>
              </div>
            </div>
          ) : collapsedCardMode === "connecting" ? (
            <div
              className="flex items-center justify-between gap-3 px-3.5 py-3"
              role={shouldUseDesktopDockedCard ? "button" : undefined}
              tabIndex={shouldUseDesktopDockedCard ? 0 : undefined}
              onClick={shouldUseDesktopDockedCard ? expandDockedViewer : undefined}
              onKeyDown={
                shouldUseDesktopDockedCard
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        expandDockedViewer();
                      }
                    }
                  : undefined
              }
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
                  <Safari className="h-4.5 w-4.5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <Text as="p" variant="bodyStrong" tone="primary">
                    Browser starting
                  </Text>
                  <Text as="p" variant="caption" tone="muted" className="flex items-center gap-1.5">
                    <Spinner aria-hidden="true" tone="slate" size="xs" />
                    <span>Open fullscreen when ready.</span>
                  </Text>
                </div>
              </div>
              <IconButton
                variant="primary"
                size="sm"
                radius="full"
                onPress={() => setFullscreen(true)}
                aria-label="Open browser fullscreen"
                title="Open browser fullscreen"
                className={compactPrimaryButtonClass}
                onClick={(event) => event.stopPropagation()}
              >
                <Expand className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            </div>
          ) : (
            <div
              className={[
                "flex items-center justify-between gap-3 px-3.5 py-2.5",
                shouldUseDesktopDockedCard ? "cursor-pointer" : "",
              ].join(" ")}
              role={shouldUseDesktopDockedCard ? "button" : undefined}
              tabIndex={shouldUseDesktopDockedCard ? 0 : undefined}
              onClick={shouldUseDesktopDockedCard ? expandDockedViewer : undefined}
              onKeyDown={
                shouldUseDesktopDockedCard
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        expandDockedViewer();
                      }
                    }
                  : undefined
              }
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="inline-flex h-10 w-10 flex-none items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
                  <Safari className="h-4.5 w-4.5" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <Text as="p" variant="bodyStrong" tone="primary" className="truncate">
                    Browser
                  </Text>
                  <span className="inline-flex items-center gap-1.5 text-xxs font-medium text-emerald-600 dark:text-emerald-400">
                    <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500 dark:bg-emerald-400" />
                    <span>Connected</span>
                  </span>
                </div>
              </div>
              <div className="flex flex-none items-center gap-1.5">
                <IconButton
                  variant="ghost"
                  size="sm"
                  radius="full"
                  onPress={closeBrowserSession}
                  aria-label="Hide browser session"
                  title="Hide browser session"
                  className={compactGhostButtonClass}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Xmark className="h-4 w-4" aria-hidden="true" />
                </IconButton>
                <IconButton
                  variant="primary"
                  size="sm"
                  radius="full"
                  onPress={() => setFullscreen(true)}
                  aria-label="Open browser fullscreen"
                  title="Open browser fullscreen"
                  className={compactPrimaryButtonClass}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Expand className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              </div>
            </div>
          )}
    </div>
  ) : null;

  const panelContent = renderCollapsedConnectedIntoShelf ? (
    <div aria-hidden="true" className="pointer-events-none h-px w-px overflow-hidden opacity-0">
      <div ref={setContainerElement} className="h-full w-full overflow-hidden" />
    </div>
  ) : (
    <div className={isInlineDocked && !fillContainer ? "flex flex-col" : "flex h-full min-h-0 flex-col"}>
      {!shouldCollapseDocked && !(fillContainer && sharedBrowserChrome) ? (
        <div
          className={
            fillContainer
              ? "flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-2 py-0.5 dark:border-slate-800 dark:bg-slate-950 sm:px-3"
              : "flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-950 sm:px-4"
          }
          data-browser-session-safe-zone="true"
        >
          <div className="flex min-w-0 items-center gap-2">
            {toolbarLeading}
            {!fillContainer ? (
              <>
                <span
                  className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                  aria-hidden="true"
                >
                  <Safari className="h-4 w-4" aria-hidden="true" />
                </span>
                <Text variant="bodyStrong" tone="primary" className="truncate">
                  Browser
                </Text>
              </>
            ) : null}
            {effectiveAgentControlOwner ? (
              <SharedBrowserControlOwnerPill controlOwner={effectiveAgentControlOwner} />
            ) : (
              <BrowserSessionStatusPill status={displayStatus} />
            )}
            {toolbarLeading ? null : (
              <BrowserIdentityBadge className={fillContainer ? "inline-flex" : "hidden sm:inline-flex"} />
            )}
          </div>
          <div className="flex flex-none items-center gap-1">
            {!forceViewportFullscreenDocked ? (
              <IconButton
                variant="ghost"
                size="xs"
                radius="full"
                onPress={toggleFullscreen}
                className="text-slate-500 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 dark:data-[hovered]:text-slate-200"
                data-testid="browser-session-fullscreen-toggle"
                aria-label={fullscreen ? "Minimize browser session" : "Fullscreen browser session"}
              >
                {fullscreen ? <Collapse className="h-4 w-4" aria-hidden="true" /> : <Expand className="h-4 w-4" aria-hidden="true" />}
              </IconButton>
            ) : null}
            <IconButton
              variant="ghost"
              size="xs"
              radius="full"
              onPress={returnToChat}
              aria-label={returnToChatLabel}
              title={returnToChatLabel}
              className="text-slate-400 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 dark:data-[hovered]:text-slate-200"
            >
              <Xmark className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </div>
        </div>
      ) : null}

      {!shouldCollapseDocked && fillContainer && sharedBrowserChrome ? (
        <SharedBrowserChrome
          {...sharedBrowserChrome}
          controlOwner={effectiveAgentControlOwner ?? controlOwner}
          interactionEnabled={humanInputEnabled}
          toolbarActions={
            <>
              <SharedBrowserCollaborationControls
                client={collaboration.client}
                compact={sharedBrowserChrome.compact ?? false}
                localControlOwner={effectiveAgentControlOwner ?? controlOwner}
                onGrantControl={(participantId) => {
                  collaboration.grantControl(participantId);
                }}
                onReleaseControl={() => {
                  collaboration.releaseControl();
                }}
                onRequestControl={() => {
                  collaboration.requestControl();
                }}
                onTakeControl={() => {
                  collaboration.takeControl();
                }}
              />
              {!forceViewportFullscreenDocked && !sharedBrowserChrome.compact ? (
                <IconButton
                  variant="ghost"
                  size="sm"
                  radius="full"
                  onPress={toggleFullscreen}
                  className="max-[540px]:hidden text-slate-500 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 dark:data-[hovered]:text-slate-200"
                  data-testid="browser-session-fullscreen-toggle"
                  aria-label={fullscreen ? "Minimize browser session" : "Fullscreen browser session"}
                  title={fullscreen ? "Minimize browser session" : "Fullscreen browser session"}
                >
                  {fullscreen ? <Collapse className="h-4 w-4" aria-hidden="true" /> : <Expand className="h-4 w-4" aria-hidden="true" />}
                </IconButton>
              ) : null}
            </>
          }
          toolbarLeading={toolbarLeading}
          toolbarStatus={
            <BrowserSessionStatusPill
              compact={sharedBrowserChrome.compact}
              status={displayStatus}
            />
          }
        />
      ) : null}

      <div
        key="shared-browser-viewport"
        data-testid="browser-session-viewport"
        className={
          fillContainer
            ? sharedBrowserChrome
              ? `relative flex min-h-0 flex-1 items-center justify-center overflow-hidden ${viewportSurfaceClass}`
              : `relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2 ${viewportSurfaceClass}`
            : isInlineDocked
            ? [
                "flex flex-none justify-center px-3 sm:px-4",
                shouldCollapseDocked
                  ? "bg-transparent py-2.5"
                  : dockedLayout.compact
                    ? "bg-transparent py-2 pb-1.5"
                    : "bg-transparent py-2 pb-2",
              ].join(" ")
            : `relative flex-1 ${viewportSurfaceClass}`
        }
      >
        <div
          className={
            fillContainer
              ? sharedBrowserChrome
                ? "relative h-full w-full overflow-hidden"
                : "relative h-full w-full overflow-hidden rounded-lg"
              : isInlineDocked
              ? shouldCollapseDocked
                ? "relative w-full overflow-hidden rounded-[1.15rem] border border-slate-200/70 bg-slate-950/92 shadow-modal dark:border-slate-800 dark:bg-slate-950/96"
                : "relative w-full overflow-hidden rounded-none border-0 bg-transparent shadow-none"
              : "relative h-full w-full"
          }
          style={
            fillContainer
              ? undefined
              : isInlineDocked
              ? {
                  ...(shouldCollapseDocked
                    ? {
                        height: `${dockedStageHeight}px`,
                        maxWidth: `${dockedStageMaxWidth}px`,
                      }
                    : {
                        width: "100%",
                        maxWidth: `${dockedStageMaxWidth}px`,
                        aspectRatio: `${DOCKED_BROWSER_ASPECT_RATIO}`,
                      }),
                }
              : undefined
          }
          data-testid={isInlineDocked ? "browser-session-stage" : undefined}
          data-shared-browser-viewer={activeSharedBrowserViewerKind ?? "unsupported"}
          data-human-input-enabled={humanInputEnabled ? "true" : "false"}
        >
          {frozenFrameUrl && status === "connecting" ? (
            <img
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full bg-black object-contain"
              data-testid="browser-session-frozen-frame"
              src={frozenFrameUrl}
            />
          ) : null}
          <div
            ref={setContainerElement}
            className={[
              shouldCollapseDocked
                ? "absolute inset-0 overflow-hidden opacity-0 pointer-events-none"
                : viewportMode === "native"
                  ? "absolute inset-0 overflow-auto touch-pan-x touch-pan-y touch-pinch-zoom"
                  : "absolute inset-0 overflow-hidden",
              frozenFrameUrl && status === "connecting" ? "opacity-0" : "",
            ].join(" ")}
          >
            {activeSharedBrowserViewerKind === "webrtc" && webRtcConnection ? (
              <WebRtcBrowserViewer
                offerUrl={webRtcConnection.offerUrl}
                inputWsUrl={webRtcConnection.inputWsUrl}
                inputAvailable={canControlBrowser}
                accessToken={webRtcConnection.accessToken}
                iceServers={webRtcIceServers}
                relayOnly={webRtcRelayOnly}
                renderScale={rfbRenderScale}
                active={
                  transportActive &&
                  webRtcInputTargetsActivePage(
                    webRtcConnection.pageId,
                    sharedBrowserConnectionPageId,
                  )
                }
                inputEnabled={
                  humanInputEnabled &&
                  webRtcInputTargetsActivePage(
                    webRtcConnection.pageId,
                    sharedBrowserConnectionPageId,
                  )
                }
                onConnected={handleWebRtcConnected}
                onDisconnected={handleWebRtcDisconnected}
                onTransportError={handleWebRtcError}
              />
            ) : null}
            {activeSharedBrowserViewerKind === "cdp-screencast" && wsUrl ? (
              <CdpScreencastViewer
                wsUrl={wsUrl}
                inputWsUrl={browserInputWsUrl}
                inputAvailable={canControlBrowser}
                inputAuthorityKey={inputAuthorityKey}
                active={transportActive}
                inputEnabled={humanInputEnabled}
                onConnected={handleCdpScreencastConnected}
                onDisconnected={handleCdpScreencastDisconnected}
                onTransportError={handleCdpScreencastError}
              />
            ) : null}
          </div>
          {!shouldCollapseDocked && displayStatus === "connected" ? (
            <>
              {effectiveAgentControlOwner ? (
                <div
                  aria-hidden="true"
                  className="absolute inset-0 z-10 cursor-not-allowed"
                  data-testid="shared-browser-agent-control-overlay"
                />
              ) : null}
              <BrowserCursorOverlay
                containerRef={containerRef}
                latestClick={browserLatestClick}
                renderScale={rfbRenderScale}
              />
              <SharedBrowserParticipantPointers
                activePageId={sharedBrowserPageId}
                containerRef={containerRef}
                participants={collaboration.client.state?.participants ?? []}
                selfParticipantId={collaboration.client.participantId}
              />
              <ActionTicker actions={browserActions} />
              <RemoteBrowserMobileKeyboard
                enabled={
                  humanInputEnabled && activeSharedBrowserViewerKind !== "rfb"
                }
                onMessage={dispatchMobileBrowserInput}
              />
            </>
          ) : null}
          {!shouldCollapseDocked && status === "connecting" && hasConnectedHint && !error ? (
            <div
              className="pointer-events-none absolute right-3 top-3 rounded-full border border-white/15 bg-slate-950/80 px-2.5 py-1 text-xs font-medium text-white shadow-sm backdrop-blur"
              data-testid="browser-session-reconnecting"
              role="status"
            >
              Reconnecting…
            </div>
          ) : null}
          {compactCardBody}
          {!shouldCollapseDocked && (displayStatus !== "connected" || error) ? (
            <div
              className={[
                "pointer-events-none absolute inset-0 flex items-center justify-center p-6",
                error && limitReached ? "bg-slate-950/15 backdrop-blur-[1px]" : "",
              ].join(" ")}
              data-testid={error && limitReached ? "browser-runtime-limit-scrim" : undefined}
            >
              <div
                className={[
                  "pointer-events-auto w-full max-w-md rounded-2xl p-4 text-sm shadow-xl",
                  disconnectedCardClass,
                ].join(" ")}
                data-testid={
                  error && limitReached
                    ? "browser-runtime-limit-card"
                    : "browser-session-state-card"
                }
              >
                {error ? (
                  limitReached ? (
                    <div className="space-y-3" data-testid="browser-runtime-limit-notice">
                      <Text as="p" variant="bodyStrong" tone="primary">
                        Cloud runtime already in use
                      </Text>
                      <Text as="p" variant="body" tone="secondary" className="leading-snug">
                        {runtimeSlotSummary}
                      </Text>
                      {blockerProjectCopy ? (
                        <Text as="p" variant="body" tone="secondary" className="leading-snug">
                          {blockerProjectCopy}
                        </Text>
                      ) : null}
                      <Text as="p" variant="caption" tone="muted" className="leading-snug">
                        {hasTakeoverBlocker
                          ? "Stop it to free the slot and open Shared Browser here. This can interrupt work running there."
                          : "Stop another cloud runtime, then try again."}
                      </Text>
                      <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center">
                        {hasTakeoverBlocker ? (
                          <Button
                            onPress={handleRuntimeLimitTakeover}
                            variant="primary"
                            size="sm"
                            radius="full"
                            isDisabled={runtimeLimitActionBusy}
                            data-testid="browser-runtime-limit-takeover"
                          >
                            {runtimeLimitActionBusy
                              ? "Opening here..."
                              : "Stop and open here"}
                          </Button>
                        ) : null}
                        <Button
                          onPress={retryConnection}
                          variant="secondary"
                          size="sm"
                          radius="full"
                          isDisabled={runtimeLimitActionBusy}
                          data-testid="browser-runtime-limit-retry"
                        >
                          Try again
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3" data-testid="browser-session-error-notice">
                      <div className="space-y-1">
                        <Text as="p" variant="bodyStrong" tone="primary">
                          Browser unavailable
                        </Text>
                        <Text
                          as="p"
                          variant="body"
                          tone="secondary"
                          className="whitespace-pre-wrap leading-snug"
                        >
                          {error}
                        </Text>
                      </div>
                      <div className="flex items-center">
                        <Button
                          onPress={retryConnection}
                          variant="secondary"
                          size="sm"
                          radius="full"
                          data-testid="browser-session-error-retry"
                        >
                          Try again
                        </Button>
                      </div>
                    </div>
                  )
                ) : (
                  <div
                    className="flex items-start gap-3"
                    data-testid="browser-session-loading-notice"
                    role="status"
                  >
                    <Spinner aria-hidden="true" tone="slate" size="sm" />
                    <div className="min-w-0 space-y-1">
                      <Text as="p" variant="bodyStrong" tone="primary">
                        Starting Shared Browser
                      </Text>
                      <Text as="p" variant="body" tone="secondary" className="leading-snug">
                        Preparing a secure browser session…
                      </Text>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}
          {!shouldCollapseDocked && sharedBrowserApproval.pending ? (
            <SharedBrowserApprovalPrompt
              active={transportActive}
              error={sharedBrowserApproval.error}
              onDecision={(decision) => {
                void sharedBrowserApproval.decide(decision);
              }}
              request={sharedBrowserApproval.pending.request}
              submitting={sharedBrowserApproval.submitting}
            />
          ) : null}
        </div>
      </div>
    </div>
  );

  if (presentation === "docked") {
    if (!isOpen) {
      return null;
    }

    if (renderFullscreen) {
      return (
        <StudioDialogModal
          isOpen={isOpen}
          onOpenChange={onOpenChange}
          isDismissable
          dialogAriaLabel="Browser session"
          className={fullscreenOverlayClassName}
          modalClassName={fullscreenModalClassName}
          dialogClassName={fullscreenDialogClassName}
          data-testid="browser-session-modal"
        >
          {panelContent}
        </StudioDialogModal>
      );
    }

    return (
      <section
        aria-label="Browser session"
        ref={dockedRootRef}
        className={
          fillContainer
            ? "flex h-full w-full flex-col overflow-hidden border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950"
            : shouldCollapseDocked
              ? "w-full"
              : "mx-auto w-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-950"
        }
        style={
          fillContainer || shouldCollapseDocked
            ? undefined
            : {
                maxWidth: `${dockedStageMaxWidth}px`,
              }
        }
        data-testid="browser-session-modal"
      >
        {panelContent}
      </section>
    );
  }

  return (
    <StudioDialogModal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      dialogAriaLabel="Browser session"
      className={fullscreen ? fullscreenOverlayClassName : undefined}
      modalClassName={fullscreen ? fullscreenModalClassName : modalClassName}
      dialogClassName={fullscreen ? fullscreenDialogClassName : "h-full"}
      data-testid="browser-session-modal"
    >
      {panelContent}
    </StudioDialogModal>
  );
}
