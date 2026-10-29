import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Expand, Safari, Xmark } from "iconoir-react";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { IconButton } from "../../../components/Button";
import { StudioMenuSeparator } from "../../../components/aria/StudioMenu";
import { LoadingStatus } from "../../../components/LoadingStatus";
import { Surface } from "../../../components/Surface";
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
import {
  buildBrowserOriginHttpUrl,
  buildBrowserOriginWebSocketUrl,
  type BrowserOriginHttpPath,
  type BrowserOriginSocketPath,
} from "./browserOriginUrls";
import type { StatusIntent } from "../../../status/useStatus";
import { useBrowserSessionActions } from "./useBrowserSessionActions";
import { useExpandedBrowserViewport } from "./useExpandedBrowserViewport";
import { BrowserCursorOverlay } from "./BrowserCursorOverlay";
import { observeBrowserRfbFrames } from "./browserSessionRfbFrame";
import { BrowserExpandButton } from "./BrowserExpandButton";
import { BrowserHumanInputStatus } from "./BrowserHumanInputControls";
import { RemoteControlSurface } from "./RemoteControlSurface";
import { useBrowserHumanInput } from "./useBrowserHumanInput";
import { BrowserReadingRow } from "./BrowserReadingRow";
import { browserReadingHost, resolveAgentReadingPages } from "./browserAgentTabs";
import { browserPageOrigin, selectSharedBrowserHumanInput } from "./browserHandoffRouting";
import { ActionTicker } from "./ActionTicker";
import { SharedBrowserCollaborationControls } from "./SharedBrowserCollaborationControls";
import { SharedBrowserDataClearAction } from "./SharedBrowserDataClearAction";
import { SharedBrowserSessionControl } from "./SharedBrowserSessionControl";
import { SharedBrowserProfileStatus } from "./SharedBrowserProfileStatus";
import { buildSharedBrowserResumeUrl } from "./sharedBrowserResume";
import { resolvePublicAppUrl } from "../../../utils/publicAppUrl";
import { SharedBrowserParticipantPointers } from "./SharedBrowserParticipantPointers";
import { collaborationSelfOwnsControl } from "./sharedBrowserCollaboration";
import { useSharedBrowserCollaboration } from "./useSharedBrowserCollaboration";
import { useSustainedFlag } from "./useSustainedFlag";
import { BrowserIdentityBadge } from "./BrowserIdentityBadge";
import { BrowserSessionArrival, BrowserSessionRecovery, BrowserSessionReconnecting } from "./BrowserSessionRecovery";
import { browserArrivalNote, type BrowserTurnArrival } from "./browserTurnArrival";
import {
  BROWSER_LIVE_STAGE_CLASS,
  shouldForceDockedBrowserFullscreen,
  shouldRenderBrowserSessionFullscreen,
} from "./browserSessionLayout";
import { browserSessionWsDebugFields } from "./browserSessionDebug";
import type { SharedBrowserPresence } from "./browserAutoStart";
import {
  coalesceBrowserRuntimeEnsure,
  listBrowserRuntimeCandidates,
  resolveBrowserRuntimeSelection,
  type BrowserRuntimeCandidate,
  resolveAutoRecyclableBrowserRuntimeIdentity,
  waitForBrowserRuntimeOrigin,
} from "./browserSessionRuntimeEnsure";
import {
  liveSharedBrowserHostCandidate,
  SHARED_BROWSER_HOST_COPY,
  shouldStartSpaceMachineForBrowser,
  startSpaceMachineForBrowser,
  waitForSharedBrowserHostReady,
} from "./sharedBrowserHostAttach";
import { bootBrowserProbeFromError, waitForBootBrowserRunning } from "./bootBrowserWait";
import {
  hostedBrowserViewState,
  type HostedBrowserErrorKind,
  type HostedBrowserFailure,
  type HostedBrowserViewKind,
  type HostedBrowserViewState,
} from "./hostedBrowserViewState";
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
import {
  useSharedBrowserApproval,
  type SharedBrowserApprovalState,
} from "./useSharedBrowserApproval";
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
  remoteSharedBrowserController,
  type SharedBrowserControlOwner,
} from "./sharedBrowserControlOwner";

type BrowserSessionStatus = "idle" | "selecting" | "connecting" | "connected" | "error";
type BrowserSessionPresentation = "modal" | "docked";
type BrowserViewportMode = "fit" | "native";
type DockedBrowserLayoutMetrics = {
  height: number;
  maxWidth: number;
  compact: boolean;
};
type BrowserSessionRfbLike = {
  _canvas?: HTMLCanvasElement;
  addEventListener?: (type: "connect" | "disconnect", listener: () => void) => void;
  background?: string;
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
export const CLEAR_SHARED_BROWSER_HOST_DATA_CONFIRMATION =
  "Clear Shared Browser data for everyone in this space? This signs everyone out of websites, deletes shared cookies and site data, and restarts this space's machine, which stops its previews and terminals. This cannot be undone.";
export const CLEAR_SHARED_BROWSER_HOST_DATA_BUSY_NOTE = "Octo's running work in this space stops too.";
const CLEAR_SHARED_BROWSER_HOST_DATA_SUCCESS =
  "Shared Browser data cleared. Restarting this space's machine…";
const controllerBaseUrl = controllerClient.core.baseUrl;
const CDP_SCREENCAST_REQUESTED =
  (import.meta.env.VITE_INSTAFY_SHARED_BROWSER_CDP_SCREENCAST ?? "").trim() === "1";
const WEBRTC_REQUESTED =
  (import.meta.env.VITE_INSTAFY_SHARED_BROWSER_WEBRTC ?? "").trim() === "1";
const MAX_AUTO_CONNECT_RETRIES = 5;
const AUTO_CONNECT_RETRY_BASE_DELAY_MS = 1000;
/**
 * Reconnects that fatal viewer errors may ask for within this window, even
 * when a connection succeeds in between, so a lane that keeps failing ends in
 * an error instead of reconnecting forever.
 */
const FATAL_VIEWER_ERROR_WINDOW_MS = 60_000;
/**
 * How long a connected browser may wait for its roster before it knows which
 * viewer this participant may use; then it says so and offers Retry.
 */
export const SHARED_BROWSER_VIEWER_WAIT_TIMEOUT_MS = 20_000;
/**
 * Reasons the view keeps for runtime debug (`data-debug-reason`); the screen
 * says "Instafy's browser did not open. Try again." for both.
 */
export const SHARED_BROWSER_VIEWER_WAIT_REASON = "viewer roster did not arrive in time";
export const SHARED_BROWSER_LOST_CONNECTION_REASON = "connection lost and its reconnects were used";
/**
 * How long a browser that had connected may show "Reconnecting…" by itself
 * before it says it lost the connection and offers Retry.
 */
export const SHARED_BROWSER_RECONNECT_TIMEOUT_MS = 60_000;
/**
 * How long a live view must have lost its picture before it says
 * "Reconnecting…". An automatic reconnect that is back sooner (a viewer
 * swap, a cached grant, a socket blip) shows nothing at all.
 */
export const RECONNECTING_GRACE_MS = 1_500;
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

/**
 * A grant refresh that failed for a reason other than its origin going away
 * is asked again after 5 s, then 10, 20, 40 and at most 60 s apart.
 */
export const BROWSER_ORIGIN_TOKEN_REFRESH_RETRY_MS = 5_000;
export const BROWSER_ORIGIN_TOKEN_REFRESH_MAX_RETRY_MS = 60_000;
/** A re-attach keeps a connection whose grant has at least this long left. */
const SHARED_BROWSER_CONNECTION_REUSE_MIN_REMAINING_MS = 30_000;

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

// One load of the viewer's code, shared by the viewers that start at once
// (one lane closing as another opens, such as when Octo takes control). A
// failed load is tried again by the next viewer.
let browserRfbModule: Promise<unknown> | null = null;
function loadBrowserRfbModule(): Promise<unknown> {
  if (!browserRfbModule) {
    const loading: Promise<unknown> = import("@novnc/novnc/lib/rfb");
    browserRfbModule = loading;
    loading.catch(() => {
      if (browserRfbModule === loading) browserRfbModule = null;
    });
  }
  return browserRfbModule;
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
  view,
  compact = false,
}: {
  status: BrowserSessionStatus;
  view: HostedBrowserViewState;
  compact?: boolean;
}) {
  if (status === "selecting") {
    return <span className={`inline-flex h-7 shrink-0 items-center rounded-full border border-slate-300/80 bg-slate-100/80 text-xxs font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-300 ${compact ? "px-1.5" : "px-2"}`}
      data-testid="browser-session-status" role="status" aria-live="polite">Choose session</span>;
  }
  // A neutral label; the card says why in its one sentence.
  const state: BrowserChromeState =
    view.kind === "live" ? "ready" : view.kind === "opening" ? "starting" : "off";
  const detail = view.kind === "live" ? "Instafy's browser is open." : view.sentence;
  return (
    <BrowserStatusPill
      compact={compact}
      detail={detail}
      state={state}
      // While opening, the view shows its own centered "Opening Instafy's browser…".
      startingShownInView
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

function buildBrowserWebSocketUrl(params: {
  endpoint: string;
  token: string;
  browserPath: BrowserOriginSocketPath;
  originId?: string | null;
  pageId?: string | null;
}): string {
  return buildBrowserOriginWebSocketUrl({ ...params, controllerBaseUrl });
}

function buildVncWebSocketUrl({ viewOnly = false, ...params }: {
  endpoint: string;
  token: string;
  originId?: string | null;
  viewOnly?: boolean;
}): string {
  return buildBrowserWebSocketUrl({ ...params, browserPath: viewOnly ? "vnc/view" : "vnc" });
}

function buildBrowserHttpUrl(params: {
  endpoint: string;
  browserPath: BrowserOriginHttpPath;
  originId?: string | null;
}): string {
  return buildBrowserOriginHttpUrl({ ...params, controllerBaseUrl });
}

export function BrowserSessionModal({
  isOpen,
  onOpenChange,
  projectId,
  browserSessionId: suppliedBrowserSessionId,
  preferRuntimeId,
  resumeRuntimeId = null,
  onRuntimeIdResolved,
  presentation = "modal",
  hideCollapsedConnectedCard = false,
  expandRequestToken = 0,
  attachRequestToken = 0,
  autoAttachToken = 0,
  onConnectionErrorChange = null,
  onViewStateChange = null,
  fillContainer = false,
  toolbarLeading,
  locationOptions,
  transportActive = true,
  canControlBrowser = false,
  canClearBrowserData = false,
  controlOwner = HUMAN_SHARED_BROWSER_CONTROL_OWNER,
  onBackToChat,
  onApprovalPendingChange,
  onStatus,
  sharedBrowserChrome = null,
  sharedBrowserViewerKind = "rfb",
  sharedBrowserCapabilitiesResolved = true,
  sharedBrowserCapabilitiesAvailable = true,
  sharedBrowserCapabilitiesUnsupported = false,
  sharedBrowserAvailableViewerKinds = DEFAULT_SHARED_BROWSER_VIEWER_KINDS,
  humanInputIdentityKey,
  humanInputRunIds = null,
  currentUserId = null,
  onTakeOverAgent,
  onContinueAfterHumanInput,
  sharedBrowserRfbCapabilities = null,
  sharedBrowserWebRtcCapabilities = null,
  onPresenceChange,
  ensureSpaceMachine = null,
  conversationRuntimeId = null,
  attachOnly = false,
  openedByPerson = true,
  spaceBusy = false,
  runApproval = null,
  conversationId = null,
  agentArrival = null,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  browserSessionId?: string | null;
  preferRuntimeId: string | null;
  resumeRuntimeId?: string | null;
  onRuntimeIdResolved?: ((runtimeId: string) => void) | null;
  presentation?: BrowserSessionPresentation;
  hideCollapsedConnectedCard?: boolean;
  expandRequestToken?: number;
  /**
   * Bumped by a press on a card while this browser is open: the browser
   * attaches to its machine again, as the person's own Retry does, keeping
   * the last frame. It starts Instafy's browser when it went idle and shows
   * why when it cannot.
   */
  attachRequestToken?: number;
  /**
   * Bumped by Studio itself while this browser is off or did not open: an
   * agent or another viewer started Instafy's browser, or Studio opens it for
   * a card. It attaches again without a press and never starts the machine.
   */
  autoAttachToken?: number;
  /** The sentence this browser shows when it is not live, or null; null again once it closes. */
  onConnectionErrorChange?: ((error: string | null) => void) | null;
  /** What this browser shows (off, opening, live, failed, blocked); null once it closes. */
  onViewStateChange?: ((state: HostedBrowserViewKind | null) => void) | null;
  fillContainer?: boolean;
  toolbarLeading?: ReactNode;
  /** Where the browser runs (`BrowserLocationOptions`), shown in its Options menu. */
  locationOptions?: ReactNode;
  transportActive?: boolean;
  canControlBrowser?: boolean;
  canClearBrowserData?: boolean;
  controlOwner?: SharedBrowserControlOwner;
  onBackToChat?: (() => void) | null;
  onApprovalPendingChange?: ((pending: boolean) => void) | null;
  onStatus?: (
    message: string,
    intent?: StatusIntent,
    durationMs?: number,
  ) => void;
  sharedBrowserChrome?: SharedBrowserChromeProps | null;
  sharedBrowserViewerKind?: SupportedSharedBrowserViewerKind | null;
  sharedBrowserCapabilitiesResolved?: boolean;
  sharedBrowserCapabilitiesAvailable?: boolean;
  sharedBrowserCapabilitiesUnsupported?: boolean;
  sharedBrowserAvailableViewerKinds?: SupportedSharedBrowserViewerKind[];
  humanInputIdentityKey?: string;
  humanInputRunIds?: ReadonlySet<string> | null;
  currentUserId?: string | null;
  /**
   * Take over. `agentHoldsBrowser`: the browser reports the agent's control,
   * which spans every tab, so the run is stopped from whichever tab is on
   * screen.
   */
  onTakeOverAgent?: ((options?: { agentHoldsBrowser?: boolean }) => Promise<boolean>) | null;
  onContinueAfterHumanInput?: ((message: string) => Promise<boolean>) | null;
  sharedBrowserRfbCapabilities?: RuntimeBrowserSessionCapabilities["rfb"] | null;
  sharedBrowserWebRtcCapabilities?: RuntimeBrowserSessionCapabilities["webrtc"] | null;
  /** Who else is in this browser, from its collaboration roster; null once it closes. */
  onPresenceChange?: ((presence: SharedBrowserPresence | null) => void) | null;
  /**
   * Starts this space's own machine (the generic hosted ensure), for a press
   * that opens Instafy's browser while the machine is not running. Null when
   * the person cannot start it.
   */
  ensureSpaceMachine?: (() => Promise<boolean>) | null;
  /** The machine the conversation runs on; the cold path waits for it. */
  conversationRuntimeId?: string | null;
  /**
   * Set for an open Studio started by itself: it only attaches to the
   * space's running machine and never starts or ensures one.
   */
  attachOnly?: boolean;
  /**
   * False for an open Studio restored by itself (a reload or a return to the
   * conversation with the browser left open): it never starts the space's
   * machine until the person presses Retry. A press, a link or a card that
   * opens the browser leaves it true.
   */
  openedByPerson?: boolean;
  /** Some run is actively progressing in this space. */
  spaceBusy?: boolean;
  /**
   * The approval lane of the conversation's running Instafy's browser job
   * (see useChatSharedBrowserApproval) and its machine, lowercased.
   */
  runApproval?: { runtimeId: string; approval: SharedBrowserApprovalState } | null;
  /**
   * The chat this browser view belongs to. A still picture kept from one chat
   * never shows in another.
   */
  conversationId?: string | null;
  /**
   * A browser turn of this chat on its way, with the site its card named:
   * over a blank tab the stage says where Octo is going until its first page.
   */
  agentArrival?: BrowserTurnArrival | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerNode, setContainerNode] = useState<HTMLDivElement | null>(null);
  const [mobileKeyboardOccupiedHeight, setMobileKeyboardOccupiedHeight] = useState(0);
  const dockedRootRef = useRef<HTMLElement | null>(null);
  const rfbRef = useRef<BrowserSessionRfbLike | null>(null);
  const generatedBrowserSessionId = useMemo(() => generateUUID(), []);
  const browserSessionId = suppliedBrowserSessionId?.trim() || generatedBrowserSessionId;
  const browserDataClearInFlightRef = useRef(false);
  const browserConnectionGenerationRef = useRef(0);
  const [browserDataClearInFlight, setBrowserDataClearInFlight] = useState(false);
  const [collaborationWsUrl, setCollaborationWsUrl] = useState<string | null>(null);
  const [collaborationConnectionKey, setCollaborationConnectionKey] =
    useState<string | null>(null);
  const sharedBrowserViewportOnly = sharedBrowserChrome !== null;
  const sharedBrowserActivePage =
    sharedBrowserChrome?.pages.find((page) => page.isActive) ??
    sharedBrowserChrome?.pages[0] ??
    null;
  const sharedBrowserPageId = sharedBrowserActivePage?.id ?? null;
  // Where the page on screen is now. A still picture of it is kept only
  // while it stays there: a picture of another address, such as the page an
  // earlier turn left, is never shown under this one.
  const sharedBrowserPageUrl = sharedBrowserActivePage?.url ?? null;
  // The roster belongs to the browser, not to a tab: it stays connected while
  // Studio's tab list is empty or reloading (a page id follows by heartbeat).
  // Tying it to the list made a loop: a view that showed an error emptied the
  // list, the roster closed, its absence read as "connecting", the list came
  // back, the roster opened, and the error came back, ten times a second.
  const collaboration = useSharedBrowserCollaboration({
    active:
      isOpen &&
      transportActive &&
      !browserDataClearInFlight &&
      sharedBrowserViewportOnly,
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
  const remoteController = remoteSharedBrowserController(collaboration.client, effectiveAgentControlOwner);
  const presenceStatus: SharedBrowserPresence["status"] =
    collaboration.client.connectionStatus === "connected" && collaboration.client.participantId && collaboration.client.state
      ? "known"
      : collaboration.client.connectionStatus === "error" ? "unavailable" : "unknown";
  const othersPresent = Boolean(collaboration.client.participantId && collaboration.client.state?.participants.some(
    (participant) => participant.id !== collaboration.client.participantId,
  ));
  const remoteControllerPresent = remoteController !== null;
  useEffect(() => {
    onPresenceChange?.({ status: presenceStatus, othersPresent, remoteController: remoteControllerPresent });
  }, [onPresenceChange, othersPresent, presenceStatus, remoteControllerPresent]);
  useEffect(() => () => onPresenceChange?.(null), [onPresenceChange]);
  const humanOwnsBrowserControl =
    canControlBrowser && collaborationSelfOwnsControl(collaboration.client) && controlOwner.kind === "human";
  const humanInputEnabled =
    humanOwnsBrowserControl && sharedBrowserHumanInputEnabled({ controlOwner, transportActive });
  const inputAuthorityKey = effectiveAgentControlOwner
    ? `agent:${effectiveAgentControlOwner.displayName}`
    : collaboration.client.state?.controlOwner?.kind === "human"
      ? `human:${collaboration.client.state.controlOwner.participantId}`
      : collaboration.client.state
        ? "none"
        : null;
  // Who controls the browser as this render sees it, for the debug log of a
  // new viewer target (a viewer that rebuilds as control changes hands).
  const controlDebugRef = useRef<Record<string, unknown>>({});
  controlDebugRef.current = {
    humanInputEnabled,
    collaborationSelfOwnsControl: collaborationSelfOwnsControl(collaboration.client),
    collaborationConnectionStatus: collaboration.client.connectionStatus,
    controlOwnerKind: controlOwner.kind,
    serverAgentOwner: serverAgentOwner?.displayName ?? null,
  };
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
  // When automatic reconnects were scheduled lately: a connection that comes
  // up between them does not give the lane a fresh budget.
  const reconnectTimesRef = useRef<number[]>([]);
  // The current wait is an automatic reconnect, not a person's Retry or press.
  const automaticReconnectRef = useRef(false);
  // The connection attempt on its way, so the reconnect deadline can stop it.
  const connectAttemptAbortRef = useRef<AbortController | null>(null);
  // Instafy's browser this view connected to: its machine and the host's
  // `generation`, which is new for every start of the browser.
  const connectedHostRef = useRef<{ runtimeId: string; generation: string | null } | null>(null);
  // Reconnects fatal viewer errors asked for lately (see FATAL_VIEWER_ERROR_WINDOW_MS).
  const fatalViewerErrorsRef = useRef<{ count: number; lastAtMs: number }>({ count: 0, lastAtMs: 0 });
  const [status, setStatus] = useState<BrowserSessionStatus>("idle");
  // The error on screen and why it happened (see hostedBrowserViewState);
  // `error` is its raw reason.
  const [failure, setFailure] = useState<HostedBrowserFailure | null>(null);
  const error = failure?.reason ?? null;
  // A press's start of the space's machine has taken over a minute: the view
  // says the machine is still starting. The machine coming up, and each
  // attempt, error and connection, clears it.
  const [machineStartSlow, setMachineStartSlow] = useState(false);
  // A browser session machine is starting its boot-time browser again after
  // it stopped: the view says so while the attempt waits for it.
  const [browserRestarting, setBrowserRestarting] = useState(false);
  const [runtimeLimitDetails, setRuntimeLimitDetails] =
    useState<HostedRuntimeLimitErrorDetails | null>(null);
  // `viewOnly`: an RFB address is for its view-only lane (see rfbViewOnlyLane).
  const [resolvedViewerUrl, setResolvedViewerUrl] = useState<{
    kind: SupportedSharedBrowserViewerKind; url: string | null; viewOnly: boolean;
  } | null>(null);
  const wsUrl = resolvedViewerUrl?.url ?? null;
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
  const ensureSpaceMachineRef = useRef(ensureSpaceMachine);
  const conversationRuntimeIdRef = useRef(conversationRuntimeId);
  const attachOnlyRef = useRef(attachOnly);
  const openedByPersonRef = useRef(openedByPerson);
  // Every connection attempt has its own number (`connectAttempt`). The
  // attempt the person's own action asked for (Retry, Try again, Clear data, a
  // press on a card) may start the space's machine even when the open itself
  // was automatic (`attachOnly`) or restored; that press counts for its own
  // attempt only, never for a later automatic reconnect. An attempt Studio
  // asked for by itself (`autoAttachToken`) never starts the machine. Both are
  // forgotten when the browser closes or its scope changes.
  const connectAttemptCounterRef = useRef(0);
  const pressedAttemptRef = useRef<number | null>(null);
  const studioAttemptRef = useRef<number | null>(null);
  ensureSpaceMachineRef.current = ensureSpaceMachine;
  conversationRuntimeIdRef.current = conversationRuntimeId;
  attachOnlyRef.current = attachOnly;
  openedByPersonRef.current = openedByPerson;
  preferRuntimeIdRef.current = preferRuntimeId;
  humanInputEnabledRef.current = humanInputEnabled;
  webRtcConnectionRef.current = webRtcConnection;
  browserOriginConnectionRef.current = browserOriginConnection;
  const [viewerOverride, setViewerOverride] =
    useState<SupportedSharedBrowserViewerKind | null>(null);
  const [connectAttempt, setConnectAttempt] = useState(0);
  const startAttempt = useCallback((by: "press" | "studio" | null = null) => {
    connectAttemptCounterRef.current += 1;
    const attempt = connectAttemptCounterRef.current;
    if (by === "press") pressedAttemptRef.current = attempt;
    if (by === "studio") studioAttemptRef.current = attempt;
    setMachineStartSlow(false);
    setBrowserRestarting(false);
    setConnectAttempt(attempt);
  }, []);
  // Forgets the connection this view had, and with it everything that used
  // it: the picture and input sockets, the collaboration socket, the approval
  // poll and the grant refresh. Every exit that ends in an error, a restart or
  // a deadline goes through it, so nothing keeps calling an origin the
  // runtime no longer has.
  const dropConnection = useCallback(() => {
    browserOriginConnectionRef.current = null;
    setBrowserOriginConnection(null);
    setResolvedViewerUrl(null);
    setBrowserInputWsUrl(null);
    setCollaborationWsUrl(null);
    setCollaborationConnectionKey(null);
    setWebRtcConnection(null);
    webRtcConnectionRef.current = null;
    webRtcProjectIdRef.current = null;
  }, []);
  // Ends the attempt with an error: a reconnect on its way and the attempt
  // itself stop (a late answer does not bring the wait back), and the
  // connection is dropped.
  const fail = useCallback((kind: HostedBrowserErrorKind, reason: string) => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    browserConnectionGenerationRef.current += 1;
    connectAttemptAbortRef.current?.abort();
    connectAttemptAbortRef.current = null;
    dropConnection();
    setStatus("error");
    setFailure({ kind, reason });
    setMachineStartSlow(false);
    setBrowserRestarting(false);
    runtimeDebugLog("browser-session:failed", { kind, reason });
  }, [dropConnection]);
  const [hasConnectedOnce, setHasConnectedOnce] = useState(false);
  const [capturedFrameUrl, setFrozenFrameUrl] = useState<string | null>(null);
  const capturedFrameScopeRef = useRef<string | null>(null);
  const paintedFrameScopeRef = useRef<string | null>(null);
  const paintedFrameSurfaceRef = useRef<HTMLCanvasElement | HTMLVideoElement | null>(null);
  const framePaintEpochRef = useRef(0);
  const clearRetainedBrowserFrame = useCallback(() => {
    framePaintEpochRef.current += 1;
    capturedFrameScopeRef.current = null;
    paintedFrameScopeRef.current = null;
    paintedFrameSurfaceRef.current = null;
    setFrozenFrameUrl(null);
  }, []);
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
  const selectionScope = `${currentUserId ?? ""}:${projectId ?? ""}:${resumeRuntimeId ?? ""}`;
  const selectionScopeRef = useRef(selectionScope);
  selectionScopeRef.current = selectionScope;
  const pinnedSessionRef = useRef<{ scope: string; runtimeId: string } | null>(null);
  const [runtimeChoice, setRuntimeChoice] = useState<{ scope: string; runtimeId: string } | null>(null);
  const [sessionIdentity, setSessionIdentity] = useState<{ scope: string; runtimeId: string } | null>(null);
  const [sessionChooserOpen, setSessionChooserOpen] = useState(false);
  // Set while the open session is Instafy's browser on the space's own
  // machine ("attach mode"): no new sessions, no runtime-limit takeover, and
  // Clear data restarts that same machine.
  const [hostAttach, setHostAttach] = useState<{ scope: string; runtimeId: string } | null>(null);
  const attachMode = hostAttach?.scope === selectionScope;
  const sessionControlsVisible = isOpen && transportActive;
  useLayoutEffect(() => {
    // The browser stays mounted while Chat or another resource is selected.
    // Its portalled menu must not outlive the visible toolbar that anchors it.
    if (!sessionControlsVisible) setSessionChooserOpen(false);
  }, [sessionControlsVisible]);
  const [sessionChoices, setSessionChoices] = useState<{
    scope: string; candidates: BrowserRuntimeCandidate[]; loading: boolean; error: string | null;
  }>({ scope: selectionScope, candidates: [], loading: false, error: null });
  useLayoutEffect(() => {
    // A previous account/project/link cannot carry its explicit creation or
    // selection request into the new authenticated surface.
    setForcedRuntimeId(null);
    setRuntimeChoice(null);
    setSessionIdentity(null);
    setSessionChooserOpen(false);
    setHostAttach(null);
    pinnedSessionRef.current = null;
    pressedAttemptRef.current = null;
    studioAttemptRef.current = null;
    connectedHostRef.current = null;
  }, [selectionScope]);
  const chosenRuntimeId = runtimeChoice?.scope === selectionScope ? runtimeChoice.runtimeId : null;
  const selectedSessionRuntimeId = sessionIdentity?.scope === selectionScope ? sessionIdentity.runtimeId : null;
  const frameRuntimeId = browserOriginConnection?.runtimeId ?? selectedSessionRuntimeId;
  const frameOriginRef = useRef<{ runtimeId: string; originId: string } | null>(null);
  if (browserOriginConnection) frameOriginRef.current = {
    runtimeId: browserOriginConnection.runtimeId,
    originId: browserOriginConnection.originId,
  };
  const frameOriginId = frameOriginRef.current?.runtimeId === frameRuntimeId ? frameOriginRef.current.originId : null;
  const frameScope = JSON.stringify([currentUserId, projectId, browserSessionId,
    resumeRuntimeId, preferRuntimeId, forcedRuntimeId,
    frameRuntimeId, frameOriginId, sharedBrowserPageId]);
  const frameScopeRef = useRef(frameScope);
  frameScopeRef.current = frameScope;
  // A still is shown only for the chat and the address it was taken on, so
  // a page an earlier chat or step left never shows under another one. The
  // surface that painted stays a source for a new still: a screencast keeps
  // its connection while its tab moves on.
  const stillScope = JSON.stringify([frameScope, conversationId, sharedBrowserPageUrl]);
  const stillScopeRef = useRef(stillScope);
  stillScopeRef.current = stillScope;
  const retainFrameRef = useRef(isOpen);
  retainFrameRef.current = isOpen && !browserDataClearInFlight;
  const frozenFrameUrl = isOpen && capturedFrameScopeRef.current === stillScope ? capturedFrameUrl : null;
  useEffect(clearRetainedBrowserFrame, [clearRetainedBrowserFrame, frameScope, isOpen]);
  useEffect(() => {
    if (capturedFrameScopeRef.current !== null && capturedFrameScopeRef.current !== stillScope) {
      capturedFrameScopeRef.current = null;
      setFrozenFrameUrl(null);
    }
  }, [stillScope]);

  // The conversation's own approval lane, keyed on its running job's machine
  // and page, stands in for this view's own poll when it is for this view's
  // machine: the sheet then keeps working while this view reconnects or
  // failed, and it shares its state with the chat card, so one answer
  // settles both.
  const viewRuntimeId = (browserOriginConnection?.runtimeId ?? selectedSessionRuntimeId)?.toLowerCase() ?? null;
  const runApprovalApplies = Boolean(runApproval) && (!viewRuntimeId || viewRuntimeId === runApproval?.runtimeId);
  const ownSharedBrowserApproval = useSharedBrowserApproval({
    // The signed origin marker/request remains authoritative even if the user
    // switches conversations or hides the Shared transport. The endpoint is
    // initiator-scoped, so a writable mounted surface can safely keep polling.
    active: isOpen && canControlBrowser && !browserDataClearInFlight && !runApprovalApplies,
    // Prompts are raised only inside a run; with none, a slow safety read.
    runActive: spaceBusy || effectiveAgentControlOwner !== null,
    projectId: browserOriginConnection?.projectId ?? projectId,
    browserSessionId,
    runtimeId: browserOriginConnection?.runtimeId ?? null,
    browserPageId: sharedBrowserPageId,
    originEndpoint: browserOriginConnection?.endpoint ?? null,
    originAccessToken: browserOriginConnection?.accessToken ?? null,
  });
  const sharedBrowserApproval =
    runApprovalApplies && runApproval && canControlBrowser && !browserDataClearInFlight
      ? runApproval.approval
      : ownSharedBrowserApproval;
  const sharedBrowserApprovalRequest = sharedBrowserApproval.pending?.request ?? null;
  useEffect(() => {
    onApprovalPendingChange?.(Boolean(sharedBrowserApproval.pending));
  }, [onApprovalPendingChange, sharedBrowserApproval.pending]);
  useEffect(
    () => () => {
      onApprovalPendingChange?.(false);
    },
    [onApprovalPendingChange],
  );
  const sessionResumeUrl = useMemo(() => projectId && selectedSessionRuntimeId
    ? buildSharedBrowserResumeUrl(resolvePublicAppUrl("/studio"), { projectId, runtimeId: selectedSessionRuntimeId })
    : null, [projectId, selectedSessionRuntimeId]);
  const refreshSessionChoices = useCallback(async () => {
    if (!projectId) return;
    const scope = selectionScope;
    setSessionChoices((current) => ({ scope, candidates: current.scope === scope ? current.candidates : [], loading: true, error: null }));
    try {
      const snapshot = await controllerClient.runtimes.fetchStatus({ projectId });
      if (selectionScopeRef.current !== scope) return;
      if (!snapshot || !Array.isArray(snapshot.runtimes)) throw new Error("Session discovery is unavailable.");
      setSessionChoices({ scope, candidates: listBrowserRuntimeCandidates(snapshot.runtimes), loading: false, error: null });
    } catch {
      if (selectionScopeRef.current === scope) {
        setSessionChoices({ scope, candidates: [], loading: false, error: "Could not load Shared sessions. Try refreshing." });
      }
    }
  }, [projectId, selectionScope]);
  const chooseSession = useCallback((runtimeId: string) => {
    // Only a currently discovered project session can be selected here. The
    // controller independently reauthorizes the exact runtime at connection.
    if (sessionChoices.scope !== selectionScope || !sessionChoices.candidates.some((item) => item.runtimeId === runtimeId)) return;
    setRuntimeChoice({ scope: selectionScope, runtimeId });
    pinnedSessionRef.current = { scope: selectionScope, runtimeId };
    setSessionIdentity({ scope: selectionScope, runtimeId });
    setForcedRuntimeId(null);
    setSessionChooserOpen(false);
    startAttempt();
  }, [selectionScope, sessionChoices, startAttempt]);
  const startNewSession = useCallback(() => {
    if (attachMode || !canControlBrowser || !projectId || !window.confirm("Start a separate Shared Browser session? This does not close another running session. Saved logins are restored only when this space has persistence enabled.")) return;
    setSessionChooserOpen(false);
    setSessionChoices({ scope: selectionScope, candidates: [], loading: false, error: null });
    setForcedRuntimeId(generateUUID());
    startAttempt();
  }, [attachMode, canControlBrowser, projectId, selectionScope, startAttempt]);
  // The runtime serves RFB's view-only lane: a person who does not drive
  // still watches the page over RFB, with their input dropped by the origin.
  const rfbViewOnlyAvailable = sharedBrowserRfbCapabilities?.viewOnly === true;
  const permittedSharedBrowserViewerKinds = useMemo(
    () =>
      humanOwnsBrowserControl || rfbViewOnlyAvailable
        ? sharedBrowserAvailableViewerKinds
        : sharedBrowserAvailableViewerKinds.filter((kind) => kind !== "rfb"),
    [humanOwnsBrowserControl, rfbViewOnlyAvailable, sharedBrowserAvailableViewerKinds],
  );
  const requestedSharedBrowserViewerKind = viewerOverride ?? sharedBrowserViewerKind;
  const participantViewerKind = resolveSharedBrowserViewerForParticipant({
    requested: requestedSharedBrowserViewerKind,
    available: sharedBrowserAvailableViewerKinds,
    // Hiding the surface disables input; it does not change who owns the page.
    humanOwnsControl: humanOwnsBrowserControl,
    rfbViewOnly: rfbViewOnlyAvailable,
  });
  // The collaboration roster intentionally disconnects while hidden. Its idle
  // state must not select another renderer behind the retained view. Input and
  // RFB admission still use fresh ownership and visibility above.
  const retainedViewerRef = useRef({ scope: frameScope, kind: participantViewerKind });
  if (transportActive || retainedViewerRef.current.scope !== frameScope) {
    retainedViewerRef.current = { scope: frameScope, kind: participantViewerKind };
  }
  const activeSharedBrowserViewerKind = transportActive ? participantViewerKind : retainedViewerRef.current.kind;
  // RFB for a person who does not drive (Octo, or another person, does): the
  // view-only lane, which follows the tab Octo works in. Like the driver's
  // lane, it is open only while the view is shown.
  const rfbViewOnlyLane = transportActive &&
    activeSharedBrowserViewerKind === "rfb" && rfbViewOnlyAvailable && !humanInputEnabled;
  const rfbViewOnlyLaneRef = useRef(rfbViewOnlyLane);
  rfbViewOnlyLaneRef.current = rfbViewOnlyLane;
  const sharedBrowserConnectionPageId =
    activeSharedBrowserViewerKind === "rfb" ? null : sharedBrowserPageId;
  // URL resolution follows renderer selection in an effect. Never mount the
  // newly selected protocol with the previous renderer's URL in between, nor
  // one RFB lane with the other's: control changing hands switches the lane.
  const resolvedSharedBrowserViewerKind = resolvedViewerUrl?.kind === activeSharedBrowserViewerKind &&
    (activeSharedBrowserViewerKind !== "rfb" || resolvedViewerUrl.viewOnly === rfbViewOnlyLane)
    ? activeSharedBrowserViewerKind : null;
  // The viewer this render mounts (its kind and URL), or null when none is.
  const mountedViewerTargetRef = useRef<string | null>(null);
  mountedViewerTargetRef.current =
    resolvedSharedBrowserViewerKind && wsUrl ? `${resolvedSharedBrowserViewerKind}\n${wsUrl}` : null;
  const webRtcIceServers =
    sharedBrowserWebRtcCapabilities?.iceServers ?? EMPTY_WEBRTC_ICE_SERVERS;
  const webRtcRelayOnly = sharedBrowserWebRtcCapabilities?.relayOnly ?? false;
  const limitDetails = useMemo(
    () => parseHostedRuntimeLimitError(error, runtimeLimitDetails),
    [error, runtimeLimitDetails],
  );
  // Instafy's browser on the space's own machine never takes over another
  // machine's slot, so attach mode has no limit takeover.
  const limitReached = !attachMode && limitDetails.limitReached;
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
  const hasTakeoverBlocker = !attachMode && Boolean(limitDetails.blockerRuntimeId);
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
      "!h-full !w-screen !max-w-none !rounded-none !border-0 !shadow-none !overflow-hidden",
    [],
  );
  const fullscreenDialogClassName = useMemo(
    // The overlay is edge-to-edge, but controls must clear native window
    // chrome and mobile cutouts. Keep the insets inside the painted modal.
    () => "!m-0 !h-full !w-full !border-0 !outline-none pt-[var(--instafy-safe-area-inset-top)] pb-[var(--instafy-safe-area-inset-bottom)] pl-[var(--instafy-safe-area-inset-left)] pr-[var(--instafy-safe-area-inset-right)]",
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
  const expandedViewportStyle = useExpandedBrowserViewport(isOpen && renderFullscreen);
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
  // The one state on screen: one sentence, one button, one pill.
  const viewState = hostedBrowserViewState({
    status: displayStatus,
    failure,
    hasConnection: browserOriginConnection !== null,
    machineStartSlow,
    browserRestarting,
  });
  const viewLive = viewState.kind === "live";
  const viewKindRef = useRef(viewState.kind);
  viewKindRef.current = viewState.kind;
  const shouldCollapseDocked =
    displayStatus !== "selecting" &&
    (shouldUseDesktopDockedCard || (shouldViewportCollapseDocked && displayStatus !== "connected"));
  // Tail the agent's browser actions while the live view is shown, so we can draw
  // the AI cursor and caption what it's doing. Gated to match where the overlay
  // renders (connected and not collapsed) so a hidden/collapsed session doesn't
  // keep polling. Uses the same runtime the VNC stream resolved to.
  const { actions: browserActions, latestClick: browserLatestClick, logSeq: browserLogSeq } = useBrowserSessionActions({
    enabled:
      isOpen &&
      !browserDataClearInFlight &&
      displayStatus === "connected" &&
      !shouldCollapseDocked,
    browserSessionId,
    projectId,
    preferRuntimeId: forcedRuntimeId ?? preferRuntimeId,
    pageId: sharedBrowserPageId,
    transportActive,
    // Only the agent writes the log: tail it every second only while it may.
    agentActive: spaceBusy || effectiveAgentControlOwner !== null,
  });
  // The caption of Octo's latest step shows only while Octo holds the
  // browser, and only for steps of this hold: never a step an earlier turn
  // left in the log, and never once the turn has ended. The floor is the
  // newest step in the log before the hold, or, when this view first reads
  // the log during the hold (it opened then), the newest step it found.
  const agentActionFloorRef = useRef<number | null>(null);
  if (!effectiveAgentControlOwner || agentActionFloorRef.current === null) {
    agentActionFloorRef.current = browserLogSeq ?? null;
  }
  const agentActionFloor = agentActionFloorRef.current;
  // The ticker keys on its latest action, which filtering keeps as the same
  // object, so a re-render does not re-arm it.
  const agentTurnActions = effectiveAgentControlOwner && agentActionFloor !== null
    ? browserActions.filter((action) => action.seq > agentActionFloor)
    : [];
  const browserHumanInputOptions = {
    identityKey: `${humanInputIdentityKey ?? ""}:${browserSessionId}:${forcedRuntimeId ?? preferRuntimeId}:${sharedBrowserPageId}`,
    request: selectSharedBrowserHumanInput(
      browserActions, currentUserId, sharedBrowserPageId,
      browserPageOrigin(sharedBrowserChrome?.pages.find((page) => page.id === sharedBrowserPageId)?.url),
      humanInputRunIds,
    ),
    canTakeOver: transportActive && canControlBrowser && Boolean(effectiveAgentControlOwner && onTakeOverAgent),
    humanControlConfirmed: humanInputEnabled,
    canContinue: transportActive && Boolean(onContinueAfterHumanInput),
    onTakeOver: async () => onTakeOverAgent
      ? onTakeOverAgent({ agentHoldsBrowser: effectiveAgentControlOwner !== null })
      : false,
    onContinue: async (message: string) => onContinueAfterHumanInput ? onContinueAfterHumanInput(message) : false,
  };
  const browserHumanInputState = useBrowserHumanInput(browserHumanInputOptions);
  // The pages the agent is reading while it holds this browser: its own tabs
  // and the tab its run is bound to. Take over there is the same action as
  // the toolbar's, and the origin's runtime-wide agent marker it ends covers
  // every tab.
  const agentReadingPages = resolveAgentReadingPages({
    pages: sharedBrowserChrome?.pages ?? [],
    agentControlActive: effectiveAgentControlOwner !== null,
    agentPageIds: sharedBrowserChrome?.agentPageIds,
  });
  const collapsedCardMode = shouldCollapseDocked
    ? error
      ? limitReached
        ? "limit"
        : "error"
      : viewLive
        ? "connected"
      : "connecting"
    : null;
  const compactRecovery = collapsedCardMode === "error" || collapsedCardMode === "limit";
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
    const frameScope = frameScopeRef.current;
    if (!retainFrameRef.current ||
        paintedFrameScopeRef.current !== frameScope || browserDataClearInFlightRef.current) return;
    // A fallback can mount a new blank surface for the same page. Only the
    // exact renderer that supplied pixels may replace the retained picture.
    const surface = paintedFrameSurfaceRef.current;
    if (!surface || !containerRef.current?.contains(surface)) {
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
      const url = snapshot.toDataURL("image/jpeg", 0.78);
      capturedFrameScopeRef.current = stillScopeRef.current;
      setFrozenFrameUrl(url);
    } catch {
      // A frozen frame is a visual optimization; transport fallback still works
      // when a platform refuses to snapshot its current video surface.
    }
  }, []);

  const retryConnection = useCallback(() => {
    // Only the person's own actions call this (Open browser, Try again, Clear
    // data); automatic reconnects schedule their own attempt.
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    autoRetryCountRef.current = 0;
    reconnectTimesRef.current = [];
    automaticReconnectRef.current = false;
    fatalViewerErrorsRef.current = { count: 0, lastAtMs: 0 };
    setRuntimeLimitActionBusy(false);
    setStatus("connecting");
    setFailure(null);
    setRuntimeLimitDetails(null);
    setHasConnectedOnce(false);
    if (connectedScopeKey) {
      connectedBrowserSessionScopes.delete(connectedScopeKey);
    }
    setResolvedViewerUrl(null);
    setBrowserInputWsUrl(null);
    setWebRtcConnection(null);
    setViewerOverride(null);
    startAttempt("press");
    runtimeDebugLog("browser-session:retry", {
      projectId,
      preferRuntimeId,
      forcedRuntimeId,
    });
  }, [connectedScopeKey, forcedRuntimeId, preferRuntimeId, projectId, startAttempt]);
  const scheduleReconnectAttempt = useCallback(
    (reason: "disconnect" | "connect_failure", debugWsUrl: string): boolean => {
      if (browserDataClearInFlightRef.current) {
        runtimeDebugLog("browser-session:reset-suppressed-reconnect", {
          reason,
          projectId,
        });
        return true;
      }
      // A reconnect is already on its way: a second report of the same
      // failure (an error, then the socket closing) does not count twice.
      if (reconnectTimerRef.current !== null) {
        return true;
      }
      const nowMs = Date.now();
      const recentReconnects = reconnectTimesRef.current.filter(
        (atMs) => nowMs - atMs < FATAL_VIEWER_ERROR_WINDOW_MS,
      );
      if (
        autoRetryCountRef.current < MAX_AUTO_CONNECT_RETRIES &&
        recentReconnects.length < MAX_AUTO_CONNECT_RETRIES
      ) {
        reconnectTimesRef.current = [...recentReconnects, nowMs];
        automaticReconnectRef.current = true;
        freezeCurrentBrowserFrame();
        autoRetryCountRef.current += 1;
        const retryCount = autoRetryCountRef.current;
        const delayMs = Math.min(AUTO_CONNECT_RETRY_BASE_DELAY_MS * retryCount, 5000);
        setStatus("connecting");
        setFailure(null);
        if (reconnectTimerRef.current !== null) {
          window.clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          startAttempt();
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
      // A failed reconnect must never silently become a different browser.
      // Starting a replacement is an explicit action in Sessions & resume.
      return false;
    },
    [
      activeSharedBrowserViewerKind,
      forcedRuntimeId,
      freezeCurrentBrowserFrame,
      projectId,
      startAttempt,
    ],
  );
  const fallBackFromViewer = useCallback(
    (reason: string): boolean => {
      if (browserDataClearInFlightRef.current) {
        runtimeDebugLog("browser-session:reset-suppressed-fallback", {
          reason,
          projectId,
        });
        return true;
      }
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
      setFailure(null);
      setResolvedViewerUrl(null);
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
      projectId,
    ],
  );
  // A separate browser session claims the project's runtime while open, so
  // generic recovery stands down while its ensure, takeover or recycle runs.
  // Attach mode claims only while Clear data runs (the controller fails the
  // reset if a managed machine relaunches before its recheck): otherwise
  // generic recovery keeps the space's own machine up, and the cold path
  // relies on the generic ensure.
  const browserRuntimeClaimRef = useRef<{ projectId: string; release: () => void } | null>(null);
  const releaseBrowserRuntimeClaim = useCallback(() => {
    const claim = browserRuntimeClaimRef.current;
    browserRuntimeClaimRef.current = null;
    claim?.release();
  }, []);
  const holdBrowserRuntimeClaim = useCallback((claimProjectId: string) => {
    if (browserRuntimeClaimRef.current?.projectId === claimProjectId) return;
    browserRuntimeClaimRef.current?.release();
    browserRuntimeClaimRef.current = {
      projectId: claimProjectId,
      release: beginBrowserRuntimeClaim(claimProjectId),
    };
  }, []);
  const handleBrowserDataClearStart = useCallback(() => {
    // Keep generic recovery from relaunching the space's machine between the
    // controller's stop and its recheck. The retry after the clear releases
    // it again on the attach or cold path.
    if (projectId) holdBrowserRuntimeClaim(projectId);
    setSessionChooserOpen(false);
    browserDataClearInFlightRef.current = true;
    browserConnectionGenerationRef.current += 1;
    setBrowserDataClearInFlight(true);
    // A reconnect may preserve the last frame, but an explicit privacy reset
    // must not keep showing the authenticated page whose data is being erased.
    clearRetainedBrowserFrame();
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    autoRetryCountRef.current = 0;
    setHasConnectedOnce(false);
    if (connectedScopeKey) {
      connectedBrowserSessionScopes.delete(connectedScopeKey);
    }
    setStatus("connecting");
    setFailure(null);
    setRuntimeLimitDetails(null);
    dropConnection();
    runtimeDebugLog("browser-session:reset-start", { projectId });
  }, [clearRetainedBrowserFrame, connectedScopeKey, dropConnection, holdBrowserRuntimeClaim, projectId]);
  const handleBrowserDataClearSettled = useCallback(
    (succeeded: boolean) => {
      browserDataClearInFlightRef.current = false;
      setBrowserDataClearInFlight(false);
      if (succeeded && !attachMode) {
        // Use a new ensure identity so a just-completed reset cannot reuse an
        // in-flight/coalesced ensure for the runtime that the controller stopped.
        setForcedRuntimeId(generateUUID());
      }
      // In attach mode the controller stopped this space's own machine. The
      // retry below finds the same runtime stopped and starts it again (the
      // cold path), so Studio keeps that runtime id.
      runtimeDebugLog("browser-session:reset-settled", {
        projectId,
        succeeded,
        attachMode,
      });
      // The reset endpoint may have stopped the viewer even when it returns an
      // error. Retry exactly once after either outcome to restore a useful tab.
      retryConnection();
    },
    [attachMode, projectId, retryConnection],
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
      fail(
        "notice",
        message
          ? `Unable to stop the blocking runtime. ${message}`
          : "Unable to stop the blocking runtime.",
      );
      setRuntimeLimitDetails(null);
    } finally {
      setRuntimeLimitActionBusy(false);
    }
  }, [fail, limitDetails.blockerRuntimeId, retryConnection]);

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
      releaseBrowserRuntimeClaim();
      return;
    }
    // Claimed from open, as before; attach mode and the cold path release it
    // once the first status read shows they apply.
    holdBrowserRuntimeClaim(projectId);
    return releaseBrowserRuntimeClaim;
  }, [holdBrowserRuntimeClaim, isOpen, projectId, releaseBrowserRuntimeClaim]);

  useEffect(() => {
    if (!isOpen) {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      autoRetryCountRef.current = 0;
      reconnectTimesRef.current = [];
      automaticReconnectRef.current = false;
      connectedHostRef.current = null;
      setStatus("idle");
      setFailure(null);
      setMachineStartSlow(false);
      setRuntimeLimitDetails(null);
      setHasConnectedOnce(false);
      setFrozenFrameUrl(null);
      dropConnection();
      setViewerOverride(null);
      setRuntimeLimitActionBusy(false);
      setForcedRuntimeId(null);
      setHostAttach(null);
      pressedAttemptRef.current = null;
      studioAttemptRef.current = null;
      setDesktopDockedCard(false);
      setFullscreen(false);
      return;
    }

    if (browserDataClearInFlight) {
      return;
    }

    if (!projectId) {
      fail("failed", "Space is missing.");
      return;
    }
    // What started this attempt: an automatic reconnect never starts the
    // machine or its browser; an attempt Studio asked for by itself never
    // starts the machine; the person's press counts for its own attempt only.
    const automaticAttempt = automaticReconnectRef.current;
    const pressed = !automaticAttempt && pressedAttemptRef.current === connectAttempt;
    const startedByStudio = studioAttemptRef.current === connectAttempt;
    let cancelled = false;
    const connectionGeneration = browserConnectionGenerationRef.current;
    const connectionCancelled = () =>
      cancelled ||
      browserDataClearInFlightRef.current ||
      connectionGeneration !== browserConnectionGenerationRef.current;
    const startupAbortController = new AbortController();
    connectAttemptAbortRef.current = startupAbortController;
    const existingConnection = browserOriginConnectionRef.current;
    const exactRuntimeId = chosenRuntimeId ?? resumeRuntimeId ??
      (pinnedSessionRef.current?.scope === selectionScope ? pinnedSessionRef.current.runtimeId : null);
    const preservingConnection =
      existingConnection?.projectId === projectId &&
      (!exactRuntimeId || existingConnection.runtimeId === exactRuntimeId) &&
      (!forcedRuntimeId || existingConnection.runtimeId === forcedRuntimeId);
    if (!preservingConnection) {
      setStatus("connecting");
      setFailure(null);
      setRuntimeLimitDetails(null);
      dropConnection();
    }

    void (async () => {
      // When launched from the UI (or a tool call) we may not have a runtime yet.
      // Ensure a hosted runtime so we can route the browser session to it.
      const requestedPreferRuntimeId = preferRuntimeIdRef.current;
      let runtimeId: string | null = null;
      let originId: string | null = null;
      let originEndpoint: string | null = null;
      // A press's ensure, asked again once while the wait below finds the
      // machine silent past its idle time.
      let ensureAgain: (() => Promise<unknown>) | null = null;
      const statusSnapshot = await controllerClient.runtimes.fetchStatus({
        projectId,
        signal: startupAbortController.signal,
        quietOnAbort: true,
      }).catch(() => null);
      if (connectionCancelled()) {
        return;
      }
      const statusEntries = Array.isArray(statusSnapshot?.runtimes) ? statusSnapshot.runtimes : [];
      if (!statusSnapshot) {
        fail("failed", "Could not discover Shared sessions. Refresh sessions to retry.");
        setSessionChoices({ scope: selectionScope, candidates: [], loading: false, error: "Session discovery is unavailable; no new browser was started." });
        return;
      }
      const candidates = listBrowserRuntimeCandidates(statusEntries);
      setSessionChoices({ scope: selectionScope, candidates, loading: false, error: null });
      const hostPolicy = statusSnapshot.sharedBrowserHostPolicy ?? null;
      let attachHost = false;
      if (!forcedRuntimeId) {
        let selection = resolveBrowserRuntimeSelection(statusEntries, exactRuntimeId);
        if (selection.kind === "missing" && hostPolicy === "covered") {
          // A stale pin in a covered space: open the space's own live
          // browser instead, and re-pin it below.
          const liveHost = liveSharedBrowserHostCandidate(statusEntries);
          if (liveHost) selection = { kind: "selected", candidate: liveHost };
        }
        if (shouldStartSpaceMachineForBrowser({
          policy: hostPolicy,
          selection,
          exactRuntimeId,
          entries: statusEntries,
        })) {
          const ensureSpaceMachineForPress = ensureSpaceMachineRef.current;
          if (automaticAttempt || startedByStudio || (attachOnlyRef.current && !pressed)) {
            // An automatic reconnect, or Studio by itself: it never starts a
            // machine. The browser is off until a press opens it.
            releaseBrowserRuntimeClaim();
            fail("off", automaticAttempt
              ? "space machine not running; a reconnect does not start it"
              : "space machine not running; Studio opened this by itself");
            return;
          }
          const canStartSpaceMachine = canControlBrowser && Boolean(ensureSpaceMachineForPress);
          if (canStartSpaceMachine && !openedByPersonRef.current && !pressed) {
            // A restored open (a reload or a return to the conversation)
            // never wakes a machine that stopped while nobody was here.
            releaseBrowserRuntimeClaim();
            fail("off", "space machine not running; a restored open does not start it");
            return;
          }
          if (canStartSpaceMachine && ensureSpaceMachineForPress) {
            // The cold path: start this space's own machine for the press
            // and open its browser once it is up. The generic ensure skips
            // while a browser claim is held, so none is.
            releaseBrowserRuntimeClaim();
            runtimeDebugLog("browser-session:space-machine-cold-start", {
              projectId,
              exactRuntimeId,
            });
            const coldStart = await startSpaceMachineForBrowser({
              projectId,
              pinnedRuntimeId: exactRuntimeId,
              conversationRuntimeId: conversationRuntimeIdRef.current?.trim() || null,
              ensureSpaceMachine: ensureSpaceMachineForPress,
              fetchStatus: controllerClient.runtimes.fetchStatus,
              onSlow: () => {
                if (!connectionCancelled()) setMachineStartSlow(true);
              },
              signal: startupAbortController.signal,
            });
            if (connectionCancelled() || coldStart.kind === "cancelled") {
              return;
            }
            if (coldStart.kind === "error") {
              fail(coldStart.errorKind, coldStart.reason);
              return;
            }
            // The machine is up: what is left is opening its browser.
            setMachineStartSlow(false);
            if (coldStart.kind === "attach") {
              selection = { kind: "selected", candidate: coldStart.candidate };
              setSessionChoices({
                scope: selectionScope,
                candidates: candidates.some((item) => item.runtimeId === coldStart.candidate.runtimeId)
                  ? candidates
                  : [...candidates, coldStart.candidate],
                loading: false,
                error: null,
              });
            }
            // `legacy`: the machine came up without Instafy's browser on
            // demand, so the original selection goes on as before.
          }
        }
        if (selection.kind === "choose" || selection.kind === "missing" || (selection.kind === "new" && !canControlBrowser)) {
          holdBrowserRuntimeClaim(projectId);
          const message = selection.kind === "missing"
            ? "The requested Shared session is not available. Refresh or explicitly choose another session."
            : selection.kind === "new"
              ? "No Shared session is available. Ask a space builder to start one."
              : "Several Shared sessions are running. Choose the session to resume.";
          if (selection.kind === "choose") {
            dropConnection();
            setStatus("selecting");
            setFailure(null);
          } else {
            fail("notice", message);
          }
          // The choice waits behind Browser options (⋯): opening the
          // browser never opens that menu by itself.
          setSessionChoices({ scope: selectionScope, candidates, loading: false, error: message });
          return;
        }
        if (selection.kind === "selected") {
          const existingBrowserRuntime = selection.candidate;
          runtimeId = existingBrowserRuntime.runtimeId;
          originId = existingBrowserRuntime.originId;
          originEndpoint = existingBrowserRuntime.endpoint;
          attachHost = existingBrowserRuntime.mode === "lazy";
          runtimeDebugLog("browser-session:reuse-runtime", {
            projectId,
            runtimeId,
            originId,
            originEndpoint,
            mode: existingBrowserRuntime.mode,
          });
        }
      }
      if (attachHost && runtimeId) {
        releaseBrowserRuntimeClaim();
        setHostAttach({ scope: selectionScope, runtimeId });
      } else {
        holdBrowserRuntimeClaim(projectId);
        setHostAttach(null);
      }

      if (
        (!runtimeId || !originId) &&
        ((attachOnlyRef.current && !pressed) || ((automaticAttempt || startedByStudio) && !forcedRuntimeId))
      ) {
        // Studio opened this by itself, or it reconnects by itself: it never
        // ensures a browser runtime.
        releaseBrowserRuntimeClaim();
        fail("off", "no browser runtime is running; nothing starts one by itself");
        return;
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
              if (connectionCancelled()) {
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
            if (connectionCancelled()) {
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
          if (connectionCancelled()) {
            return;
          }
          runtimeId = ensured?.runtimeId ?? null;
          // Only the person's own open asks again; an automatic reconnect
          // or Studio by itself never does.
          if (runtimeId && !automaticAttempt && !startedByStudio) {
            const ensuredMachineId = runtimeId;
            ensureAgain = () => ensureBrowserRuntime(ensuredMachineId, false);
          }
          runtimeDebugLog("browser-session:ensure-runtime", {
            projectId,
            runtimeId,
            forcedRuntimeId,
            ensuredRuntimeId,
            preferRuntimeId: requestedPreferRuntimeId,
            requestedRfbRenderScale,
          });
        } catch (err) {
          if (connectionCancelled()) {
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          fail("failed", message || "Unable to start a runtime for the browser session.");
          setRuntimeLimitDetails(hostedRuntimeLimitDetailsFromError(err));
          return;
        }
      }

      if (!runtimeId) {
        fail("failed", "Browser session is unavailable (runtime id missing).");
        return;
      }

      if (!originId) {
        // The machine may be starting again (a relaunch, or a runtime that
        // restarted itself): wait until it answers, as the cold path does.
        const awaitedOrigin = await waitForBrowserRuntimeOrigin({
          projectId,
          runtimeId,
          fetchStatus: controllerClient.runtimes.fetchStatus,
          signal: startupAbortController.signal,
          onSlow: () => {
            if (!connectionCancelled()) setMachineStartSlow(true);
          },
          ...(ensureAgain ? { ensureAgain } : {}),
        });
        if (!connectionCancelled()) setMachineStartSlow(false);
        originId = awaitedOrigin.originId;
        originEndpoint = awaitedOrigin.endpoint;
        runtimeDebugLog("browser-session:wait-origin", {
          projectId,
          runtimeId,
          originId,
          originEndpoint,
        });
      }
      if (connectionCancelled()) {
        return;
      }
      if (!originId) {
        fail("failed", "Browser session is unavailable (runtime origin not ready yet).");
        return;
      }
      // The machine started again under a new origin: the connection this
      // view kept names an origin the runtime no longer has, so nothing (the
      // grant refresh, the collaboration socket, the approval poll) may keep
      // using it, whatever this attempt ends with.
      const keptConnection = browserOriginConnectionRef.current;
      if (keptConnection && keptConnection.runtimeId === runtimeId && keptConnection.originId !== originId) {
        clearRetainedBrowserFrame();
        dropConnection();
        runtimeDebugLog("browser-session:origin-replaced", { projectId, runtimeId });
      }

      onRuntimeIdResolved?.(runtimeId);
      pinnedSessionRef.current = { scope: selectionScope, runtimeId };
      setSessionIdentity({ scope: selectionScope, runtimeId });

      if (attachHost) {
        // Instafy's browser on the space's machine starts on demand: start
        // it when it is idle and wait until it is ready before any viewer or
        // capability-driven connection.
        const hostWait = await waitForSharedBrowserHostReady({
          projectId,
          runtimeId,
          browserSessionId,
          canControl: canControlBrowser,
          // An automatic reconnect never starts Instafy's browser.
          mayStart: !automaticAttempt,
          client: controllerClient.browserSessions,
          signal: startupAbortController.signal,
        });
        if (connectionCancelled() || hostWait.kind === "cancelled") {
          return;
        }
        runtimeDebugLog("browser-session:host-wait", {
          projectId,
          runtimeId,
          result: hostWait.kind,
        });
        if (hostWait.kind === "error") {
          fail(hostWait.errorKind, hostWait.reason);
          return;
        }
        const generation = hostWait.snapshot.generation;
        const connectedHost = connectedHostRef.current;
        const connectedGeneration = connectedHost?.runtimeId === runtimeId ? connectedHost.generation : null;
        if (connectedGeneration && generation && generation !== connectedGeneration && automaticReconnectRef.current) {
          // It started again while this view reconnected by itself: the
          // pages it showed are gone, so the browser this view had is off,
          // and it stops reconnecting until a press opens the new one.
          connectedHostRef.current = null;
          clearRetainedBrowserFrame();
          fail("off", "Instafy's browser started again on this space's machine");
          runtimeDebugLog("browser-session:host-restarted", { projectId, runtimeId });
          return;
        }
        const liveConnection = browserOriginConnectionRef.current;
        if (
          connectedGeneration &&
          generation === connectedGeneration &&
          preservingConnection &&
          mountedViewerTargetRef.current !== null &&
          liveConnection?.runtimeId === runtimeId &&
          liveConnection.originId === originId &&
          (liveConnection.expiresAtMs === null ||
            liveConnection.expiresAtMs - Date.now() > SHARED_BROWSER_CONNECTION_REUSE_MIN_REMAINING_MS)
        ) {
          // The same browser, and its viewer is still mounted: the viewer
          // reconnects by itself, so this keeps the connection, and with it
          // the last frame, as they are.
          runtimeDebugLog("browser-session:host-same-generation", { projectId, runtimeId });
          return;
        }
        connectedHostRef.current = { runtimeId, generation };
      } else {
        connectedHostRef.current = null;
        // A browser session machine starts its boot-time browser again when
        // it stops, and gives up after too many stops. Its origin says which
        // on a page read: wait while it starts again, and say when it gave
        // up, instead of connecting to a browser that is not there.
        const resolvedRuntimeId = runtimeId;
        const bootWait = await waitForBootBrowserRunning({
          probe: async (signal) => {
            try {
              await controllerClient.browserSessions.fetchPages({
                projectId,
                browserSessionId,
                preferRuntimeId: resolvedRuntimeId,
                signal,
              });
              return "running";
            } catch (cause) {
              return bootBrowserProbeFromError(cause, controllerClient.browserSessions.isUnavailableError);
            }
          },
          onRestarting: () => {
            if (!connectionCancelled()) setBrowserRestarting(true);
          },
          signal: startupAbortController.signal,
        });
        if (connectionCancelled() || bootWait.kind === "cancelled") {
          return;
        }
        setBrowserRestarting(false);
        runtimeDebugLog("browser-session:boot-browser-wait", { projectId, runtimeId, result: bootWait.kind });
        if (bootWait.kind === "stopped") {
          fail("blocked", SHARED_BROWSER_HOST_COPY.stoppedForGood);
          return;
        }
        if (bootWait.kind === "timeout") {
          fail("failed", "the machine did not start its browser again in time");
          return;
        }
      }

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
      if (connectionCancelled()) {
        return;
      }
      if (!token) {
        fail("failed", "Browser session is unavailable (origin token request failed).");
        return;
      }
      const endpoint = token.endpoint.trim() || originEndpoint;
      if (!endpoint) {
        fail("failed", "Browser session is unavailable (origin endpoint missing).");
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
      if (connectAttemptAbortRef.current === startupAbortController) {
        connectAttemptAbortRef.current = null;
      }
      // A start this attempt waited on is not the next attempt's.
      setMachineStartSlow(false);
    };
  }, [
    browserSessionId,
    browserDataClearInFlight,
    canControlBrowser,
    connectAttempt,
    forcedRuntimeId,
    chosenRuntimeId,
    isOpen,
    onRuntimeIdResolved,
    projectId,
    resumeRuntimeId,
    selectionScope,
    sharedBrowserCapabilitiesAvailable,
    sharedBrowserCapabilitiesResolved,
    holdBrowserRuntimeClaim,
    releaseBrowserRuntimeClaim,
    clearRetainedBrowserFrame,
    dropConnection,
    fail,
  ]);

  useEffect(() => {
    const connection = browserOriginConnection;
    if (
      !isOpen ||
      browserDataClearInFlight ||
      !connection ||
      !activeSharedBrowserViewerKind
    ) {
      setResolvedViewerUrl(null);
      setBrowserInputWsUrl(null);
      setWebRtcConnection(null);
      webRtcConnectionRef.current = null;
      webRtcProjectIdRef.current = null;
      return;
    }

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
              viewOnly: rfbViewOnlyLane,
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
      ...controlDebugRef.current,
    });
    // A viewer that keeps its URL does not connect again, so it would never
    // report again: only a new target is "connecting" (a reconnect attempt that
    // got the same cached grant leaves a connected viewer, or its error, alone).
    if (mountedViewerTargetRef.current !== `${activeSharedBrowserViewerKind}\n${url}`) {
      setStatus("connecting");
      setFailure(null);
    }
    setResolvedViewerUrl({
      kind: activeSharedBrowserViewerKind,
      url,
      viewOnly: activeSharedBrowserViewerKind === "rfb" && rfbViewOnlyLane,
    });
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
    browserDataClearInFlight,
    canControlBrowser,
    isOpen,
    rfbViewOnlyLane,
    sharedBrowserConnectionPageId,
  ]);

  // The grant refresh does not run while the view shows an error (each
  // error drops the connection anyway).
  const grantRefreshPaused = status === "error";
  const scheduleReconnectAttemptRef = useRef(scheduleReconnectAttempt);
  scheduleReconnectAttemptRef.current = scheduleReconnectAttempt;
  useEffect(() => {
    const connection = browserOriginConnection;
    if (!isOpen || browserDataClearInFlight || grantRefreshPaused || !connection?.expiresAtMs) {
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;
    let failures = 0;
    const connectionKey = `${connection.projectId}:${connection.runtimeId}:${connection.originId}`;

    const refreshToken = async () => {
      const result = await controllerClient.workspace.origin.requestAccessTokenResult({
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
      if (!result.ok) {
        const grantStatus = result.error.status;
        runtimeDebugLog("browser-session:grant-refresh-failed", {
          projectId: connection.projectId,
          runtimeId: connection.runtimeId,
          originId: connection.originId,
          status: grantStatus,
          code: result.error.code ?? null,
        });
        if (grantStatus === 400) {
          // The controller says this is not the runtime's online origin any
          // more (its machine started again): stop using it and look the
          // runtime's current origin up once. That reconnect is automatic, so
          // it never starts the machine or its browser.
          dropConnection();
          if (!scheduleReconnectAttemptRef.current("connect_failure", "")) {
            fail("failed", "origin grant refused (400); reconnects used");
          }
          return;
        }
        if (grantStatus === 404) {
          // The origin is gone: stop, without looking it up again, so nothing
          // starts the machine.
          fail("off", "origin grant refused (404); the origin is gone");
          return;
        }
        if (grantStatus === 401 || grantStatus === 403) {
          fail("failed", `origin grant refused (${grantStatus})`);
          return;
        }
        failures += 1;
        timerId = window.setTimeout(
          refreshToken,
          Math.min(
            BROWSER_ORIGIN_TOKEN_REFRESH_MAX_RETRY_MS,
            BROWSER_ORIGIN_TOKEN_REFRESH_RETRY_MS * 2 ** (failures - 1),
          ),
        );
        return;
      }
      failures = 0;
      const token = result.token;
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
  }, [
    browserDataClearInFlight,
    browserOriginConnection,
    browserSessionId,
    canControlBrowser,
    dropConnection,
    fail,
    grantRefreshPaused,
    isOpen,
  ]);

  // Once this browser has its connection, the wait for its roster (which
  // says which viewer this participant may use) is bounded. The roster
  // connects only while the view is on screen, so the wait runs only then: a
  // view Studio opened by itself with the person in Chat stays opening while
  // the card's turn goes on there.
  const viewerWaiting =
    isOpen &&
    transportActive &&
    !browserDataClearInFlight &&
    activeSharedBrowserViewerKind === null &&
    sharedBrowserCapabilitiesResolved &&
    sharedBrowserCapabilitiesAvailable &&
    !collaboration.client.state &&
    browserOriginConnection !== null;
  const [viewerWaitExpiredFor, setViewerWaitExpiredFor] = useState<BrowserOriginConnection | null>(null);
  const viewerWaitExpired = viewerWaiting && viewerWaitExpiredFor === browserOriginConnection;
  useEffect(() => {
    if (!viewerWaiting) return;
    const connection = browserOriginConnection;
    const timer = window.setTimeout(() => setViewerWaitExpiredFor(connection), SHARED_BROWSER_VIEWER_WAIT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [browserOriginConnection, viewerWaiting]);

  useEffect(() => {
    if (
      !isOpen ||
      browserDataClearInFlight ||
      activeSharedBrowserViewerKind !== null
    ) {
      return;
    }
    if (!sharedBrowserCapabilitiesResolved) {
      return;
    }
    if (sharedBrowserCapabilitiesAvailable && !collaboration.client.state) {
      // Only a view that has its connection waits for its roster here; one
      // without it is the attach's (or its error's) to show.
      if (!browserOriginConnection) {
        return;
      }
      if (viewerWaitExpired) {
        fail("failed", SHARED_BROWSER_VIEWER_WAIT_REASON);
        return;
      }
      setStatus("connecting");
      setFailure(null);
      return;
    }
    if (sharedBrowserCapabilitiesAvailable && canControlBrowser && remoteControllerPresent) {
      // Octo or another person drives a browser whose only viewer is the
      // controller's own lane. The browser is open and working; this person
      // has no picture until control comes back, so the view stays live with
      // the last frame and says who has control (Take over), as it does over
      // a picture.
      setStatus("connected");
      setFailure(null);
      return;
    }
    if (sharedBrowserCapabilitiesAvailable && canControlBrowser) {
      // Its roster is known: the person can ask for control with the
      // collaboration controls, so the connection stays.
      setStatus("error");
      setFailure({
        kind: "notice",
        reason: "This runtime's RFB renderer is available only to the current controller. Request control to view and interact with it.",
      });
      return;
    }
    // The capability read may still answer (it is retried while the machine
    // starts): the attach goes on once it does, so nothing is cancelled here.
    dropConnection();
    setStatus("error");
    if (!sharedBrowserCapabilitiesAvailable && !sharedBrowserCapabilitiesUnsupported) {
      setFailure({ kind: "failed", reason: "Unable to connect to this browser session. Retry when the machine is ready." });
    } else {
      setFailure({
        kind: "notice",
        reason: sharedBrowserCapabilitiesUnsupported
          ? "This Shared Browser viewer requires a newer version of Instafy."
          : "This Shared Browser runtime does not provide a safe view-only renderer.",
      });
    }
  }, [
    activeSharedBrowserViewerKind,
    browserDataClearInFlight,
    browserOriginConnection,
    canControlBrowser,
    collaboration.client.state,
    dropConnection,
    fail,
    isOpen,
    remoteControllerPresent,
    sharedBrowserCapabilitiesAvailable,
    sharedBrowserCapabilitiesResolved,
    sharedBrowserCapabilitiesUnsupported,
    viewerWaitExpired,
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

  // A press on a card while this browser is open: attach to its machine
  // again, as Retry does (the person's own action, so it may start the
  // space's machine), but keep the last frame on screen meanwhile.
  const handledAttachRequestRef = useRef(attachRequestToken);
  useEffect(() => {
    if (attachRequestToken === handledAttachRequestRef.current) {
      return;
    }
    handledAttachRequestRef.current = attachRequestToken;
    if (!isOpen || browserDataClearInFlightRef.current) {
      return;
    }
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    autoRetryCountRef.current = 0;
    reconnectTimesRef.current = [];
    automaticReconnectRef.current = false;
    fatalViewerErrorsRef.current = { count: 0, lastAtMs: 0 };
    freezeCurrentBrowserFrame();
    setRuntimeLimitDetails(null);
    setStatus("connecting");
    setFailure(null);
    startAttempt("press");
    runtimeDebugLog("browser-session:reattach", { projectId });
  }, [attachRequestToken, freezeCurrentBrowserFrame, isOpen, projectId, startAttempt]);

  // Studio by itself, while this browser is off or did not open: an agent or
  // another viewer started Instafy's browser, or Studio opens it for a card.
  // It attaches again without a press (hands-free) and never starts the
  // machine; it attaches to whichever run of the browser is there. A request
  // that comes while an attempt is on its way (an automatic reconnect, say)
  // waits for it: it acts once that attempt ends off or failed, and is
  // dropped if it connects.
  const handledAutoAttachRef = useRef(autoAttachToken);
  useEffect(() => {
    if (autoAttachToken === handledAutoAttachRef.current) {
      return;
    }
    if (isOpen && status === "connecting") {
      return;
    }
    handledAutoAttachRef.current = autoAttachToken;
    const kind = viewKindRef.current;
    if (!isOpen || browserDataClearInFlightRef.current || (kind !== "off" && kind !== "failed")) {
      return;
    }
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    autoRetryCountRef.current = 0;
    reconnectTimesRef.current = [];
    automaticReconnectRef.current = false;
    fatalViewerErrorsRef.current = { count: 0, lastAtMs: 0 };
    connectedHostRef.current = null;
    setRuntimeLimitDetails(null);
    setStatus("connecting");
    setFailure(null);
    startAttempt("studio");
    runtimeDebugLog("browser-session:auto-attach", { projectId, from: kind });
  }, [autoAttachToken, isOpen, projectId, startAttempt, status]);

  // "Reconnecting…" shows no progress and no Retry, so a browser that had
  // connected waits for it by itself only so long.
  const reconnectingShown =
    isOpen && !browserDataClearInFlight && status === "connecting" && hasConnectedHint && !error &&
    automaticReconnectRef.current;
  useEffect(() => {
    if (!reconnectingShown) return;
    const timer = window.setTimeout(() => {
      // Abandon the attempt on its way: a late answer must not bring the wait
      // back, and its host wait stops reading and starting the browser.
      fail("failed", "reconnect deadline passed");
      runtimeDebugLog("browser-session:reconnect-timeout", { projectId });
    }, SHARED_BROWSER_RECONNECT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [fail, projectId, reconnectingShown]);

  // On screen only once the picture has been gone for the grace period.
  const reconnectingNoteShown = useSustainedFlag(
    !shouldCollapseDocked && viewLive && status === "connecting",
    RECONNECTING_GRACE_MS,
  );

  // The card on a chat message says what this browser says.
  const shownError = isOpen && error ? viewState.sentence : null;
  useEffect(() => {
    onConnectionErrorChange?.(shownError);
  }, [onConnectionErrorChange, shownError]);
  useEffect(() => () => onConnectionErrorChange?.(null), [onConnectionErrorChange]);
  const reportedViewKind = isOpen ? viewState.kind : null;
  useEffect(() => {
    onViewStateChange?.(reportedViewKind);
  }, [onViewStateChange, reportedViewKind]);
  useEffect(() => () => onViewStateChange?.(null), [onViewStateChange]);

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
    if (!isOpen || browserDataClearInFlight) {
      return;
    }

    if (resolvedSharedBrowserViewerKind !== "rfb") {
      return;
    }

    if (!humanInputEnabled && !rfbViewOnlyLane) {
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
    let disposeFrameObserver: (() => void) | null = null;
    let painted = false;

    void (async () => {
      try {
        const mod = await loadBrowserRfbModule();
        if (cancelled) {
          return;
        }
        const RFB = resolveBrowserSessionRfbConstructor(mod);
        rfb = new RFB(container, wsUrl, {});
        // noVNC fills its screen with dark grey around the page; the stage
        // under it follows the theme (BROWSER_LIVE_STAGE_CLASS), so the bands
        // a page leaves above and below it on a phone are light in light mode.
        rfb.background = "transparent";
        rfbRef.current = rfb;
        const markFrameConnected = () => {
          setHasConnectedOnce(true);
          if (connectedScopeKey) connectedBrowserSessionScopes.add(connectedScopeKey);
          setStatus("connected");
          setFrozenFrameUrl(null);
        };
        disposeFrameObserver = observeBrowserRfbFrames(rfb, () => {
          if (cancelled || !retainFrameRef.current || browserDataClearInFlightRef.current) return;
          painted = true;
          paintedFrameScopeRef.current = frameScopeRef.current;
          paintedFrameSurfaceRef.current = rfb?._canvas ?? null;
          markFrameConnected();
        }, () => `${framePaintEpochRef.current}:${frameScopeRef.current}`);
        applySharedBrowserRfbHumanInput(rfb, humanInputEnabledRef.current);
        const scaledResizeInstalled = installBrowserRfbScaledResize(rfb, {
          renderScale: rfbRenderScale,
          maxFramebufferPixels: rfbMaxFramebufferPixels,
        });
        if (!scaledResizeInstalled && rfbRenderScale > 1) {
          throw new Error("Unable to initialize the HiDPI Shared Browser viewer.");
        }
        // A viewer never resizes the screen the driver uses: the view-only
        // lane scales the picture to fit instead.
        applyBrowserViewportMode(rfb, viewportMode, sharedBrowserViewportOnlyRef.current && !rfbViewOnlyLane);
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
          if (cancelled || browserDataClearInFlightRef.current) {
            return;
          }
          connected = true;
          autoRetryCountRef.current = 0;
          automaticReconnectRef.current = false;
          if (reconnectTimerRef.current !== null) {
            window.clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          setFailure(null);
          setMachineStartSlow(false);
          // A protocol handshake is not a painted frame. Keep the previous
          // picture until the new framebuffer has actually been decoded.
          if (!disposeFrameObserver) markFrameConnected();
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
          fail("failed", connected ? "RFB viewer disconnected" : "RFB viewer did not connect");
        };

        rfb.addEventListener?.("connect", handleConnect);
        rfb.addEventListener?.("disconnect", handleDisconnect);
      } catch (err) {
        if (browserDataClearInFlightRef.current) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        runtimeDebugLog("browser-session:rfb-init-error", {
          ...browserSessionWsDebugFields(wsUrl),
          message,
        });
        fail("failed", message || "Unable to load the browser viewer.");
      }
    })();

    return () => {
      cancelled = true;
      // Retain pixels before noVNC removes its canvas, but never recapture the
      // blank surface of a connection that has not painted yet.
      if (painted) freezeCurrentBrowserFrame();
      disposeFrameObserver?.();
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
    browserDataClearInFlight,
    containerNode,
    fail,
    forcedRuntimeId,
    fullscreen,
    freezeCurrentBrowserFrame,
    humanInputEnabled,
    isOpen,
    presentation,
    rfbMaxFramebufferPixels,
    rfbRenderScale,
    rfbViewOnlyLane,
    scheduleReconnectAttempt,
    resolvedSharedBrowserViewerKind,
    connectAttempt,
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
          // The view-only lane never resizes the screen the driver uses.
          applyBrowserViewportMode(rfb, viewportMode, !rfbViewOnlyLaneRef.current);
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
      applyBrowserViewportMode(rfb, viewportMode, sharedBrowserViewportOnly && !rfbViewOnlyLane);
    } catch {
      // ignore viewport mode updates when session is reconnecting
    }
  }, [isOpen, rfbViewOnlyLane, sharedBrowserViewportOnly, viewportMode]);

  const handleCdpScreencastConnected = useCallback(() => {
    if (browserDataClearInFlightRef.current) {
      return;
    }
    autoRetryCountRef.current = 0;
    automaticReconnectRef.current = false;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setFailure(null);
    setMachineStartSlow(false);
    setHasConnectedOnce(true);
    paintedFrameScopeRef.current = frameScope;
    paintedFrameSurfaceRef.current = containerRef.current?.querySelector<HTMLCanvasElement>(
      '[data-testid="shared-browser-cdp-screencast"]',
    ) ?? null;
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
  }, [connectedScopeKey, frameScope, sharedBrowserPageId, wsUrl]);

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
      fail("failed", detail.connected ? "screencast disconnected" : "screencast did not connect");
    },
    [fail, fallBackFromViewer, forcedRuntimeId, scheduleReconnectAttempt, wsUrl],
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
      // A lane that failed for good (the input socket closed, a renderer
      // that never became ready) reconnects, within a bound, rather than
      // waiting in "connecting" with nothing on its way.
      const now = Date.now();
      const recent = now - fatalViewerErrorsRef.current.lastAtMs < FATAL_VIEWER_ERROR_WINDOW_MS;
      const pendingReconnect = reconnectTimerRef.current !== null;
      const count = pendingReconnect
        ? fatalViewerErrorsRef.current.count
        : (recent ? fatalViewerErrorsRef.current.count : 0) + 1;
      fatalViewerErrorsRef.current = { count, lastAtMs: now };
      if (count <= MAX_AUTO_CONNECT_RETRIES && scheduleReconnectAttempt("connect_failure", wsUrl ?? "")) {
        return;
      }
      fail("failed", `${SHARED_BROWSER_LOST_CONNECTION_REASON}: ${message}`);
    },
    [fail, fallBackFromViewer, scheduleReconnectAttempt, wsUrl],
  );

  const handleWebRtcConnected = useCallback(() => {
    if (browserDataClearInFlightRef.current) {
      return;
    }
    autoRetryCountRef.current = 0;
    automaticReconnectRef.current = false;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setFailure(null);
    setMachineStartSlow(false);
    setHasConnectedOnce(true);
    paintedFrameScopeRef.current = frameScope;
    paintedFrameSurfaceRef.current = containerRef.current?.querySelector<HTMLVideoElement>(
      '[data-testid="shared-browser-webrtc"]',
    ) ?? null;
    setFrozenFrameUrl(null);
    if (connectedScopeKey) {
      connectedBrowserSessionScopes.add(connectedScopeKey);
    }
    setStatus("connected");
    runtimeDebugLog("browser-session:webrtc-connected", {
      pageId: sharedBrowserPageId,
      metrics: collectBrowserViewerDebugMetrics(containerRef.current),
    });
  }, [connectedScopeKey, frameScope, sharedBrowserPageId]);

  const handleWebRtcDisconnected = useCallback(
    (detail: WebRtcBrowserDisconnect) => {
      runtimeDebugLog("browser-session:webrtc-disconnected", {
        ...detail,
        forcedRuntimeId,
      });
      if (fallBackFromViewer(detail.reason)) {
        return;
      }
      fail("failed", detail.connected ? "WebRTC video disconnected" : "WebRTC video did not connect");
    },
    [fail, fallBackFromViewer, forcedRuntimeId],
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
      fail("failed", message || "Shared Browser video is unavailable.");
    },
    [fail, fallBackFromViewer],
  );

  // While Octo drives, the stage shows the page it is on: the live picture
  // (a viewer that may watch, such as RFB's view-only lane), else a still
  // of that same page, else one plain line saying where Octo is. Never an
  // empty black stage.
  const agentPictureShown = Boolean(frozenFrameUrl) ||
    (activeSharedBrowserViewerKind !== null && displayStatus === "connected");
  const agentPage = effectiveAgentControlOwner
    ? agentReadingPages.find((page) => page.id === sharedBrowserPageId) ?? agentReadingPages[0] ?? null
    : null;
  // Over a blank tab a turn of this chat is on its way to: where Octo is going.
  const agentArrivalNote = viewLive
    ? browserArrivalNote(agentArrival, sharedBrowserActivePage, effectiveAgentControlOwner?.displayName ?? "Octo")
    : null;
  const agentWhereabouts = effectiveAgentControlOwner && viewLive && !agentPictureShown && !agentArrivalNote
    ? agentPage
      ? `${effectiveAgentControlOwner.displayName} is on ${browserReadingHost(agentPage)}`
      : `${effectiveAgentControlOwner.displayName} is using the browser`
    : null;
  // Around a live page the stage follows the theme like the chrome above it
  // and the composer below: black under a page in light mode read as dark
  // chrome on a phone, where the page leaves bands above and below it.
  const viewportSurfaceClass =
    viewLive && !agentWhereabouts
      ? BROWSER_LIVE_STAGE_CLASS
      : "bg-slate-100 dark:bg-slate-950";
  // The row of pages Octo reads, with its one Take over, above the stage.
  const readingRowShown = !shouldCollapseDocked && fillContainer && sharedBrowserChrome !== null &&
    viewLive && effectiveAgentControlOwner !== null && agentReadingPages.length > 0;
  const readingRowCanTakeOver = browserHumanInputOptions.canTakeOver &&
    (!browserHumanInputState.active || browserHumanInputState.busy === "takeover");
  const recoveryRuntimeLimit = error && limitReached ? {
    summary: runtimeSlotSummary,
    blockerProjectCopy,
    busy: runtimeLimitActionBusy,
    onTakeOver: hasTakeoverBlocker ? handleRuntimeLimitTakeover : undefined,
  } : undefined;
  const compactCardBody = shouldCollapseDocked ? compactRecovery ? (
    <BrowserSessionRecovery presentation="compact" viewState={viewState} reason={error}
      runtimeLimit={recoveryRuntimeLimit} onRetry={retryConnection} onHide={closeBrowserSession} />
  ) : (
    <Surface
      tone="default"
      radius="2xl"
      shadow="none"
      className="absolute inset-0 flex items-center"
      data-testid="browser-session-collapsed-card"
    >
      <div
        className={[
          "flex w-full items-center justify-between gap-3 p-3",
          shouldUseDesktopDockedCard ? "cursor-pointer" : "",
        ].join(" ")}
        role={shouldUseDesktopDockedCard ? "button" : undefined}
        tabIndex={shouldUseDesktopDockedCard ? 0 : undefined}
        onClick={shouldUseDesktopDockedCard ? expandDockedViewer : undefined}
        onKeyDown={shouldUseDesktopDockedCard ? (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            expandDockedViewer();
          }
        } : undefined}
      >
        <div className="flex min-w-0 items-center gap-3">
          <Surface tone="muted" radius="xl" shadow="none" className="flex h-10 w-10 flex-none items-center justify-center">
            <Safari className="h-4 w-4" aria-hidden="true" />
          </Surface>
          <div className="min-w-0">
            {collapsedCardMode === "connecting" ? (
              <LoadingStatus>{viewState.sentence}</LoadingStatus>
            ) : <>
              <Text variant="bodyStrong" tone="primary" className="truncate">Browser</Text>
              <Text as="span" variant="caption" tone="success" className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-current" aria-hidden="true" />
                Connected
              </Text>
            </>}
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          {collapsedCardMode === "connected" ? (
            <IconButton
              variant="ghost"
              size="sm"
              onPress={closeBrowserSession}
              aria-label="Hide browser session"
              title="Hide browser session"
              tone="muted"
              onClick={(event) => event.stopPropagation()}
            >
              <Xmark className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          ) : null}
          <IconButton
            variant="ghost"
            size="sm"
            onPress={() => setFullscreen(true)}
            aria-label="Open browser fullscreen"
            title="Open browser fullscreen"
            onClick={(event) => event.stopPropagation()}
          >
            <Expand className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>
      </div>
    </Surface>
  ) : null;

  const renderSessionControls = (actions?: ReactNode) => !shouldCollapseDocked && projectId ? (
    <SharedBrowserSessionControl
      runtimeId={selectedSessionRuntimeId ?? chosenRuntimeId ?? resumeRuntimeId}
      resumeUrl={sessionResumeUrl}
      actions={actions}
      location={locationOptions}
      open={sessionControlsVisible && sessionChooserOpen}
      busy={sessionChoices.scope === selectionScope && sessionChoices.loading}
      candidates={sessionChoices.scope === selectionScope ? sessionChoices.candidates : []}
      error={sessionChoices.scope === selectionScope ? sessionChoices.error : null}
      selectionRequired={status === "selecting"}
      canStart={canControlBrowser && !attachMode}
      onOpenChange={(open) => { setSessionChooserOpen(open && sessionControlsVisible); if (open && sessionControlsVisible) void refreshSessionChoices(); }}
      onChoose={chooseSession}
      onStart={startNewSession}
      onRefresh={() => { void refreshSessionChoices(); startAttempt(); }}
      footer={canClearBrowserData ? <>
        <StudioMenuSeparator />
        <SharedBrowserDataClearAction
          canClear={canClearBrowserData && !browserDataClearInFlight}
          onClearSettled={handleBrowserDataClearSettled}
          onClearStart={handleBrowserDataClearStart}
          projectId={projectId}
          showStatus={onStatus}
          {...(attachMode
            ? {
                confirmation: spaceBusy
                  ? `${CLEAR_SHARED_BROWSER_HOST_DATA_CONFIRMATION} ${CLEAR_SHARED_BROWSER_HOST_DATA_BUSY_NOTE}`
                  : CLEAR_SHARED_BROWSER_HOST_DATA_CONFIRMATION,
                successMessage: CLEAR_SHARED_BROWSER_HOST_DATA_SUCCESS,
              }
            : {})}
        />
      </> : null}
    >
      {sessionControlsVisible && sessionChooserOpen ? <SharedBrowserProfileStatus projectId={projectId} runtimeId={selectedSessionRuntimeId} currentUserId={currentUserId} active /> : null}
    </SharedBrowserSessionControl>
  ) : null;

  // Who controls the browser means something only while it is live, or once
  // its roster is known on a connection (a renderer only the controller may
  // use asks for control there); "Control syncing…" never stands in for it.
  const collaborationControlsShown =
    viewLive || (collaboration.client.state !== null && browserOriginConnection !== null);
  const renderCollaborationControls = (controls: ReactNode) => (
    <SharedBrowserCollaborationControls
      client={collaboration.client}
      compact={sharedBrowserChrome?.compact ?? false}
      localControlOwner={effectiveAgentControlOwner ?? controlOwner}
      onGrantControl={(participantId) => collaboration.grantControl(participantId)}
      onReleaseControl={() => collaboration.releaseControl()}
      onRequestControl={() => collaboration.requestControl()}
      onTakeControl={() => collaboration.takeControl()}
    >
      {controls}
    </SharedBrowserCollaborationControls>
  );

  const humanInputControls = !shouldCollapseDocked && humanInputIdentityKey
    ? <BrowserHumanInputStatus {...browserHumanInputOptions} state={browserHumanInputState} /> : null;
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
              <BrowserSessionStatusPill status={displayStatus} view={viewState} />
            )}
            {toolbarLeading || locationOptions ? null : (
              <BrowserIdentityBadge className={fillContainer ? "inline-flex" : "hidden sm:inline-flex"} />
            )}
          </div>
          <div className="flex flex-none items-center gap-2">
            {humanInputControls}
            {renderSessionControls()}
            {!forceViewportFullscreenDocked ? (
              <BrowserExpandButton
                expanded={fullscreen}
                onPress={toggleFullscreen}
              />
            ) : null}
            <IconButton
              variant="ghost"
              size="xs"
              onPress={returnToChat}
              aria-label={returnToChatLabel}
              title={returnToChatLabel}
              tone="muted"
            >
              <Xmark className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </div>
        </div>
      ) : null}

      {!shouldCollapseDocked && fillContainer && sharedBrowserChrome ? (
        <SharedBrowserChrome
          {...sharedBrowserChrome}
          // Outside live the address field is empty and disabled: the card
          // says why.
          resolved={viewLive && sharedBrowserChrome.resolved}
          historyUserId={currentUserId}
          historyActive={isOpen && transportActive}
          controlOwner={effectiveAgentControlOwner ?? controlOwner}
          interactionEnabled={humanInputEnabled}
          toolbarActions={(compactNavigation) => (
            <>
              {humanInputIdentityKey ? (
                <BrowserHumanInputStatus {...browserHumanInputOptions} state={browserHumanInputState}
                  renderControls={collaborationControlsShown ? renderCollaborationControls : undefined} />
              ) : collaborationControlsShown ? renderCollaborationControls(null) : null}
              {renderSessionControls(sharedBrowserChrome.compact ? <>
                {compactNavigation}
                {!forceViewportFullscreenDocked ? <BrowserExpandButton expanded={fullscreen} showLabel
                  onPress={() => { setSessionChooserOpen(false); toggleFullscreen(); }} /> : null}
              </> : null)}
              {!projectId ? compactNavigation : null}
              {!forceViewportFullscreenDocked && (!sharedBrowserChrome.compact || !projectId) ? (
                <BrowserExpandButton expanded={fullscreen} onPress={toggleFullscreen} />
              ) : null}
            </>
          )}
          toolbarLeading={toolbarLeading}
          toolbarStatus={
            <span className={sharedBrowserChrome.compact ? "sr-only" : undefined}>
              <BrowserSessionStatusPill status={displayStatus} view={viewState} />
            </span>
          }
        />
      ) : null}

      {readingRowShown && effectiveAgentControlOwner ? (
        <BrowserReadingRow
          pages={agentReadingPages}
          agentName={effectiveAgentControlOwner.displayName}
          canTakeOver={readingRowCanTakeOver}
          takingOver={browserHumanInputState.busy === "takeover"}
          // The toolbar's take-over controls already say why a take-over failed.
          error={humanInputIdentityKey ? null : browserHumanInputState.error}
          onTakeOver={() => void browserHumanInputState.takeOver()}
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
                ? "relative min-w-0 w-full"
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
                        // Recovery copy and touch actions determine their own height.
                        height: compactRecovery ? undefined : `${dockedStageHeight}px`,
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
          {!shouldCollapseDocked && agentArrivalNote ? <BrowserSessionArrival note={agentArrivalNote} /> : null}
          {!shouldCollapseDocked && agentWhereabouts ? (
            <div
              className="absolute inset-0 flex items-center justify-center p-4 text-center"
              data-testid="browser-session-agent-whereabouts"
              role="status"
            >
              <Text variant="body" tone="muted">{agentWhereabouts}</Text>
            </div>
          ) : null}
          {frozenFrameUrl ? (
            <img
              alt=""
              aria-hidden="true"
              className={`absolute inset-0 h-full w-full object-contain ${BROWSER_LIVE_STAGE_CLASS}`}
              data-testid="browser-session-frozen-frame"
              src={frozenFrameUrl}
            />
          ) : null}
          <div
            ref={setContainerElement}
            style={mobileKeyboardOccupiedHeight > 0 ? { bottom: mobileKeyboardOccupiedHeight } : undefined}
            className={[
              shouldCollapseDocked
                ? "absolute inset-0 overflow-hidden opacity-0 pointer-events-none"
                : viewportMode === "native"
                  ? "absolute inset-0 overflow-auto touch-pan-x touch-pan-y touch-pinch-zoom"
                  : "absolute inset-0 overflow-hidden",
              frozenFrameUrl ? "opacity-0" : "",
            ].join(" ")}
          >
            {resolvedSharedBrowserViewerKind === "webrtc" && webRtcConnection ? (
              <WebRtcBrowserViewer
                offerUrl={webRtcConnection.offerUrl}
                inputWsUrl={webRtcConnection.inputWsUrl}
                inputAvailable={canControlBrowser}
                accessToken={webRtcConnection.accessToken}
                connectionGeneration={connectAttempt}
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
            {resolvedSharedBrowserViewerKind === "cdp-screencast" && wsUrl ? (
              <CdpScreencastViewer
                wsUrl={wsUrl}
                inputWsUrl={browserInputWsUrl}
                inputAvailable={canControlBrowser}
                inputAuthorityKey={inputAuthorityKey}
                connectionGeneration={connectAttempt}
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
              {remoteController && transportActive ? (
                <div
                  className="pointer-events-none absolute inset-0 z-10"
                  data-testid={remoteController.kind === "agent" ? "shared-browser-agent-control-overlay" : "shared-browser-participant-control-overlay"}
                >
                  <RemoteControlSurface controller={remoteController.displayName} working={!browserHumanInputState.active}
                    // One Take over: the reading row's, when it shows one.
                    onTakeOver={browserHumanInputOptions.canTakeOver &&
                      !(remoteController.kind === "agent" && readingRowShown && readingRowCanTakeOver)
                      ? browserHumanInputState.requestTakeOver : undefined} />
                </div>
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
              {effectiveAgentControlOwner ? <ActionTicker actions={agentTurnActions} /> : null}
              <RemoteBrowserMobileKeyboard
                enabled={
                  humanInputEnabled && activeSharedBrowserViewerKind !== "rfb"
                }
                onMessage={dispatchMobileBrowserInput}
                onOccupiedHeightChange={setMobileKeyboardOccupiedHeight}
              />
            </>
          ) : null}
          {reconnectingNoteShown ? <BrowserSessionReconnecting /> : null}
          {compactCardBody}
          {!shouldCollapseDocked && displayStatus !== "selecting" && !viewLive ? (
            <BrowserSessionRecovery viewState={viewState} reason={error}
              runtimeLimit={recoveryRuntimeLimit} onRetry={retryConnection} />
          ) : null}
          {!shouldCollapseDocked && sharedBrowserApprovalRequest ? (
            <SharedBrowserApprovalPrompt
              active={transportActive}
              agentName={effectiveAgentControlOwner?.displayName ?? "Octo"}
              error={sharedBrowserApproval.error}
              onDecision={(decision) => {
                // The prompt this sheet shows, not whatever was polled since.
                void sharedBrowserApproval.decide(decision, sharedBrowserApprovalRequest.approvalId);
              }}
              request={sharedBrowserApprovalRequest}
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
          onOpenChange={(open) => {
            if (!open && !forceViewportFullscreenDocked) setFullscreen(false);
            else onOpenChange(open);
          }}
          isDismissable
          dialogAriaLabel="Browser session"
          className={fullscreenOverlayClassName}
          style={expandedViewportStyle}
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
            ? "flex h-full w-full flex-col overflow-hidden bg-white dark:bg-slate-950"
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
      style={fullscreen ? expandedViewportStyle : undefined}
      modalClassName={fullscreen ? fullscreenModalClassName : modalClassName}
      dialogClassName={fullscreen ? fullscreenDialogClassName : "h-full"}
      data-testid="browser-session-modal"
    >
      {panelContent}
    </StudioDialogModal>
  );
}
