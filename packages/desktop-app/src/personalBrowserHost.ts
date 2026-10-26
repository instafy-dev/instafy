import { createBrowserTabExplorePage } from "./browserTabExplorePage";
import { dispatchBrowserTabInput } from "./browserTabInput";
import {
  BrowserWindow,
  WebContentsView,
  screen,
  dialog,
  type Event,
  type Session,
  type WebContents,
} from "electron";
import { randomUUID } from "node:crypto";
import { requireHumanInputIndices, type PersonalBrowserHumanInputRequest } from "./personalBrowserHumanInput";

import {
  clickPersonalBrowserTarget,
  clearPersonalBrowserHumanInput,
  highlightPersonalBrowserHumanInput,
  inspectPersonalBrowserTarget,
  personalBrowserTargetExpectation,
  pressPersonalBrowserTarget,
  scrollPersonalBrowserPage,
  snapshotPersonalBrowserPage,
  typeIntoPersonalBrowserTarget,
  type PersonalBrowserPageSnapshot,
  type PersonalBrowserTargetDescriptor,
} from "./personalBrowserPageBridge";
import { PersonalBrowserInputShield } from "./personalBrowserInputShield";
import {
  createMemoryTeammateActivityStore,
  type PersonalBrowserTeammateActivity,
  type PersonalBrowserTeammateActivityStore,
} from "./personalBrowserTeammateActivity";
import {
  hasCredentialWord,
  maskSentPage,
  redactLogValue,
  redactPageObservation,
  redactText,
  redactUrl,
  type SentPageView,
} from "./personalBrowserRedaction";
import {
  categoryTitle,
  classifyAddress,
  isEditable as isEditableStepTarget,
  refusalFor,
  stepLabels,
  type PersonalBrowserStepClassification,
} from "./personalBrowserActionPolicy";
import { BrowserTabCapture } from "./browserTabCapture";
import {
  PersonalBrowserControlError,
  PersonalBrowserControlServer,
  type PersonalBrowserControlCredentials,
  type PersonalBrowserControlOperation,
} from "./personalBrowserControlServer";
import {
  classifyPersonalBrowserStep,
  derivePersonalBrowserPartition,
  getPersonalBrowserOrigin,
  isPersonalBrowserActivationKey,
  isSensitivePersonalBrowserEditable,
  normalizePersonalBrowserApprovalMode,
  normalizePersonalBrowserBounds,
  normalizePersonalBrowserKnownHosts,
  normalizePersonalBrowserPressKey,
  normalizePersonalBrowserScroll,
  normalizePersonalBrowserText,
  normalizePersonalBrowserUrl,
  checkPersonalBrowserAgentTabUrl,
  personalBrowserAgentTabHopIsPublic,
  requirePersonalBrowserTabId,
  MAX_PERSONAL_BROWSER_AGENT_TABS,
  personalBrowserTargetSecurityFingerprint,
  personalBrowserActivationTargetsMatch,
  personalBrowserActivationRequiresConfirmation,
  personalBrowserKeyRequiresConfirmation,
  personalBrowserKeyMutatesSensitiveField,
  requirePersonalBrowserTarget,
  sanitizePersonalBrowserBrokerStatus,
  PERSONAL_BROWSER_APPROVAL_POLICY_VERSION,
  type PersonalBrowserBounds,
  type PersonalBrowserApprovalMode,
} from "./personalBrowserSecurity";

export type PersonalBrowserState = "closed" | "opening" | "ready" | "error";
const HUMAN_CONTROL_DRAIN_TIMEOUT_MS = 15_000;
const HUMAN_CONTROL_DRAIN_ERROR = "A previous browser operation is still stopping. Input remains locked until it finishes; close the browser if it does not recover.";

/** One page its owner sent to the chat with Send page to Octo, masked. */
export type PersonalBrowserSentPage = SentPageView & {
  /** When the page was read (ISO 8601). */
  readAt: string;
};

/**
 * One tab of the Personal Browser. The first tab is the person's own; the
 * agent can open up to MAX_PERSONAL_BROWSER_AGENT_TABS more while the person
 * has resumed control. Every tab is a visible page in the same profile.
 */
export type PersonalBrowserTabStatus = {
  id: string;
  openedBy: "person" | "agent";
  active: boolean;
  url: string;
  title?: string;
};

export type PersonalBrowserStatus = {
  supported: boolean;
  enabled: boolean;
  state: PersonalBrowserState;
  visible: boolean;
  url: string;
  title?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  agentControlEnabled: boolean;
  /** Revoked capability AND every already-dispatched host operation settled. */
  humanControlReady: boolean;
  takeoverRequestId?: string;
  humanInputRequest?: PersonalBrowserHumanInputRequest;
  approvalMode: PersonalBrowserApprovalMode;
  approvalModes: PersonalBrowserApprovalMode[];
  /** 2: "routine" is the owner tier (see PERSONAL_BROWSER_APPROVAL_POLICY_VERSION). */
  approvalPolicyVersion: number;
  sharing?: boolean;
  tabControlActive?: boolean;
  /** Every open tab, in order; the active one is on screen. */
  tabs: PersonalBrowserTabStatus[];
  activeTabId: string;
  maxAgentTabs: number;
  ownerId?: string;
  projectId?: string;
  runtimeId?: string;
  error?: string;
};

export type OpenPersonalBrowserRequest = {
  projectId: string;
  profileKey: string;
  ownerId: string;
  url?: string;
};

export type PersonalBrowserReleaseLease = {
  controlEpoch: number;
  projectId: string;
  partition: string;
};

type PersonalBrowserHostOptions = {
  enabled: boolean;
  // The main process puts expiry back through the same mutation lane as open
  // and navigation. That makes the lease check and close atomic with reclaim.
  onReleaseExpiry: (lease: PersonalBrowserReleaseLease) => void;
  onEmergencyPause?: (projectId: string) => void;
  onStatus?: (status: PersonalBrowserStatus) => void;
  /** Where teammate activity in a profile is kept; in memory when absent. */
  teammateActivity?: PersonalBrowserTeammateActivityStore;
  logger?: (
    level: "info" | "warn" | "error",
    message: string,
    payload?: Record<string, unknown>,
  ) => void;
};

type PersonalBrowserResolvedTarget = {
  url: string;
  origin: string | null;
  descriptor: PersonalBrowserTargetDescriptor;
};

// A sign-in handoff keeps the run's approval mode: Let AI continue within the
// handoff's window, for the same project, profile and owner, in the same mode,
// does not show the start confirmation again.
type PersonalBrowserHandoffResume = {
  handoffId: string;
  projectId: string;
  partition: string;
  ownerId: string;
  approvalMode: PersonalBrowserApprovalMode;
  knownHosts: string[];
  expiresAtMs: number;
};

type PersonalBrowserSnapshotState = {
  controlEpoch: number;
  url: string;
  origin: string | null;
  documentToken: string;
  targets: Map<number, PersonalBrowserResolvedTarget>;
};

/**
 * A tab and the agent's state that belongs to it. Site, navigation and typing
 * approvals, the latest snapshot and the withheld pages are bound to the tab
 * they were given in: an approval in one tab never covers another.
 */
type PersonalBrowserTab = {
  id: string;
  openedBy: "person" | "agent";
  view: WebContentsView | null;
  approvedOrigins: Set<string>;
  pendingOriginApprovals: Map<string, Promise<boolean>>;
  // Addresses (origin and path) an approved step is about to open.
  approvedNavigations: Map<string, number>;
  pendingNavigationApprovals: Map<string, Promise<boolean>>;
  // One typing approval covers a form, or a field outside forms, per page.
  typingApprovals: Set<string>;
  // A navigation the page started after an agent step and the owner denied;
  // the agent's next operation in that control epoch reports it.
  deniedPageNavigationEpoch: number | null;
  latestAgentSnapshot: PersonalBrowserSnapshotState | null;
  // A document stays withheld from the agent until a new page loads once it
  // was a secret screen or a credential step ran on it.
  withheldDocumentTokens: Set<string>;
  // Set by a credential step that may open another page: the next new
  // document is withheld too.
  withholdNextDocumentAfter: string | null;
};

function createPersonalBrowserTab(id: string, openedBy: PersonalBrowserTab["openedBy"]): PersonalBrowserTab {
  return {
    id,
    openedBy,
    view: null,
    approvedOrigins: new Set(),
    pendingOriginApprovals: new Map(),
    approvedNavigations: new Map(),
    pendingNavigationApprovals: new Map(),
    typingApprovals: new Set(),
    deniedPageNavigationEpoch: null,
    latestAgentSnapshot: null,
    withheldDocumentTokens: new Set(),
    withholdNextDocumentAfter: null,
  };
}

function resetTabApprovals(tab: PersonalBrowserTab) {
  tab.deniedPageNavigationEpoch = null;
  tab.approvedOrigins.clear();
  tab.pendingOriginApprovals.clear();
  tab.approvedNavigations.clear();
  tab.pendingNavigationApprovals.clear();
  tab.typingApprovals.clear();
}

const configuredPersonalBrowserSessions = new WeakSet<Session>();
// Studio can briefly remount ChatPanel while reconciling a conversation or
// returning from another workspace. Keep the already-hidden, control-revoked
// view just long enough for the same local identity to reclaim it.
const PERSONAL_BROWSER_RELEASE_GRACE_MS = 10_000;
const PERSONAL_BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;

function requireProjectId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Personal Browser requires projectId.");
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) {
    throw new Error("Personal Browser projectId is empty or too long.");
  }
  return trimmed;
}

function requireOwnerId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Personal Browser requires ownerId.");
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) {
    throw new Error("Personal Browser ownerId is empty or too long.");
  }
  return trimmed;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PersonalBrowserControlError(400, "invalid_request", "Control payload must be an object.");
  }
  return value as Record<string, unknown>;
}

function navigationHistoryStatus(webContents: WebContents | null) {
  if (!webContents || webContents.isDestroyed()) {
    return { canGoBack: false, canGoForward: false };
  }
  return {
    canGoBack: webContents.navigationHistory.canGoBack(),
    canGoForward: webContents.navigationHistory.canGoForward(),
  };
}

function pageLabel(descriptor: PersonalBrowserTargetDescriptor): string {
  return (
    descriptor.ariaLabel ||
    descriptor.text ||
    descriptor.title ||
    descriptor.value ||
    descriptor.formActionText ||
    "this action"
  ).slice(0, 160);
}

// Shows both labels when the control's accessible name and visible text
// differ, so a page cannot hide what a control does behind a friendly name.
function activationLabel(descriptor: PersonalBrowserTargetDescriptor): string {
  const labels = stepLabels(descriptor);
  if (labels.differ) {
    return `“${labels.accessible.slice(0, 160)}” (shown on the page as “${labels.visible.slice(0, 160)}”)`;
  }
  return `“${pageLabel(descriptor)}”`;
}

const STEP_DIALOG_DETAILS: Record<string, string> = {
  purchase: "This may buy something or start a payment.",
  transfer: "This may move money.",
  message: "This may send a message or publish something as you.",
  permission: "This may share something or change who has access.",
  credential: "This may create, change or remove a key, token or password.",
  download: "This may download or export data.",
  destructive: "This may delete, cancel, remove or sign out of something.",
  may_show_secret:
    "This may open a key or other secret. If you allow it, the agent cannot read this page or the page it opens until a new page loads.",
  change: "This may change something on the site.",
};

// An approved step's navigation is not asked about again: one use, shortly after.
const APPROVED_NAVIGATION_TTL_MS = 30_000;
const MAX_TYPING_APPROVALS = 256;

// Steps after which the page, and a page they open, stay withheld.
const SECRET_REVEALING_CATEGORIES = new Set(["credential", "may_show_secret"]);
// Withheld documents remembered at once, so going back to an earlier
// withheld page keeps it withheld.
const MAX_WITHHELD_DOCUMENTS = 32;

function formSubmissionDescription(descriptor: PersonalBrowserTargetDescriptor): string {
  const formLabel = descriptor.formActionText?.trim();
  if (formLabel && formLabel !== "this form") {
    return `“${formLabel.slice(0, 160)}”`;
  }
  const targetLabel = (
    descriptor.ariaLabel ||
    descriptor.placeholder ||
    descriptor.text ||
    descriptor.title ||
    descriptor.name ||
    descriptor.value
  )?.trim();
  return targetLabel
    ? `the form containing “${targetLabel.slice(0, 160)}”`
    : "this form";
}

function siteName(value: string): string | null {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host ? host.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

// The text a type step enters, so the owner sees what a fill-in-and-submit
// approval sends. Typing into password, code and payment fields is refused
// before any dialog.
const TYPED_TEXT_PREVIEW_CHARACTERS = 300;

function typedTextDetail(text: string | undefined): string {
  if (text === undefined) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "The agent types no text.";
  const preview = flat.length > TYPED_TEXT_PREVIEW_CHARACTERS
    ? `${flat.slice(0, TYPED_TEXT_PREVIEW_CHARACTERS)}… (${flat.length} characters)`
    : flat;
  return `The agent types: “${preview}”.`;
}

function fillDescription(descriptor: PersonalBrowserTargetDescriptor): string {
  if (descriptor.formOwnerIdentity?.trim()) {
    return formSubmissionDescription(descriptor);
  }
  const label = (descriptor.ariaLabel || descriptor.placeholder || descriptor.name || descriptor.title)?.trim();
  return label ? `the field “${label.slice(0, 160)}”` : "this field";
}

export class PersonalBrowserHost {
  private readonly enabled: boolean;
  private readonly supported: boolean;
  private readonly onReleaseExpiry: PersonalBrowserHostOptions["onReleaseExpiry"];
  private readonly onEmergencyPause: NonNullable<PersonalBrowserHostOptions["onEmergencyPause"]>;
  private readonly onStatus: NonNullable<PersonalBrowserHostOptions["onStatus"]>;
  private readonly teammateActivity: PersonalBrowserTeammateActivityStore;
  private readonly logger: NonNullable<PersonalBrowserHostOptions["logger"]>;
  private readonly controlServer: PersonalBrowserControlServer;
  private readonly inputShield: PersonalBrowserInputShield;
  private takeoverRequestId: string | undefined;
  private ownerWindow: BrowserWindow | null = null;
  private nextTabNumber = 1;
  private tabs: PersonalBrowserTab[] = [];
  private activeTab: PersonalBrowserTab = this.addTab("person");
  private humanInputRequest: PersonalBrowserHumanInputRequest | null = null;
  private currentState: PersonalBrowserState = "closed";
  private currentVisible = false;
  private currentOccluded = false;
  private previewPending = false;
  private currentOwnerId: string | null = null;
  private currentProjectId: string | null = null;
  private currentPartition: string | null = null;
  private currentRuntimeId: string | null = null;
  private currentError: string | null = null;
  private currentBounds: PersonalBrowserBounds = { x: 0, y: 0, width: 1, height: 1 };
  private agentControlEnabled = false;
  private activeControlOperations = 0;
  private humanControlDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalMode: PersonalBrowserApprovalMode = "ask";
  private humanNavigationInFlight = false;
  private humanNavigationEpoch = 0;
  // The card's hosts for a routine run, shown in its start dialog.
  private runKnownHosts: string[] = [];
  private handoffResume: PersonalBrowserHandoffResume | null = null;
  private controlEpoch = 0;
  private lastEmittedStatus = "";
  private releaseCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly tabCapture = new BrowserTabCapture(() => {
    const contents = this.getWebContents();
    // An explicit share belongs to the live owner, not the currently visible pane.
    // Owner/project release still invalidates every frame and control operation.
    return contents && this.currentOwnerId && this.currentProjectId
      ? { contents, ownerId: this.currentOwnerId, projectId: this.currentProjectId,
          canControl: !this.agentControlEnabled && this.activeControlOperations === 0,
          videoSource: {
            contents,
            current:()=>!contents.isDestroyed(),
            media:async requester=>{
              const bounds=this.fitBoundsToOwner(this.currentBounds);
              const dpr=this.ownerWindow ? screen.getDisplayMatching(this.ownerWindow.getBounds()).scaleFactor : 1;
              const scale=Math.min(dpr,Math.sqrt(1_920_000/(bounds.width*bounds.height)));
              return {sourceId:contents.getMediaSourceId(requester),width:Math.max(1,Math.floor(bounds.width*scale)),height:Math.max(1,Math.floor(bounds.height*scale))};
            },
          },
          createExplore: viewport => {
            // Explore runs in the owner's browser session: the profile now
            // carries a teammate's activity.
            const partition = this.currentPartition;
            this.markTeammateActivity(partition, contents.getURL());
            return createBrowserTabExplorePage(contents.session, contents.getURL(), viewport, undefined,
              url => this.markTeammateActivity(partition, url));
          },
          dispatchInput: (input, current) => this.inputShield.withInjectedInput(() => dispatchBrowserTabInput(contents,this.fitBoundsToOwner(this.currentBounds),input,current)),
        } : null;
  }, () => {
    this.takeoverRequestId = undefined;
    // A participant's tab control acts in the owner's profile and sign-ins.
    if (this.tabCapture.controlActive) {
      this.markTeammateActivity(this.currentPartition, this.getWebContents()?.getURL() ?? null);
    }
    this.syncInputShield();
    this.emitStatus();
  });

  // The page on screen and the agent's state for it. Every agent operation
  // acts on the active tab, which is always the one the person sees.
  private get view() { return this.activeTab.view; }
  private set view(value: WebContentsView | null) { this.activeTab.view = value; }
  private get approvedOrigins() { return this.activeTab.approvedOrigins; }
  private get pendingOriginApprovals() { return this.activeTab.pendingOriginApprovals; }
  private get approvedNavigations() { return this.activeTab.approvedNavigations; }
  private get pendingNavigationApprovals() { return this.activeTab.pendingNavigationApprovals; }
  private get typingApprovals() { return this.activeTab.typingApprovals; }
  private get withheldDocumentTokens() { return this.activeTab.withheldDocumentTokens; }
  private get deniedPageNavigationEpoch() { return this.activeTab.deniedPageNavigationEpoch; }
  private set deniedPageNavigationEpoch(value: number | null) { this.activeTab.deniedPageNavigationEpoch = value; }
  private get latestAgentSnapshot() { return this.activeTab.latestAgentSnapshot; }
  private set latestAgentSnapshot(value: PersonalBrowserSnapshotState | null) { this.activeTab.latestAgentSnapshot = value; }
  private get withholdNextDocumentAfter() { return this.activeTab.withholdNextDocumentAfter; }
  private set withholdNextDocumentAfter(value: string | null) { this.activeTab.withholdNextDocumentAfter = value; }

  private addTab(openedBy: PersonalBrowserTab["openedBy"]): PersonalBrowserTab {
    const tab = createPersonalBrowserTab(`tab-${this.nextTabNumber++}`, openedBy);
    this.tabs.push(tab);
    return tab;
  }

  private agentTabCount(): number {
    return this.tabs.filter((tab) => tab.openedBy === "agent").length;
  }

  startTabShare(ownerId: string) {
    if (!this.currentVisible) throw new Error("Open your browser before sharing this tab.");
    const result = this.tabCapture.start(ownerId);
    this.emitStatus();
    return result;
  }
  controlSharedTab(ownerId: string, captureId: string, grantId: string | null) { this.tabCapture.setControl(ownerId,captureId,grantId); }
  renewSharedTabControl(ownerId: string, captureId: string, grantId: string) { return this.tabCapture.renewControl(ownerId,captureId,grantId); }
  inputSharedTab(ownerId: string, captureId: string, grantId: string, input: unknown) { return this.tabCapture.input(ownerId,captureId,grantId,input); }
  openTabExplore(ownerId: string, captureId: string, viewport: unknown) { return this.tabCapture.openExplore(ownerId, captureId, viewport); }
  operateTabExplore(ownerId: string, captureId: string, viewId: string, operation: "renew" | "frame" | "input" | "resize" | "navigate" | "close", value?: unknown) { return this.tabCapture.operateExplore(ownerId, captureId, viewId, operation, value); }
  videoSharedTab(ownerId: string, captureId: string, operation: "open" | "answer" | "sync" | "viewport" | "close" | "stats", value: unknown) {
    return this.tabCapture.videoOperation(ownerId,captureId,operation,value);
  }
  captureSharedTab(ownerId: string, captureId: string) {
    return this.tabCapture.frame(ownerId, captureId);
  }
  stopTabShare(ownerId: string, captureId: string) {
    if (this.isOwnedBy(ownerId)) this.tabCapture.stop(captureId);
    this.emitStatus();
  }
  revokeTabShare() {
    this.tabCapture.stop();
    this.emitStatus();
  }

  constructor(options: PersonalBrowserHostOptions) {
    this.enabled = options.enabled;
    this.supported = typeof WebContentsView === "function";
    this.onReleaseExpiry = options.onReleaseExpiry;
    this.onEmergencyPause = options.onEmergencyPause ?? (() => undefined);
    this.onStatus = options.onStatus ?? (() => undefined);
    // The default keeps marks for this Desktop session only; main.ts passes
    // the userData file store.
    this.teammateActivity = options.teammateActivity ?? createMemoryTeammateActivityStore();
    const logger = options.logger ?? (() => undefined);
    // Error messages can carry page addresses. Mask them before they reach
    // Desktop's log files.
    this.logger = (level, message, payload) => logger(level, message, payload ? redactLogValue(payload) : payload);
    this.controlServer = new PersonalBrowserControlServer({
      handle: (operation, payload) => this.handleControlOperation(operation, payload),
      logger: this.logger,
    });
    this.inputShield = new PersonalBrowserInputShield({
      createView: () =>
        new WebContentsView({
          webPreferences: {
            partition: "instafy-personal-input-shield",
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            webviewTag: false,
            devTools: false,
            navigateOnDragDrop: false,
          },
        }),
      onEmergencyEscape: () => this.emergencyPauseAgentControl(),
      onTakeOverRequest: () => {
        if (!(this.agentControlEnabled || this.tabCapture.controlActive) || !this.currentOwnerId || !this.currentVisible || this.currentOccluded) return;
        this.takeoverRequestId = randomUUID();
        this.emitStatus();
      },
    });
  }

  attachWindow(window: BrowserWindow) {
    if (this.ownerWindow === window) {
      return;
    }
    for (const tab of this.tabs) {
      if (tab.view && this.ownerWindow && !this.ownerWindow.isDestroyed()) {
        this.ownerWindow.contentView.removeChildView(tab.view);
      }
    }
    this.ownerWindow = window;
    // The active tab goes on top of the others.
    for (const tab of [...this.tabs.filter((entry) => entry !== this.activeTab), this.activeTab]) {
      if (!tab.view) continue;
      window.contentView.addChildView(tab.view);
      tab.view.setBounds(this.fitBoundsToOwner(this.currentBounds));
    }
    if (this.view) {
      this.inputShield.attach(window.contentView, this.view.webContents);
      this.applyVisibility();
    }
    this.emitStatus();
  }

  detachWindow(window: BrowserWindow) {
    if (this.ownerWindow !== window) {
      return;
    }
    for (const tab of this.tabs) {
      if (tab.view && !window.isDestroyed()) {
        window.contentView.removeChildView(tab.view);
      }
    }
    this.ownerWindow = null;
    void this.close();
  }

  getStatus(): PersonalBrowserStatus {
    const contents = this.getWebContents();
    const navigation = navigationHistoryStatus(contents);
    const url = contents?.getURL() || "about:blank";
    const title = contents?.getTitle().trim() || undefined;
    return {
      supported: this.supported,
      enabled: this.enabled,
      state: this.currentState,
      visible: this.currentVisible,
      url,
      ...(title ? { title } : {}),
      ...navigation,
      agentControlEnabled: this.agentControlEnabled,
      ...(this.takeoverRequestId ? { takeoverRequestId: this.takeoverRequestId } : {}),
      humanControlReady: this.currentState === "ready" && contents !== null && !this.agentControlEnabled && this.activeControlOperations === 0 && !this.tabCapture.controlActive,
      ...(this.humanInputRequest ? { humanInputRequest: this.humanInputRequest } : {}),
      approvalMode: this.approvalMode,
      approvalModes: ["ask", "routine"],
      approvalPolicyVersion: PERSONAL_BROWSER_APPROVAL_POLICY_VERSION,
      sharing: this.tabCapture.active,
      tabControlActive: this.tabCapture.controlActive,
      tabs: this.tabs.map((tab) => this.tabStatus(tab)),
      activeTabId: this.activeTab.id,
      maxAgentTabs: MAX_PERSONAL_BROWSER_AGENT_TABS,
      ...(this.currentOwnerId ? { ownerId: this.currentOwnerId } : {}),
      ...(this.currentProjectId ? { projectId: this.currentProjectId } : {}),
      ...(this.currentRuntimeId ? { runtimeId: this.currentRuntimeId } : {}),
      ...(this.currentError ? { error: this.currentError } : {}),
    };
  }

  async open(request: OpenPersonalBrowserRequest): Promise<PersonalBrowserStatus> {
    this.assertAvailable();
    if (!this.ownerWindow || this.ownerWindow.isDestroyed()) {
      throw new Error("Personal Browser requires an active desktop window.");
    }
    const projectId = requireProjectId(request?.projectId);
    const ownerId = requireOwnerId(request?.ownerId);
    const partition = derivePersonalBrowserPartition(request?.profileKey);
    const targetUrl = normalizePersonalBrowserUrl(request?.url);
    const isDifferentIdentity =
      this.currentProjectId !== projectId || this.currentPartition !== partition;
    const isDifferentOwner =
      this.currentOwnerId !== null && this.currentOwnerId !== ownerId;

    // Reclaim preserves the same profile/DOM, never the old conversation's
    // manual-step guidance, including a released (null-owner) lease.
    if (this.currentOwnerId !== ownerId) this.clearHumanInputGuidance();

    if (isDifferentIdentity || isDifferentOwner) {
      this.humanInputRequest = null;
      this.cancelReleaseExpiry();
      this.controlEpoch += 1;
      this.invalidateAgentSnapshot();
      if (isDifferentIdentity) {
        this.closeView();
      }
      this.controlServer.clearBinding();
      this.currentOwnerId = null;
      this.currentVisible = false;
      this.currentOccluded = false;
      this.setAgentControlState(false);
      this.clearHumanNavigationAllowance();
      this.currentRuntimeId = null;
      this.resetRunApprovals();
      this.currentProjectId = projectId;
      this.currentPartition = partition;
      this.applyVisibility();
    }

    const openEpoch = this.controlEpoch;
    let ownerAssigned = false;

    try {
      if (!this.isOpenIdentityCurrent(openEpoch, projectId, partition)) {
        throw new Error("Personal Browser opening was superseded.");
      }
      // Do not cancel an unreclaimed view's expiry until the replacement
      // binding is ready. A failed bind must not leave a hidden page alive.
      this.cancelReleaseExpiry();
      this.currentOwnerId = ownerId;
      ownerAssigned = true;
      if (!this.view) {
        this.currentState = "opening";
        this.currentError = null;
        this.createView(partition);
        this.emitStatus();
      }
      if (targetUrl !== "about:blank" || this.getWebContents()?.getURL() === "") {
        await this.runHumanNavigation(() => this.requireWebContents().loadURL(targetUrl));
      }
      if (!this.isOpenOwnerCurrent(openEpoch, projectId, partition, ownerId)) {
        throw new Error("Personal Browser opening was superseded.");
      }
      this.currentState = "ready";
      this.currentError = null;
      this.emitStatus();
      return this.getStatus();
    } catch (error) {
      const openIsCurrent = ownerAssigned
        ? this.isOpenOwnerCurrent(openEpoch, projectId, partition, ownerId)
        : this.isOpenIdentityCurrent(openEpoch, projectId, partition);
      if (!openIsCurrent) {
        // Renderer navigation and replacement opens revoke the broker before
        // their queued work runs. A late load must never restore it.
        this.controlServer.clearBinding();
        if (this.currentOwnerId === ownerId) {
          this.release(ownerId);
        }
        throw new Error("Personal Browser opening was superseded.", { cause: error });
      }
      this.currentState = "error";
      this.currentError = error instanceof Error ? error.message : String(error);
      this.emitStatus();
      throw error;
    }
  }

  setBounds(value: unknown): PersonalBrowserStatus {
    const bounds = normalizePersonalBrowserBounds(value);
    this.currentBounds = bounds;
    this.currentOccluded = bounds.occluded === true;
    if (typeof bounds.visible === "boolean") {
      this.currentVisible = bounds.visible;
    }
    if (this.view) {
      const fitted = this.fitBoundsToOwner(bounds);
      for (const tab of this.tabs) tab.view?.setBounds(fitted);
      this.applyVisibility();
    }
    this.emitStatus();
    return this.getStatus();
  }

  get occluded() { return this.currentOccluded; }

  async captureOverlayPreview(ownerId: string): Promise<string | undefined> {
    const contents = this.getWebContents();
    if (!contents || !this.isOwnedBy(ownerId) || !this.currentOccluded || this.previewPending) return;
    this.previewPending = true;
    try {
      let image = await contents.capturePage(undefined, { stayHidden: true });
      if (!this.isOwnedBy(ownerId) || this.getWebContents() !== contents || !this.currentOccluded) return;
      const { width, height } = image.getSize();
      if (!width || !height) return;
      const scale = Math.min(1, 1600 / width, 1200 / height);
      if (scale < 1) image = image.resize({width:Math.round(width*scale),height:Math.round(height*scale),quality:"good"});
      const jpeg = image.toJPEG(80);
      if (jpeg.length <= 1024 * 1024) return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    } catch { /* A preview is optional; the menu and live share remain usable. */ }
    finally { this.previewPending = false; }
  }

  show(visible: boolean): PersonalBrowserStatus {
    if (typeof visible !== "boolean") {
      throw new Error("Personal Browser visibility must be a boolean.");
    }
    this.currentVisible = visible;
    this.applyVisibility();
    this.emitStatus();
    return this.getStatus();
  }

  async navigate(url: unknown): Promise<PersonalBrowserStatus> {
    this.assertHumanInputAvailable();
    const normalized = normalizePersonalBrowserUrl(url);
    await this.runHumanNavigation(() => this.requireWebContents().loadURL(normalized));
    this.emitStatus();
    return this.getStatus();
  }

  async goBack(): Promise<PersonalBrowserStatus> {
    this.assertHumanInputAvailable();
    const contents = this.requireWebContents();
    if (contents.navigationHistory.canGoBack()) {
      await this.runHumanNavigation(async () => {
        contents.navigationHistory.goBack();
      });
    }
    this.emitStatus();
    return this.getStatus();
  }

  async goForward(): Promise<PersonalBrowserStatus> {
    this.assertHumanInputAvailable();
    const contents = this.requireWebContents();
    if (contents.navigationHistory.canGoForward()) {
      await this.runHumanNavigation(async () => {
        contents.navigationHistory.goForward();
      });
    }
    this.emitStatus();
    return this.getStatus();
  }

  async reload(): Promise<PersonalBrowserStatus> {
    this.assertHumanInputAvailable();
    const contents = this.requireWebContents();
    await this.runHumanNavigation(async () => contents.reload());
    this.emitStatus();
    return this.getStatus();
  }

  async setAgentControlEnabled(enabled: boolean): Promise<PersonalBrowserStatus> {
    if (typeof enabled !== "boolean") {
      throw new Error("Personal Browser agent control setting must be a boolean.");
    }
    if (enabled && this.currentState !== "ready") {
      throw new Error("Personal Browser must be ready before agent control is enabled.");
    }
    if (!enabled) {
      return this.pauseAgentControl();
    }
    const preparedEpoch = await this.prepareAgentControl();
    return this.enablePreparedAgentControl(preparedEpoch);
  }

  pauseAgentControl(): PersonalBrowserStatus {
    this.stopInFlightNavigation();
    this.controlEpoch += 1;
    this.invalidateAgentSnapshot();
    this.controlServer.clearBinding();
    this.resetRunApprovals();
    this.setAgentControlState(false);
    this.emitStatus();
    return this.getStatus();
  }

  async prepareAgentControl(
    requestedApprovalMode?: unknown,
    requestedKnownHosts?: unknown,
    requestedHandoffId?: unknown,
  ): Promise<number> {
    if (this.tabCapture.controlActive) throw new Error("Take back tab control before enabling the agent.");
    if (!this.agentControlEnabled && this.activeControlOperations > 0) {
      throw new Error("The previous Personal Browser operation is still stopping. Wait for control to return before resuming.");
    }
    const requestedMode = requestedApprovalMode === undefined && this.agentControlEnabled
      ? this.approvalMode
      : normalizePersonalBrowserApprovalMode(requestedApprovalMode);
    let approvalMode = requestedMode;
    if (this.currentState !== "ready") {
      throw new Error("Personal Browser must be ready before agent control is enabled.");
    }
    const projectId = this.currentProjectId;
    const partition = this.currentPartition;
    const ownerId = this.currentOwnerId;
    if (!projectId || !partition || !ownerId) {
      throw new Error("Personal Browser has no active project.");
    }
    if (this.agentControlEnabled && approvalMode !== this.approvalMode) {
      throw new Error("Pause Personal Browser before changing its approval mode.");
    }
    // The card's hosts only mean something to a routine run.
    const requestedHosts = approvalMode === "routine"
      ? normalizePersonalBrowserKnownHosts(Array.isArray(requestedKnownHosts) ? requestedKnownHosts : [])
      : [];
    // Let AI continue after a sign-in handoff keeps the run's mode and its
    // hosts. A start that names a host the owner has not seen in a start
    // dialog shows the dialog again.
    const handoff = this.agentControlEnabled
      ? null
      : this.takeHandoffResume(projectId, partition, ownerId, requestedHandoffId);
    const resumesHandoff = handoff !== null && handoff.approvalMode === approvalMode &&
      requestedHosts.every((host) => handoff.knownHosts.includes(host));
    const knownHosts = this.agentControlEnabled
      ? this.runKnownHosts
      : resumesHandoff
        ? handoff.knownHosts
        : requestedHosts;
    if (approvalMode === "routine" && !this.agentControlEnabled && !resumesHandoff) {
      const epoch = this.controlEpoch;
      const owner = this.ownerWindow;
      if (!owner || owner.isDestroyed() || !owner.isVisible()) {
        throw new Error("Personal Browser requires a visible window to approve routine browsing.");
      }
      // One native confirmation per run. "Ask me each step" starts the run in
      // Ask mode instead of failing it.
      const teammate = this.currentTeammateActivity();
      const result = await dialog.showMessageBox(owner, this.routineStartDialog(knownHosts, teammate));
      if (result.response !== 1 && result.response !== 2) {
        throw new Error("Routine browsing was not approved or the browser session changed.");
      }
      if (!this.isOpenOwnerCurrent(epoch, projectId, partition, ownerId)) {
        throw new Error("Routine browsing was not approved or the browser session changed.");
      }
      if (teammate && result.checkboxChecked === true) {
        this.forgetTeammateActivity(partition);
      }
      if (result.response === 2) {
        approvalMode = "ask";
      }
    }
    const clearEpoch = this.controlEpoch;
    await clearPersonalBrowserHumanInput(this.requireWebContents());
    if (!this.isOpenOwnerCurrent(clearEpoch, projectId, partition, ownerId)) {
      throw new Error("Personal Browser changed while clearing manual-input guidance.");
    }
    this.humanInputRequest = null;
    if (!this.controlServer.getCredentials(projectId)) {
      this.controlEpoch += 1;
      this.invalidateAgentSnapshot();
      const preparedEpoch = this.controlEpoch;
      this.resetRunApprovals();
      await this.controlServer.bindProject(projectId);
      if (!this.isOpenOwnerCurrent(preparedEpoch, projectId, partition, ownerId)) {
        this.controlServer.clearBinding();
        throw new Error("Personal Browser control changed while Resume was starting.");
      }
    }
    this.approvalMode = approvalMode;
    this.runKnownHosts = approvalMode === "routine" ? knownHosts : [];
    return this.controlEpoch;
  }

  private routineStartDialog(
    knownHosts: string[],
    teammate: PersonalBrowserTeammateActivity | null,
  ): Electron.MessageBoxOptions {
    const sites = knownHosts.length > 0 ? ` Sites on this card: ${knownHosts.join(", ")}.` : "";
    const teammateNote = teammate
      ? ` A teammate used this browser profile${teammate.sites.length > 0 ? ` (sites: ${teammate.sites.slice(-8).join(", ")})` : ""}. ` +
        "Until you forget that activity, the agent asks before using each site that is not on this card."
      : "";
    return {
      ...(teammate ? { checkboxLabel: "Forget teammate activity", checkboxChecked: false } : {}),
      type: "question",
      title: "Let the agent browse on its own?",
      message: "Let the agent browse in this project without asking for each site?",
      detail:
        "Reading pages, scrolling, following links, menus, tabs and searches go ahead without asking. " +
        "Other buttons, filling in forms, submitting, purchases, messages, downloads, sign-outs and key changes still ask each time. " +
        "Signing in, revealing keys and choosing files stay yours. Pause or Escape ends this permission." +
        sites +
        teammateNote,
      buttons: ["Cancel", "Allow", "Ask me each step"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
  }

  private takeHandoffResume(
    projectId: string,
    partition: string,
    ownerId: string,
    handoffId: unknown,
  ): PersonalBrowserHandoffResume | null {
    const handoff = this.handoffResume;
    this.handoffResume = null;
    if (
      !handoff ||
      // A Studio that names the handoff it continues binds the resume to it.
      (handoffId !== undefined && handoffId !== handoff.handoffId) ||
      handoff.projectId !== projectId ||
      handoff.partition !== partition ||
      handoff.ownerId !== ownerId ||
      Date.now() >= handoff.expiresAtMs
    ) {
      return null;
    }
    return handoff;
  }

  private resetRunApprovals() {
    // Pause, Escape, Clear data, close and an owner or identity change all
    // pass through here, and each cancels a handoff's kept mode.
    this.handoffResume = null;
    for (const tab of this.tabs) resetTabApprovals(tab);
  }

  isControlEpoch(epoch: number): boolean {
    return this.controlEpoch === epoch;
  }

  enablePreparedAgentControl(expectedEpoch: number): PersonalBrowserStatus {
    if (!this.isControlEpoch(expectedEpoch)) {
      throw new Error("Personal Browser control changed while Resume was starting.");
    }
    const projectId = this.currentProjectId;
    if (!projectId || !this.controlServer.getCredentials(projectId)) {
      throw new Error("Personal Browser control credentials are unavailable.");
    }
    // Resume is the boundary where page-driven navigation becomes agent
    // activity. End any post-load human grace before exposing the broker.
    this.clearHumanNavigationAllowance();
    this.setAgentControlState(true);
    this.emitStatus();
    return this.getStatus();
  }

  releaseForOwnerNavigation(window: BrowserWindow): PersonalBrowserStatus {
    if (window !== this.ownerWindow) {
      return this.getStatus();
    }
    if (this.currentOwnerId) {
      return this.release(this.currentOwnerId);
    }
    this.clearHumanInputGuidance();
    // Navigation can happen while open() is awaiting the broker bind or page
    // load. Rotate the epoch even without an assigned owner so that the late
    // continuation cannot reclaim credentials for the old renderer.
    this.cancelReleaseExpiry();
    this.controlEpoch += 1;
    this.invalidateAgentSnapshot();
    this.controlServer.clearBinding();
    this.currentRuntimeId = null;
    this.currentVisible = false;
    this.currentOccluded = false;
    this.setAgentControlState(false);
    this.clearHumanNavigationAllowance();
    this.resetRunApprovals();
    if (this.view && this.currentProjectId && this.currentPartition) {
      this.scheduleReleaseExpiry();
    } else {
      this.currentProjectId = null;
      this.currentPartition = null;
      this.currentState = "closed";
      this.currentError = null;
    }
    this.applyVisibility();
    this.emitStatus();
    return this.getStatus();
  }

  setRuntimeId(projectId: string, runtimeId: string | null) {
    if (this.currentProjectId !== projectId) {
      return;
    }
    this.currentRuntimeId = runtimeId;
    this.emitStatus();
  }

  getControlCredentials(projectId: string): PersonalBrowserControlCredentials | null {
    if (!this.enabled || this.currentState !== "ready" || this.currentProjectId !== projectId) {
      return null;
    }
    return this.controlServer.getCredentials(projectId);
  }

  isOwnedBy(ownerId: string): boolean {
    return this.currentOwnerId === ownerId;
  }

  private tabStatus(tab: PersonalBrowserTab): PersonalBrowserTabStatus {
    const contents = tab.view?.webContents;
    const live = contents && !contents.isDestroyed() ? contents : null;
    const title = live?.getTitle().trim() || undefined;
    return {
      id: tab.id,
      openedBy: tab.openedBy,
      active: tab === this.activeTab,
      url: live?.getURL() || "about:blank",
      ...(title ? { title } : {}),
    };
  }

  private findTab(tabId: string): PersonalBrowserTab | null {
    return this.tabs.find((tab) => tab.id === tabId) ?? null;
  }

  /**
   * Puts one tab on screen. Sharing is scoped to the page on screen, so it
   * ends; every snapshot ends too, so the next indexed step observes the tab
   * now shown.
   */
  private activateTab(tab: PersonalBrowserTab) {
    if (tab === this.activeTab) {
      return;
    }
    this.tabCapture.stop();
    this.invalidateAgentSnapshot();
    this.activeTab = tab;
    const owner = this.ownerWindow;
    if (tab.view && owner && !owner.isDestroyed()) {
      owner.contentView.addChildView(tab.view);
      tab.view.setBounds(this.fitBoundsToOwner(this.currentBounds));
      this.inputShield.attach(owner.contentView, tab.view.webContents);
    }
    this.applyVisibility();
    this.emitStatus();
  }

  private removeTab(tab: PersonalBrowserTab) {
    if (tab.openedBy !== "agent") {
      throw new Error("Only a tab the agent opened can be closed on its own.");
    }
    if (tab === this.activeTab) {
      this.activateTab(this.tabs.find((entry) => entry.openedBy === "person") ?? this.tabs[0]!);
    }
    this.tabs = this.tabs.filter((entry) => entry !== tab);
    resetTabApprovals(tab);
    tab.latestAgentSnapshot = null;
    this.destroyTabView(tab);
    this.emitStatus();
  }

  private closeAgentTabs() {
    for (const tab of this.tabs.filter((entry) => entry.openedBy === "agent")) {
      this.removeTab(tab);
    }
  }

  /** The person shows another tab. Agent control must be paused first. */
  selectTab(ownerId: string, tabId: unknown): PersonalBrowserStatus {
    if (!this.isOwnedBy(ownerId)) {
      return this.getStatus();
    }
    this.assertHumanInputAvailable();
    const tab = this.findTab(requirePersonalBrowserTabId(tabId));
    if (!tab) {
      throw new Error("That tab is no longer open.");
    }
    this.activateTab(tab);
    return this.getStatus();
  }

  /** The person closes a tab the agent opened. Agent control must be paused first. */
  closeTab(ownerId: string, tabId: unknown): PersonalBrowserStatus {
    if (!this.isOwnedBy(ownerId)) {
      return this.getStatus();
    }
    this.assertHumanInputAvailable();
    const tab = this.findTab(requirePersonalBrowserTabId(tabId));
    if (tab) {
      this.removeTab(tab);
    }
    return this.getStatus();
  }

  /**
   * Send page to Octo: reads the page on screen once for its owner, masked in
   * this process with the agent snapshot's rules, before anything leaves
   * Desktop. A secret screen, a page withheld from the agent or a page whose
   * checks failed comes back without text.
   *
   * It grants nothing. Agent control, approvals, the broker and the agent's
   * snapshot targets stay as they were, nothing is kept for a later read and
   * no page is marked; the next send reads the page again.
   */
  async readPageForOwner(ownerId: string): Promise<PersonalBrowserSentPage> {
    const contents = this.getWebContents();
    if (!this.isOwnedBy(ownerId) || this.currentState !== "ready" || !contents) {
      throw new Error("Personal Browser is not ready. Try again.");
    }
    const address = contents.getURL() || "about:blank";
    if (!/^https?:\/\//i.test(address)) {
      throw new Error("Open a web page first.");
    }
    const snapshot = await snapshotPersonalBrowserPage(contents);
    if (
      !this.isOwnedBy(ownerId) ||
      this.getWebContents() !== contents ||
      (contents.getURL() || "about:blank") !== snapshot.url
    ) {
      throw new Error("The page changed while it was read. Try again.");
    }
    // Read-only: the agent's own withholding decides, and is not consumed.
    const withhold =
      this.withheldDocumentTokens.has(snapshot.documentToken) ||
      (this.withholdNextDocumentAfter !== null && this.withholdNextDocumentAfter !== snapshot.documentToken);
    const view = maskSentPage(
      { redactUrl, redactPageObservation },
      { url: snapshot.url, title: snapshot.title, text: snapshot.text, signals: snapshot.signals ?? null },
      { withhold },
    );
    return { ...view, readAt: snapshot.capturedAt };
  }

  release(expectedOwnerId: string): PersonalBrowserStatus {
    if (!this.isOwnedBy(expectedOwnerId)) {
      return this.getStatus();
    }
    this.clearHumanInputGuidance();
    this.tabCapture.stop();
    this.cancelReleaseExpiry();
    this.controlEpoch += 1;
    this.invalidateAgentSnapshot();
    this.controlServer.clearBinding();
    this.currentOwnerId = null;
    this.currentRuntimeId = null;
    this.currentVisible = false;
    this.currentOccluded = false;
    this.setAgentControlState(false);
    this.stopInFlightNavigation();
    this.clearHumanNavigationAllowance();
    this.resetRunApprovals();
    this.applyVisibility();
    this.scheduleReleaseExpiry();
    this.emitStatus();
    return this.getStatus();
  }

  async expireRelease(lease: PersonalBrowserReleaseLease): Promise<string | null> {
    if (
      this.currentOwnerId !== null ||
      this.controlEpoch !== lease.controlEpoch ||
      this.currentProjectId !== lease.projectId ||
      this.currentPartition !== lease.partition
    ) {
      return null;
    }
    const projectId = this.currentProjectId;
    await this.close();
    return projectId;
  }

  async clearData(): Promise<PersonalBrowserStatus> {
    this.humanInputRequest = null;
    this.tabCapture.stop();
    // Agent tabs hold pages of the profile being cleared.
    this.closeAgentTabs();
    const contents = this.requireWebContents();
    this.setAgentControlState(false);
    this.controlEpoch += 1;
    this.invalidateAgentSnapshot();
    this.controlServer.clearBinding();
    this.resetRunApprovals();
    await this.runHumanNavigation(() => contents.loadURL("about:blank"));
    contents.navigationHistory.clear();
    await contents.session.clearStorageData();
    await contents.session.clearCache();
    await contents.session.clearAuthCache();
    contents.session.flushStorageData();
    // Cleared sign-ins leave nothing of a teammate's activity behind.
    this.forgetTeammateActivity(this.currentPartition);
    this.emitStatus();
    return this.getStatus();
  }

  async close(expectedOwnerId?: string): Promise<PersonalBrowserStatus> {
    if (expectedOwnerId && !this.isOwnedBy(expectedOwnerId)) {
      return this.getStatus();
    }
    this.humanInputRequest = null;
    this.tabCapture.stop();
    this.cancelReleaseExpiry();
    this.controlEpoch += 1;
    this.invalidateAgentSnapshot();
    this.closeView();
    this.controlServer.clearBinding();
    this.currentOwnerId = null;
    this.currentProjectId = null;
    this.currentPartition = null;
    this.currentRuntimeId = null;
    this.currentState = "closed";
    this.currentVisible = false;
    this.currentOccluded = false;
    this.currentError = null;
    this.setAgentControlState(false);
    this.clearHumanNavigationAllowance();
    this.resetRunApprovals();
    this.emitStatus();
    return this.getStatus();
  }

  async stop(): Promise<void> {
    await this.close();
    await this.controlServer.stop();
  }

  private createView(partition: string) {
    this.createTabView(partition, this.activeTab);
  }

  /**
   * Builds the page of one tab. Its events update that tab's own state; the
   * browser's state, error and status follow only the tab on screen.
   */
  private createTabView(partition: string, tab: PersonalBrowserTab): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        devTools: false,
        navigateOnDragDrop: false,
        safeDialogs: true,
        spellcheck: true,
      },
    });
    const isActive = () => this.activeTab === tab;
    this.configureSession(view.webContents.session);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-attach-webview", (event) => event.preventDefault());
    view.webContents.on("will-frame-navigate", (event) => {
      try {
        normalizePersonalBrowserUrl(event.url);
      } catch {
        event.preventDefault();
      }
    });
    view.webContents.on("will-navigate", (event, url) => this.guardTabNavigation(tab, event, url));
    view.webContents.on("will-redirect", (event, url) => this.guardTabNavigation(tab, event, url));
    view.webContents.on("did-navigate", (_event, url) => {
      if (isActive() && this.tabCapture.controlActive) {
        this.markTeammateActivity(this.currentPartition, url);
      }
      // An approval for a navigation that never happened ends with the page.
      tab.approvedNavigations.clear();
      if (isActive()) this.humanInputRequest = null;
      tab.latestAgentSnapshot = null;
      this.emitStatus();
    });
    view.webContents.on("did-navigate-in-page", () => {
      tab.latestAgentSnapshot = null;
      if (isActive()) {
        this.humanInputRequest = null;
        // Same-document navigation keeps the DOM alive; remove cosmetic guidance
        // while invalidating the observation that selected those fields.
        void clearPersonalBrowserHumanInput(view.webContents).catch(() => undefined);
      }
      this.emitStatus();
    });
    view.webContents.on("page-title-updated", () => this.emitStatus());
    view.webContents.on("did-stop-loading", () => {
      this.emitStatus();
    });
    view.webContents.on("did-finish-load", () => {
      tab.latestAgentSnapshot = null;
      if (isActive()) {
        this.currentState = "ready";
        this.currentError = null;
      }
      this.emitStatus();
    });
    view.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
      if (errorCode === -3 || !isActive()) {
        return;
      }
      this.currentState = "error";
      this.currentError = errorDescription;
      this.emitStatus();
    });
    view.webContents.on("render-process-gone", (_event, details) => {
      tab.latestAgentSnapshot = null;
      if (!isActive()) {
        this.emitStatus();
        return;
      }
      this.currentState = "error";
      this.currentError = `Browser renderer stopped (${details.reason}).`;
      this.setAgentControlState(false);
      this.invalidateAgentSnapshot();
      this.emitStatus();
    });
    tab.view = view;
    this.ownerWindow!.contentView.addChildView(view);
    view.setBounds(this.fitBoundsToOwner(this.currentBounds));
    if (isActive()) {
      this.inputShield.attach(this.ownerWindow!.contentView, view.webContents);
    }
    this.applyVisibility();
    return view;
  }

  private configureSession(session: Session) {
    if (configuredPersonalBrowserSessions.has(session)) {
      return;
    }
    configuredPersonalBrowserSessions.add(session);
    session.setPermissionCheckHandler(() => false);
    session.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(this.tabCapture.allowsVideoCapture(contents, permission, details)));
    session.on("will-download", (event) => event.preventDefault());
  }

  private closeView() {
    const tabs = this.tabs;
    // A fresh person's tab replaces every tab, the agent's included.
    this.tabs = [];
    this.nextTabNumber = 1;
    this.activeTab = this.addTab("person");
    this.inputShield.destroy();
    for (const tab of tabs) this.destroyTabView(tab);
    if (tabs.some((tab) => tab.view) && this.ownerWindow && !this.ownerWindow.isDestroyed()) {
      this.ownerWindow.webContents.focus();
    }
  }

  private destroyTabView(tab: PersonalBrowserTab) {
    const view = tab.view;
    if (!view) {
      return;
    }
    if (this.ownerWindow && !this.ownerWindow.isDestroyed()) {
      this.ownerWindow.contentView.removeChildView(view);
    }
    if (!view.webContents.isDestroyed()) {
      view.webContents.close({ waitForBeforeUnload: false });
    }
  }

  private cancelReleaseExpiry() {
    if (!this.releaseCloseTimer) {
      return;
    }
    clearTimeout(this.releaseCloseTimer);
    this.releaseCloseTimer = null;
  }

  private scheduleReleaseExpiry() {
    const projectId = this.currentProjectId;
    const partition = this.currentPartition;
    if (!projectId || !partition) {
      return;
    }
    const lease: PersonalBrowserReleaseLease = {
      controlEpoch: this.controlEpoch,
      projectId,
      partition,
    };
    const timer = setTimeout(() => {
      if (this.releaseCloseTimer !== timer) {
        return;
      }
      this.releaseCloseTimer = null;
      this.onReleaseExpiry(lease);
    }, PERSONAL_BROWSER_RELEASE_GRACE_MS);
    timer.unref();
    this.releaseCloseTimer = timer;
  }

  private isOpenIdentityCurrent(epoch: number, projectId: string, partition: string): boolean {
    return Boolean(
      this.ownerWindow &&
        !this.ownerWindow.isDestroyed() &&
        this.controlEpoch === epoch &&
        this.currentProjectId === projectId &&
        this.currentPartition === partition,
    );
  }

  private isOpenOwnerCurrent(
    epoch: number,
    projectId: string,
    partition: string,
    ownerId: string,
  ): boolean {
    return (
      this.isOpenIdentityCurrent(epoch, projectId, partition) &&
      this.currentOwnerId === ownerId
    );
  }

  private applyVisibility() {
    // Only the active tab is on screen; the agent acts on no other.
    for (const tab of this.tabs) {
      if (tab !== this.activeTab) tab.view?.setVisible(false);
    }
    this.view?.setVisible(this.currentVisible && !this.currentOccluded);
    this.syncInputShield();
    if ((!this.currentVisible || this.currentOccluded) && this.ownerWindow && !this.ownerWindow.isDestroyed()) {
      this.ownerWindow.webContents.focus();
    }
  }

  private setAgentControlState(enabled: boolean) {
    if (!enabled) {
      this.approvalMode = "ask";
      this.runKnownHosts = [];
      this.takeoverRequestId = undefined;
    }
    this.agentControlEnabled = enabled;
    this.updateHumanControlDrain();
    this.syncInputShield();
  }

  private updateHumanControlDrain() {
    if (this.agentControlEnabled || this.activeControlOperations === 0 || !this.getWebContents()) {
      if (this.humanControlDrainTimer) clearTimeout(this.humanControlDrainTimer);
      this.humanControlDrainTimer = null;
      if (this.currentError === HUMAN_CONTROL_DRAIN_ERROR) this.currentError = null;
      return;
    }
    if (!this.humanControlDrainTimer) {
      this.humanControlDrainTimer = setTimeout(() => {
        // A timeout is a visible error, never proof that native work stopped.
        if (!this.agentControlEnabled && this.activeControlOperations > 0 && this.getWebContents()) {
          this.currentError = HUMAN_CONTROL_DRAIN_ERROR;
          this.emitStatus();
        }
      }, HUMAN_CONTROL_DRAIN_TIMEOUT_MS);
      this.humanControlDrainTimer.unref();
    }
  }

  private syncInputShield() {
    this.inputShield.sync(
      this.agentControlEnabled || this.activeControlOperations > 0 || this.tabCapture.controlActive,
      this.currentVisible && !this.currentOccluded,
      this.fitBoundsToOwner(this.currentBounds),
      this.tabCapture.controlActive || (this.agentControlEnabled && this.currentBounds.agentWorking === true),
      this.tabCapture.controlActive ? "participant" : "agent",
    );
    // Adding the native shield for a new grant must not steal menu keyboard focus.
    if (this.currentOccluded && this.ownerWindow && !this.ownerWindow.isDestroyed()) {
      this.ownerWindow.webContents.focus();
    }
  }

  private emergencyPauseAgentControl() {
    // Escape also cancels a sign-in handoff's kept mode.
    this.handoffResume = null;
    if (this.tabCapture.controlActive) { this.tabCapture.revokeControl(); return; }
    if (!this.agentControlEnabled) {
      return;
    }
    const projectId = this.currentProjectId;
    this.pauseAgentControl();
    this.logger("info", "[instafy-desktop] personal-browser-agent-control-escaped", {
      ...(projectId ? { projectId } : {}),
    });
    if (projectId) {
      this.onEmergencyPause(projectId);
    }
  }

  private getWebContents(): WebContents | null {
    const contents = this.view?.webContents ?? null;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  private requireWebContents(): WebContents {
    const contents = this.getWebContents();
    if (!contents) {
      throw new Error("Personal Browser is not open.");
    }
    return contents;
  }

  private assertAvailable() {
    if (!this.supported) {
      throw new Error("Personal Browser is not supported by this Electron version.");
    }
    if (!this.enabled) {
      throw new Error("Personal Browser was disabled by this desktop installation.");
    }
  }

  private assertHumanInputAvailable() {
    if (this.tabCapture.controlActive) throw new Error("Take back tab control before navigating.");
    if (this.agentControlEnabled || this.activeControlOperations > 0) {
      throw new Error("Pause Personal Browser agent control and wait for active operations to stop before navigating manually.");
    }
  }

  private fitBoundsToOwner(bounds: PersonalBrowserBounds): Electron.Rectangle {
    const ownerBounds = this.ownerWindow?.getContentBounds();
    if (!ownerBounds) {
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    }
    const x = Math.min(bounds.x, Math.max(0, ownerBounds.width - 1));
    const y = Math.min(bounds.y, Math.max(0, ownerBounds.height - 1));
    return {
      x,
      y,
      width: Math.max(1, Math.min(bounds.width, ownerBounds.width - x)),
      height: Math.max(1, Math.min(bounds.height, ownerBounds.height - y)),
    };
  }

  private async runHumanNavigation(operation: () => Promise<unknown> | unknown) {
    this.invalidateAgentSnapshot();
    const navigationEpoch = ++this.humanNavigationEpoch;
    this.humanNavigationInFlight = true;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          this.stopInFlightNavigation();
          reject(new Error("Personal Browser navigation timed out."));
        }, PERSONAL_BROWSER_NAVIGATION_TIMEOUT_MS);
        timeout.unref();
      });
      await Promise.race([Promise.resolve().then(operation), timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      setTimeout(() => {
        if (this.humanNavigationEpoch === navigationEpoch) {
          this.humanNavigationInFlight = false;
        }
      }, 1_000).unref();
    }
  }

  private clearHumanNavigationAllowance() {
    this.humanNavigationEpoch += 1;
    this.humanNavigationInFlight = false;
  }

  private stopInFlightNavigation() {
    const contents = this.getWebContents();
    if (contents?.isLoading()) {
      contents.stop();
    }
  }

  private guardTabNavigation(tab: PersonalBrowserTab, event: Event, rawUrl: string) {
    const agentActing = this.agentControlEnabled || this.activeControlOperations > 0;
    // A page in a tab the agent opened stays on public addresses while the
    // agent has control, also when the page or a redirect moves it.
    if (tab.openedBy === "agent" && agentActing && !personalBrowserAgentTabHopIsPublic(rawUrl)) {
      event.preventDefault();
      return;
    }
    if (tab === this.activeTab) {
      this.guardPageNavigation(event, rawUrl);
      return;
    }
    let targetUrl: string;
    try {
      targetUrl = normalizePersonalBrowserUrl(rawUrl);
    } catch {
      event.preventDefault();
      return;
    }
    if (!agentActing) {
      return;
    }
    // A tab that is not on screen never asks the person anything. While the
    // agent has control, a navigation its page starts that would ask (a
    // risky address, or a site not yet allowed in that tab) is stopped.
    const targetOrigin = getPersonalBrowserOrigin(targetUrl);
    let currentOrigin: string | null = null;
    try {
      currentOrigin = getPersonalBrowserOrigin(tab.view?.webContents.getURL() || "about:blank");
    } catch {
      currentOrigin = null;
    }
    if (
      classifyAddress(targetUrl) ||
      (targetOrigin && targetOrigin !== currentOrigin && !this.siteSkipsPrompt(targetOrigin) && !tab.approvedOrigins.has(targetOrigin))
    ) {
      event.preventDefault();
    }
  }

  private guardPageNavigation(event: Event, rawUrl: string) {
    let targetUrl: string;
    try {
      targetUrl = normalizePersonalBrowserUrl(rawUrl);
    } catch {
      event.preventDefault();
      return;
    }
    if (!this.agentControlEnabled && this.activeControlOperations > 0) {
      event.preventDefault();
      return;
    }
    if (this.humanNavigationInFlight || !this.agentControlEnabled) {
      return;
    }
    const targetOrigin = getPersonalBrowserOrigin(targetUrl);
    const currentOrigin = getPersonalBrowserOrigin(this.getWebContents()?.getURL() || "about:blank");
    // A risky address asks in every mode, also when the page or a redirect
    // opens it, unless an approved step is opening exactly that address.
    const risky = classifyAddress(targetUrl);
    const pageContents = this.getWebContents();
    if (risky && !this.consumeApprovedNavigation(targetUrl)) {
      event.preventDefault();
      const epoch = this.controlEpoch;
      void this.requestNavigationApproval(targetUrl, risky.category).then(async (approved) => {
        if (!approved) {
          this.recordDeniedPageNavigation(epoch);
          return;
        }
        if (epoch !== this.controlEpoch) return;
        if (targetOrigin && targetOrigin !== currentOrigin && !(await this.requestOriginApproval(targetOrigin))) {
          this.recordDeniedPageNavigation(epoch);
          return;
        }
        if (epoch !== this.controlEpoch || !pageContents || this.getWebContents() !== pageContents) return;
        this.approveNavigation(targetUrl);
        void pageContents.loadURL(targetUrl).catch((error) => {
          this.logger("warn", "[instafy-desktop] personal-browser-approved-navigation-failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      });
      return;
    }
    if (!targetOrigin || targetOrigin === currentOrigin || this.siteSkipsPrompt(targetOrigin) || this.approvedOrigins.has(targetOrigin)) {
      return;
    }
    event.preventDefault();
    const originEpoch = this.controlEpoch;
    void this.requestOriginApproval(targetOrigin).then((approved) => {
      if (!approved) this.recordDeniedPageNavigation(originEpoch);
      if (approved && pageContents && this.getWebContents() === pageContents) {
        void pageContents.loadURL(targetUrl).catch((error) => {
          this.logger("warn", "[instafy-desktop] personal-browser-approved-navigation-failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    });
  }

  private recordDeniedPageNavigation(epoch: number) {
    if (epoch === this.controlEpoch && this.agentControlEnabled) {
      this.deniedPageNavigationEpoch = epoch;
    }
  }

  /**
   * Routine runs show no per-site prompt, unless a teammate acted in this
   * profile: then every site asks except the card's hosts the owner allowed
   * in the start dialog.
   */
  private siteSkipsPrompt(origin: string): boolean {
    if (this.approvalMode !== "routine") return false;
    if (!this.currentTeammateActivity()) return true;
    const site = siteName(origin);
    return site !== null && this.runKnownHosts.some((host) => host.replace(/^www\./, "") === site);
  }

  private currentTeammateActivity(): PersonalBrowserTeammateActivity | null {
    const partition = this.currentPartition;
    if (!partition) return null;
    try {
      return this.teammateActivity.read(partition);
    } catch {
      // Unknown means marked: the prompts come back.
      return { sites: [], markedAtMs: 0 };
    }
  }

  private markTeammateActivity(partition: string | null, url: string | null) {
    if (!partition) return;
    try {
      this.teammateActivity.mark(partition, url);
    } catch (error) {
      this.logger("warn", "[instafy-desktop] personal-browser-teammate-activity-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private forgetTeammateActivity(partition: string | null) {
    if (!partition) return;
    try {
      this.teammateActivity.clear(partition);
    } catch (error) {
      this.logger("warn", "[instafy-desktop] personal-browser-teammate-activity-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // A link or address is approved with its query. A form's action is
  // approved by its path, because a GET form adds its fields as the query.
  private navigationKey(url: string, anyQuery: boolean): string | null {
    try {
      const parsed = new URL(url);
      return anyQuery
        ? `path:${parsed.origin}${parsed.pathname}`
        : `url:${parsed.origin}${parsed.pathname}${parsed.search}`;
    } catch {
      return null;
    }
  }

  /**
   * Lets the navigation an approved step starts through without a second
   * prompt: one use, shortly after, and only until the next page loads.
   */
  private approveNavigation(url: string | null | undefined, options: { anyQuery?: boolean } = {}) {
    const key = url ? this.navigationKey(url, options.anyQuery === true) : null;
    if (!key) return;
    const now = Date.now();
    for (const [entry, expiresAt] of this.approvedNavigations) {
      if (expiresAt <= now) this.approvedNavigations.delete(entry);
    }
    this.approvedNavigations.set(key, now + APPROVED_NAVIGATION_TTL_MS);
  }

  private consumeApprovedNavigation(url: string): boolean {
    for (const key of [this.navigationKey(url, false), this.navigationKey(url, true)]) {
      const expiresAt = key ? this.approvedNavigations.get(key) : undefined;
      if (!key || expiresAt === undefined) continue;
      this.approvedNavigations.delete(key);
      if (expiresAt > Date.now()) return true;
    }
    return false;
  }

  private requestNavigationApproval(url: string, category: string): Promise<boolean> {
    // The approval belongs to the tab on screen when it was asked for.
    const tab = this.activeTab;
    const pending = tab.pendingNavigationApprovals.get(url);
    if (pending) return pending;
    const approval = this.confirmAgentNavigation(url, category)
      .then((approved) => approved && this.activeTab === tab)
      .finally(() => {
        if (tab.pendingNavigationApprovals.get(url) === approval) {
          tab.pendingNavigationApprovals.delete(url);
        }
      });
    tab.pendingNavigationApprovals.set(url, approval);
    return approval;
  }

  private typingApprovalKey(descriptor: PersonalBrowserTargetDescriptor, category: string): string {
    const form = descriptor.formOwnerIdentity?.trim();
    return `${this.controlEpoch}|${category}|${form ? `form:${form}` : `field:${descriptor.identity ?? ""}`}`;
  }

  private rememberTypingApproval(key: string) {
    this.typingApprovals.add(key);
    while (this.typingApprovals.size > MAX_TYPING_APPROVALS) {
      const oldest = this.typingApprovals.values().next().value;
      if (oldest === undefined) break;
      this.typingApprovals.delete(oldest);
    }
  }

  private async requestOriginApproval(origin: string): Promise<boolean> {
    // A site is allowed in the tab on screen when the person was asked, and
    // only in that tab.
    const tab = this.activeTab;
    if (this.siteSkipsPrompt(origin) || tab.approvedOrigins.has(origin)) {
      return true;
    }
    const pending = tab.pendingOriginApprovals.get(origin);
    if (pending) {
      return pending;
    }
    const epoch = this.controlEpoch;
    const approval = this.promptForOriginApproval(origin).then((approved) => {
      if (!approved || epoch !== this.controlEpoch || !this.tabs.includes(tab)) {
        return false;
      }
      tab.approvedOrigins.add(origin);
      return this.activeTab === tab;
    });
    const finalizedApproval = approval.finally(() => {
      if (tab.pendingOriginApprovals.get(origin) === finalizedApproval) {
        tab.pendingOriginApprovals.delete(origin);
      }
    });
    tab.pendingOriginApprovals.set(origin, finalizedApproval);
    return finalizedApproval;
  }

  private async promptForOriginApproval(origin: string): Promise<boolean> {
    const owner = this.ownerWindow;
    if (!owner || owner.isDestroyed() || !owner.isVisible()) {
      return false;
    }
    const host = new URL(origin).host;
    const teammateNote = this.approvalMode === "routine" && this.currentTeammateActivity()
      ? "A teammate used this browser profile, so the agent asks for each site until you forget that activity. "
      : "";
    const result = await dialog.showMessageBox(owner, {
      type: "question",
      title: "Allow agent browser access?",
      message: `Allow the agent to use ${host}?`,
      detail:
        `${teammateNote}This lets the current project read and interact with this site in this tab of your Personal Browser for this session. Password, verification-code, and payment fields remain blocked.`,
      buttons: ["Deny", "Allow for this session"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1;
  }

  private async confirmAgentActivation(
    descriptor: PersonalBrowserTargetDescriptor,
    options: { formSubmission?: boolean; fill?: boolean; category?: string; typedText?: string } = {},
  ): Promise<boolean> {
    const owner = this.ownerWindow;
    if (!owner || owner.isDestroyed() || !owner.isVisible()) {
      return false;
    }
    const epoch = this.controlEpoch;
    const categoryName = options.category ? categoryTitle(options.category) : null;
    const categoryDetail = options.category ? STEP_DIALOG_DETAILS[options.category] : undefined;
    const fillDetail = descriptor.formOwnerIdentity?.trim()
      ? "One approval covers every field of this form on this page."
      : "One approval covers this field on this page.";
    const genericDetail = options.formSubmission
      ? `${options.fill ? `${fillDetail} ` : ""}This sends the form to the site and may navigate or change site state. Review it before allowing once.`
      : options.fill
        ? `${fillDetail} Submitting still asks. Review it before allowing.`
        : "This activates the selected page control and may navigate or change site state. Review it before allowing once.";
    const result = await dialog.showMessageBox(owner, {
      type: "warning",
      // The title names what kind of step this is.
      title: categoryName ?? (options.formSubmission ? "Confirm form submission" : "Confirm agent action"),
      message: options.formSubmission
        ? `Allow the agent to ${options.fill ? "fill in and submit" : "submit"} ${formSubmissionDescription(descriptor)}?`
        : options.fill
          ? `Allow the agent to fill in ${fillDescription(descriptor)}?`
          : `Allow the agent to activate ${activationLabel(descriptor)}?`,
      detail: [typedTextDetail(options.typedText), categoryDetail, genericDetail].filter(Boolean).join(" "),
      buttons: ["Deny", "Allow once"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1 && epoch === this.controlEpoch;
  }

  private async confirmAgentNavigation(url: string, category?: string): Promise<boolean> {
    const owner = this.ownerWindow;
    if (!owner || owner.isDestroyed() || !owner.isVisible()) {
      return false;
    }
    const epoch = this.controlEpoch;
    const parsed = new URL(url);
    const label = `${parsed.host}${parsed.pathname}${parsed.search}`.slice(0, 240);
    const categoryDetail = category ? STEP_DIALOG_DETAILS[category] : undefined;
    const genericDetail = "This is a one-time navigation in your Personal Browser. Review the destination before allowing it.";
    const result = await dialog.showMessageBox(owner, {
      type: "question",
      title: (category ? categoryTitle(category) : null) ?? "Confirm agent navigation",
      message: `Allow the agent to open “${label}”?`,
      detail: categoryDetail ? `${categoryDetail} ${genericDetail}` : genericDetail,
      buttons: ["Deny", "Allow once"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1 && epoch === this.controlEpoch;
  }

  private async requireCurrentOriginApproval(): Promise<void> {
    const contents = this.requireWebContents();
    const currentUrl = contents.getURL() || "about:blank";
    const currentOrigin = getPersonalBrowserOrigin(currentUrl);
    if (!currentOrigin) {
      return;
    }
    if (!(await this.requestOriginApproval(currentOrigin))) {
      throw new PersonalBrowserControlError(
        403,
        "origin_not_approved",
        "The user did not approve agent access to this origin.",
      );
    }
    if ((contents.getURL() || "about:blank") !== currentUrl) {
      throw new PersonalBrowserControlError(
        409,
        "page_changed",
        "The page changed while awaiting origin approval.",
      );
    }
  }

  private getBrokerStatus(): PersonalBrowserStatus {
    return { ...this.getPageBrokerStatus(), tabs: this.agentTabList() };
  }

  private getPageBrokerStatus(): PersonalBrowserStatus {
    const status = this.getStatus();
    let originApproved = false;
    if (this.agentControlEnabled) {
      try {
        const origin = getPersonalBrowserOrigin(status.url || "about:blank");
        originApproved = !origin || this.siteSkipsPrompt(origin) || this.approvedOrigins.has(origin);
      } catch {
        originApproved = false;
      }
    }
    if (!originApproved) {
      return sanitizePersonalBrowserBrokerStatus(status, false);
    }
    try {
      // Status is read without a page observation. The title gets the same
      // masking a snapshot title gets from its own words, and a load error,
      // which can quote the full address, is masked like a log line.
      const url = redactUrl(status.url).text;
      const title = status.title === undefined
        ? undefined
        : redactText(status.title, { credentialContext: hasCredentialWord(status.title) }).text;
      const redacted = { ...status, url };
      if (title === undefined) delete redacted.title;
      else redacted.title = title;
      if (typeof redacted.error === "string") redacted.error = redactLogValue(redacted.error);
      return redacted;
    } catch {
      return sanitizePersonalBrowserBrokerStatus(status, false);
    }
  }

  private invalidateAgentSnapshot() {
    for (const tab of this.tabs) tab.latestAgentSnapshot = null;
  }

  private clearHumanInputGuidance() {
    this.humanInputRequest = null;
    const contents = this.getWebContents();
    if (contents) void clearPersonalBrowserHumanInput(contents).catch(() => undefined);
  }

  private rememberAgentSnapshot(
    snapshot: PersonalBrowserPageSnapshot,
  ): Omit<PersonalBrowserPageSnapshot, "documentToken" | "interactive" | "signals"> & {
    secretScreen?: true;
    message?: string;
    interactive: Array<{
      index: number;
      tag: string;
      role?: string;
      name?: string;
      type?: string;
      disabled: boolean;
    }>;
  } {
    const origin = getPersonalBrowserOrigin(snapshot.url);
    const targets = new Map<number, PersonalBrowserResolvedTarget>();
    for (const entry of snapshot.interactive) {
      if (
        !entry.identity.startsWith(`${snapshot.documentToken}:`) ||
        entry.descriptor.identity !== entry.identity ||
        !entry.descriptor.found
      ) {
        throw new PersonalBrowserControlError(
          409,
          "invalid_snapshot",
          "Personal Browser could not establish a stable target snapshot.",
        );
      }
      targets.set(entry.index, {
        url: snapshot.url,
        origin,
        descriptor: entry.descriptor,
      });
    }
    this.latestAgentSnapshot = {
      controlEpoch: this.controlEpoch,
      url: snapshot.url,
      origin,
      documentToken: snapshot.documentToken,
      targets,
    };
    return this.redactAgentSnapshot(snapshot);
  }

  private shouldWithholdDocument(documentToken: string): boolean {
    if (this.withheldDocumentTokens.has(documentToken)) {
      return true;
    }
    if (this.withholdNextDocumentAfter !== null && this.withholdNextDocumentAfter !== documentToken) {
      this.withholdNextDocumentAfter = null;
      return true;
    }
    return false;
  }

  private withholdDocument(documentToken: string) {
    this.withheldDocumentTokens.delete(documentToken);
    this.withheldDocumentTokens.add(documentToken);
    while (this.withheldDocumentTokens.size > MAX_WITHHELD_DOCUMENTS) {
      const oldest = this.withheldDocumentTokens.values().next().value;
      if (oldest === undefined) break;
      this.withheldDocumentTokens.delete(oldest);
    }
  }

  /**
   * Withholds the page a credential step ran on until a new page loads. When
   * the step may open another page, that page is withheld as well.
   */
  private withholdAfterCredentialStep(identity: string | null | undefined, opensPage: boolean) {
    const documentToken = identity?.split(":", 1)[0];
    if (!documentToken) {
      return;
    }
    this.withholdDocument(documentToken);
    if (opensPage) {
      this.withholdNextDocumentAfter = documentToken;
    }
  }

  // Every page observation passes through redaction before it leaves the main
  // process, in every approval mode and on every site. A failure withholds it.
  private redactAgentSnapshot(snapshot: PersonalBrowserPageSnapshot) {
    const withhold = this.shouldWithholdDocument(snapshot.documentToken);
    const rawNames = snapshot.interactive.map((entry) => entry.name);
    const describe = (
      { index, tag, role, type, disabled }: PersonalBrowserPageSnapshot["interactive"][number],
      name: string | undefined,
    ) => ({
      index,
      tag,
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(type ? { type } : {}),
      disabled,
    });
    try {
      if (!snapshot.signals) {
        throw new Error("Page secret signals are missing.");
      }
      const redacted = redactPageObservation({
        url: snapshot.url,
        title: snapshot.title,
        text: snapshot.text,
        names: rawNames,
        signals: snapshot.signals,
        withhold,
      });
      if (redacted.secretScreen) {
        this.withholdDocument(snapshot.documentToken);
      }
      return {
        url: redacted.url,
        title: redacted.title,
        text: redacted.text,
        capturedAt: snapshot.capturedAt,
        ...(redacted.secretScreen ? { secretScreen: true as const, message: redacted.message } : {}),
        interactive: snapshot.interactive.map((entry, position) => describe(entry, redacted.names[position])),
      };
    } catch {
      this.withholdDocument(snapshot.documentToken);
      return {
        url: "",
        title: "",
        text: "",
        capturedAt: snapshot.capturedAt,
        secretScreen: true as const,
        message: "This page could not be checked for secrets, so it is withheld. Navigate to another page or ask the user to continue.",
        interactive: snapshot.interactive.map((entry) => describe(entry, undefined)),
      };
    }
  }

  private consumeAgentSnapshotTarget(index: number): PersonalBrowserResolvedTarget {
    return this.consumeAgentSnapshotTargets([index])[0]!;
  }

  private consumeAgentSnapshotTargets(indices: number[]): PersonalBrowserResolvedTarget[] {
    const snapshot = this.latestAgentSnapshot;
    // Snapshot capabilities are one-shot. Consuming before any approval dialog also prevents a
    // concurrent request from racing the same observed target while the user is deciding.
    this.latestAgentSnapshot = null;
    if (!snapshot || snapshot.controlEpoch !== this.controlEpoch) {
      throw new PersonalBrowserControlError(
        409,
        "fresh_snapshot_required",
        "Take a fresh Personal Browser snapshot before this action.",
      );
    }
    const currentUrl = this.requireWebContents().getURL() || "about:blank";
    if (currentUrl !== snapshot.url) {
      throw new PersonalBrowserControlError(
        409,
        "page_changed",
        "The page changed after the Personal Browser snapshot was taken.",
      );
    }
    return indices.map((index) => {
      const target = snapshot.targets.get(index);
      if (!target || !target.descriptor.identity?.startsWith(`${snapshot.documentToken}:`)) {
        throw new PersonalBrowserControlError(
          404,
          "target_not_available",
          "The requested target was not present in the latest Personal Browser snapshot.",
        );
      }
      return target;
    });
  }

  private async resolveControlTarget(
    contents: WebContents,
    target: { index: number },
  ): Promise<PersonalBrowserResolvedTarget> {
    const url = contents.getURL() || "about:blank";
    const origin = getPersonalBrowserOrigin(url);
    const descriptor = await inspectPersonalBrowserTarget(contents, target);
    const resolvedUrl = contents.getURL() || "about:blank";
    if (url !== resolvedUrl) {
      throw new PersonalBrowserControlError(
        409,
        "page_changed",
        "The page changed while resolving the browser target.",
      );
    }
    if (!descriptor.found || !descriptor.identity || descriptor.disabled) {
      throw new PersonalBrowserControlError(
        404,
        "target_not_available",
        "Browser target is missing or disabled.",
      );
    }
    return { url, origin, descriptor };
  }

  private async revalidateControlTarget(
    contents: WebContents,
    target: { index: number },
    expected: PersonalBrowserResolvedTarget,
    options: { compareSecurity?: boolean } = {},
  ): Promise<PersonalBrowserResolvedTarget> {
    const current = await this.resolveControlTarget(contents, target);
    if (
      !personalBrowserActivationTargetsMatch(expected, current, {
        compareSecurity: options.compareSecurity,
      })
    ) {
      throw new PersonalBrowserControlError(
        409,
        "target_changed",
        "The page or browser target changed while awaiting approval.",
      );
    }
    return current;
  }

  /** Refusals apply in every approval mode and never show a dialog. */
  private assertStepNotRefused(step: PersonalBrowserStepClassification) {
    if (step.verdict !== "refuse") {
      return;
    }
    const refusal = refusalFor(step.category);
    throw new PersonalBrowserControlError(
      403,
      step.code ?? refusal?.code ?? "step_refused",
      refusal?.message ?? "This browser step is the user's to take.",
    );
  }

  private withholdIfSecretRevealing(
    step: PersonalBrowserStepClassification,
    descriptor: PersonalBrowserTargetDescriptor,
    opensPage: boolean,
  ) {
    if (SECRET_REVEALING_CATEGORIES.has(step.category)) {
      this.withholdAfterCredentialStep(descriptor.identity, opensPage);
    }
  }

  private assertNonSensitiveActivation(descriptor: PersonalBrowserTargetDescriptor) {
    if (isSensitivePersonalBrowserEditable(descriptor)) {
      throw new PersonalBrowserControlError(
        403,
        "sensitive_input_blocked",
        "Agent activation of password, verification-code, or payment fields is blocked.",
      );
    }
  }

  private expectedMutationTarget(resolved: PersonalBrowserResolvedTarget) {
    return personalBrowserTargetExpectation(
      resolved.descriptor,
      personalBrowserTargetSecurityFingerprint(resolved.descriptor),
    );
  }

  private assertAtomicMutationTarget(
    result: { targetChanged: boolean },
    message: string,
  ) {
    if (result.targetChanged) {
      throw new PersonalBrowserControlError(409, "target_changed", message);
    }
  }

  private assertAgentControlReady() {
    if (!this.agentControlEnabled) {
      throw new PersonalBrowserControlError(423, "agent_control_paused", "Personal Browser agent control is paused.");
    }
    if (this.currentState !== "ready" || !this.getWebContents()) {
      throw new PersonalBrowserControlError(409, "browser_not_ready", "Personal Browser is not ready.");
    }
  }

  private async handleControlOperation(
    operation: PersonalBrowserControlOperation,
    rawPayload: unknown,
  ): Promise<Record<string, unknown>> {
    if (operation === "status") {
      return { status: this.getBrokerStatus() };
    }
    this.assertAgentControlReady();
    this.activeControlOperations += 1;
    try {
      return await this.performControlOperation(operation, rawPayload);
    } finally {
      this.activeControlOperations -= 1;
      this.updateHumanControlDrain();
      this.syncInputShield();
      this.emitStatus();
    }
  }

  private async performControlOperation(
    operation: PersonalBrowserControlOperation,
    rawPayload: unknown,
  ): Promise<Record<string, unknown>> {
    const operationEpoch = this.controlEpoch;
    this.assertAgentControlReady();
    const contents = this.requireWebContents();
    if (this.deniedPageNavigationEpoch === operationEpoch) {
      // The previous step's click or key went through, but the page it tried
      // to open was denied. Report that once instead of failing silently.
      this.deniedPageNavigationEpoch = null;
      throw new PersonalBrowserControlError(
        403,
        "navigation_denied",
        "The user denied the page navigation your previous step started. Treat that step as denied and do not retry it.",
      );
    }

    if (operation === "list_tabs") {
      return { tabs: this.agentTabList(), activeTabId: this.activeTab.id, maxAgentTabs: MAX_PERSONAL_BROWSER_AGENT_TABS };
    }

    if ((operation === "open_tab" || operation === "select_tab" || operation === "close_tab") && this.activeControlOperations > 1) {
      // Changing the tab on screen never races another step's approval.
      throw new PersonalBrowserControlError(409, "browser_busy", "Another browser step is still running. Wait for it, then change tabs.");
    }

    if (operation === "open_tab") {
      return this.openAgentTab(payloadRecord(rawPayload), operationEpoch);
    }

    if (operation === "select_tab" || operation === "close_tab") {
      const payload = payloadRecord(rawPayload);
      const tab = this.requireAgentVisibleTab(payload.tabId);
      if (operation === "close_tab") {
        if (tab.openedBy !== "agent") {
          throw new PersonalBrowserControlError(403, "tab_not_agent_owned", "Only tabs the agent opened can be closed. The person's own tab stays open.");
        }
        this.removeTab(tab);
        return { closed: tab.id, status: this.getBrokerStatus() };
      }
      if (tab !== this.activeTab && this.tabCapture.active) {
        throw new PersonalBrowserControlError(409, "tab_share_active", "The person is sharing the tab on screen. Another tab can be shown once sharing stops.");
      }
      this.activateTab(tab);
      return { status: this.getBrokerStatus() };
    }

    if (operation === "navigate") {
      const payload = payloadRecord(rawPayload);
      const url = normalizePersonalBrowserUrl(payload.url);
      if (this.activeTab.openedBy === "agent" && url !== "about:blank") {
        await this.requirePublicAgentTabUrl(url, operationEpoch);
      }
      return this.navigateActiveTab(url, operationEpoch);
    }

    await this.requireCurrentOriginApproval();

    if (operation === "snapshot") {
      const snapshot = await snapshotPersonalBrowserPage(contents);
      this.assertControlEpoch(operationEpoch);
      if ((contents.getURL() || "about:blank") !== snapshot.url) {
        throw new PersonalBrowserControlError(
          409,
          "page_changed",
          "The page changed while the Personal Browser snapshot was captured.",
        );
      }
      return { snapshot: this.rememberAgentSnapshot(snapshot) };
    }

    const payload = payloadRecord(rawPayload);
    if (operation === "request_human_input") {
      const indices = requireHumanInputIndices(payload);
      const observed = this.consumeAgentSnapshotTargets(indices);
      const origin = getPersonalBrowserOrigin(contents.getURL());
      if (!origin) throw new PersonalBrowserControlError(409, "page_changed", "A live approved page is required.");
      const highlighted = await highlightPersonalBrowserHumanInput(contents, indices.map((index, ordinal) => ({
        index,
        expectation: personalBrowserTargetExpectation(observed[ordinal]!.descriptor, personalBrowserTargetSecurityFingerprint(observed[ordinal]!.descriptor)),
      })));
      this.assertControlEpoch(operationEpoch);
      if (!highlighted || getPersonalBrowserOrigin(contents.getURL()) !== origin) {
        throw new PersonalBrowserControlError(409, "page_changed", "The fields changed; take a fresh snapshot.");
      }
      const createdAtMs = Date.now();
      const handoffMode = this.approvalMode;
      const handoffHosts = this.runKnownHosts;
      this.humanInputRequest = {
        version: 1, handoffId: randomUUID(), origin, createdAtMs,
        expiresAtMs: createdAtMs + 600_000,
        fields: indices.map((_, index) => ({ label: `Highlighted field ${index + 1}` })),
      };
      this.pauseAgentControl();
      if (this.currentProjectId && this.currentPartition && this.currentOwnerId) {
        this.handoffResume = {
          handoffId: this.humanInputRequest.handoffId,
          projectId: this.currentProjectId,
          partition: this.currentPartition,
          ownerId: this.currentOwnerId,
          approvalMode: handoffMode,
          knownHosts: handoffHosts,
          expiresAtMs: this.humanInputRequest.expiresAtMs,
        };
      }
      if (this.currentProjectId) this.onEmergencyPause(this.currentProjectId);
      this.emitStatus();
      return { humanInputRequired: true, message: "Control has been revoked. The user will fill the highlighted fields directly and explicitly start a fresh browser turn. Do not request or repeat their values." };
    }
    if (operation === "scroll") {
      const amount = normalizePersonalBrowserScroll(payload);
      this.assertControlEpoch(operationEpoch);
      this.invalidateAgentSnapshot();
      const position = await scrollPersonalBrowserPage(contents, amount);
      this.assertControlEpoch(operationEpoch);
      return { position };
    }

    const target = requirePersonalBrowserTarget(payload);
    const snapshotTarget = this.consumeAgentSnapshotTarget(target.index);
    let resolvedTarget = await this.revalidateControlTarget(contents, target, snapshotTarget);

    if (operation === "click") {
      const pageUrl = contents.getURL() || "about:blank";
      let step = classifyPersonalBrowserStep("click", resolvedTarget.descriptor, { pageUrl });
      this.assertStepNotRefused(step);
      if (resolvedTarget.descriptor.href) {
        let hrefOrigin: string | null;
        try {
          hrefOrigin = getPersonalBrowserOrigin(resolvedTarget.descriptor.href);
        } catch {
          throw new PersonalBrowserControlError(
            400,
            "unsupported_navigation",
            "Personal Browser cannot open this link type.",
          );
        }
        if (hrefOrigin && !(await this.requestOriginApproval(hrefOrigin))) {
          throw new PersonalBrowserControlError(403, "origin_not_approved", "The user denied access to the link origin.");
        }
        this.assertControlEpoch(operationEpoch);
        resolvedTarget = await this.revalidateControlTarget(contents, target, resolvedTarget);
      }
      const activationApproved = personalBrowserActivationRequiresConfirmation(
        resolvedTarget.descriptor,
        this.approvalMode,
        { pageUrl },
      );
      if (activationApproved) {
        if (!(await this.confirmAgentActivation(resolvedTarget.descriptor, { category: step.category }))) {
          throw new PersonalBrowserControlError(403, "activation_denied", "The user denied the browser activation.");
        }
        this.assertControlEpoch(operationEpoch);
        resolvedTarget = await this.revalidateControlTarget(contents, target, resolvedTarget);
      } else {
        resolvedTarget = await this.revalidateControlTarget(contents, target, resolvedTarget);
      }
      // Context outside the fingerprint can change while a dialog is open.
      step = classifyPersonalBrowserStep("click", resolvedTarget.descriptor, { pageUrl });
      this.assertStepNotRefused(step);
      this.assertControlEpoch(operationEpoch);
      if (activationApproved) {
        // The address the approved link or form opens does not ask again.
        this.approveNavigation(resolvedTarget.descriptor.href);
        this.approveNavigation(resolvedTarget.descriptor.formActionUrl, { anyQuery: true });
      }
      // Withhold before the step runs: a pause or rotation after the in-page
      // click must not leave the page it revealed readable.
      this.withholdIfSecretRevealing(step, resolvedTarget.descriptor, true);
      const result = await clickPersonalBrowserTarget(
        contents,
        target,
        this.expectedMutationTarget(resolvedTarget),
      );
      this.assertControlEpoch(operationEpoch);
      this.assertAtomicMutationTarget(
        result,
        "The page or browser target changed immediately before clicking.",
      );
      if (!result.clicked) {
        throw new PersonalBrowserControlError(
          409,
          "target_not_clickable",
          "Browser target is no longer clickable.",
        );
      }
      return { clicked: true, status: this.getBrokerStatus() };
    }

    if (operation === "type") {
      if (isSensitivePersonalBrowserEditable(resolvedTarget.descriptor)) {
        throw new PersonalBrowserControlError(
          403,
          "sensitive_input_blocked",
          "Agent typing into password, verification-code, or payment fields is blocked.",
        );
      }
      const pageUrl = contents.getURL() || "about:blank";
      const typeStep = classifyPersonalBrowserStep("type", resolvedTarget.descriptor, { pageUrl });
      this.assertStepNotRefused(typeStep);
      const text = normalizePersonalBrowserText(payload.text);
      // Typing outside search asks once per form on this page, or once per
      // field outside forms, in every mode. With submit, one dialog covers
      // filling in and sending.
      const typingKey = typeStep.verdict === "allow"
        ? null
        : this.typingApprovalKey(resolvedTarget.descriptor, typeStep.category);
      const typingNeedsApproval = typingKey !== null && !this.typingApprovals.has(typingKey);
      let approvedSubmitCategory: string | null = null;
      let plannedSubmit: PersonalBrowserStepClassification | null = null;
      if (payload.submit === true) {
        plannedSubmit = classifyPersonalBrowserStep("submit", resolvedTarget.descriptor, { pageUrl });
        this.assertStepNotRefused(plannedSubmit);
      }
      const plannedSubmitNeedsApproval = plannedSubmit !== null && (this.approvalMode === "ask" ||
        personalBrowserKeyRequiresConfirmation("Enter", resolvedTarget.descriptor, this.approvalMode, { pageUrl }));
      if (typingNeedsApproval || plannedSubmitNeedsApproval) {
        // The dialog shows the exact text, so approving the submit before
        // typing never sends something the owner has not seen.
        const approved = await this.confirmAgentActivation(resolvedTarget.descriptor, {
          formSubmission: plannedSubmitNeedsApproval,
          fill: typingNeedsApproval,
          category: plannedSubmitNeedsApproval && plannedSubmit ? plannedSubmit.category : typeStep.category,
          typedText: text,
        });
        if (!approved) {
          throw new PersonalBrowserControlError(
            403,
            plannedSubmitNeedsApproval ? "form_submission_denied" : "typing_denied",
            plannedSubmitNeedsApproval ? "The user denied form submission." : "The user denied typing into this form.",
          );
        }
        this.assertControlEpoch(operationEpoch);
        resolvedTarget = await this.revalidateControlTarget(contents, target, resolvedTarget);
        if (typingKey) this.rememberTypingApproval(typingKey);
        if (plannedSubmitNeedsApproval && plannedSubmit) approvedSubmitCategory = plannedSubmit.category;
      }
      this.assertControlEpoch(operationEpoch);
      const result = await typeIntoPersonalBrowserTarget(
        contents,
        target,
        text,
        this.expectedMutationTarget(resolvedTarget),
      );
      this.assertControlEpoch(operationEpoch);
      this.assertAtomicMutationTarget(
        result,
        "The page or browser target changed immediately before typing.",
      );
      if (result.blockedSensitive || isSensitivePersonalBrowserEditable(result.descriptor)) {
        throw new PersonalBrowserControlError(
          403,
          "sensitive_input_blocked",
          "Agent typing into password, verification-code, or payment fields is blocked.",
        );
      }
      if (!result.typed) {
        throw new PersonalBrowserControlError(409, "target_not_editable", "Browser target is not editable.");
      }
      if (payload.submit === true) {
        // Input events can legitimately update button labels, so establish a fresh
        // post-type baseline while still requiring the exact same page and element.
        let submitTarget = await this.revalidateControlTarget(contents, target, resolvedTarget, {
          compareSecurity: false,
        });
        this.assertNonSensitiveActivation(submitTarget.descriptor);
        let submitStep = classifyPersonalBrowserStep("submit", submitTarget.descriptor, { pageUrl });
        this.assertStepNotRefused(submitStep);
        const submissionNeedsConfirmation = this.approvalMode === "ask" ||
          personalBrowserKeyRequiresConfirmation("Enter", submitTarget.descriptor, this.approvalMode, { pageUrl });
        // Typing can change what the form does: a submission that became a
        // different kind of step asks again.
        const alreadyApproved = approvedSubmitCategory !== null && approvedSubmitCategory === submitStep.category;
        if (submissionNeedsConfirmation && !alreadyApproved &&
          !(await this.confirmAgentActivation(submitTarget.descriptor, {
            formSubmission: true,
            category: submitStep.category,
          }))) {
          throw new PersonalBrowserControlError(403, "form_submission_denied", "The user denied form submission.");
        }
        this.assertControlEpoch(operationEpoch);
        submitTarget = await this.revalidateControlTarget(contents, target, submitTarget);
        this.assertNonSensitiveActivation(submitTarget.descriptor);
        // Context outside the fingerprint can change while a dialog is open.
        submitStep = classifyPersonalBrowserStep("submit", submitTarget.descriptor, { pageUrl });
        this.assertStepNotRefused(submitStep);
        this.assertControlEpoch(operationEpoch);
        this.withholdIfSecretRevealing(submitStep, submitTarget.descriptor, true);
        if (submissionNeedsConfirmation) this.approveNavigation(submitTarget.descriptor.formActionUrl, { anyQuery: true });
        const submitResult = await pressPersonalBrowserTarget(
          contents,
          target,
          "Enter",
          this.expectedMutationTarget(submitTarget),
        );
        this.assertControlEpoch(operationEpoch);
        this.assertAtomicMutationTarget(
          submitResult,
          "The page or form target changed immediately before submission.",
        );
        if (!submitResult.pressed) {
          throw new PersonalBrowserControlError(
            409,
            "target_not_pressable",
            "Browser target no longer accepts the submit key.",
          );
        }
      }
      return { typed: true, submitted: payload.submit === true };
    }

    const key = normalizePersonalBrowserPressKey(payload.key);
    const pressPageUrl = contents.getURL() || "about:blank";
    let pressStep = classifyPersonalBrowserStep("press", resolvedTarget.descriptor, { key, pageUrl: pressPageUrl });
    const isImplicitFormSubmission =
      key === "Enter" && Boolean(resolvedTarget.descriptor.formActionText?.trim());
    if (
      personalBrowserKeyMutatesSensitiveField(key) &&
      isSensitivePersonalBrowserEditable(resolvedTarget.descriptor)
    ) {
      this.assertNonSensitiveActivation(resolvedTarget.descriptor);
    }
    this.assertStepNotRefused(pressStep);
    // Space, Backspace and Delete in a field are typing: they share the
    // form's typing approval. So do arrow keys in an editable combobox, which
    // pick an autocomplete option.
    const editableTarget = isEditableStepTarget(resolvedTarget.descriptor);
    const comboboxArrow = key.startsWith("Arrow") && editableTarget &&
      resolvedTarget.descriptor.role?.trim().toLowerCase() === "combobox";
    const typingKeyPress = ((key === " " || key === "Backspace" || key === "Delete") && editableTarget) || comboboxArrow;
    let keyApproved = false;
    if (typingKeyPress) {
      const typingStep = comboboxArrow
        ? classifyPersonalBrowserStep("type", resolvedTarget.descriptor, { pageUrl: pressPageUrl })
        : pressStep;
      this.assertStepNotRefused(typingStep);
      const typingKey = typingStep.verdict === "allow"
        ? null
        : this.typingApprovalKey(resolvedTarget.descriptor, typingStep.category);
      if (typingKey && !this.typingApprovals.has(typingKey)) {
        if (!(await this.confirmAgentActivation(resolvedTarget.descriptor, { fill: true, category: typingStep.category }))) {
          throw new PersonalBrowserControlError(403, "typing_denied", "The user denied typing into this form.");
        }
        this.assertControlEpoch(operationEpoch);
        this.rememberTypingApproval(typingKey);
      }
    } else if (personalBrowserKeyRequiresConfirmation(key, resolvedTarget.descriptor, this.approvalMode, { pageUrl: pressPageUrl })) {
      if (
        !(await this.confirmAgentActivation(resolvedTarget.descriptor, {
          formSubmission: isImplicitFormSubmission,
          category: pressStep.category,
        }))
      ) {
        throw new PersonalBrowserControlError(403, "activation_denied", "The user denied browser activation.");
      }
      this.assertControlEpoch(operationEpoch);
      keyApproved = true;
    }
    resolvedTarget = await this.revalidateControlTarget(contents, target, resolvedTarget);
    if (
      personalBrowserKeyMutatesSensitiveField(key) &&
      isSensitivePersonalBrowserEditable(resolvedTarget.descriptor)
    ) {
      this.assertNonSensitiveActivation(resolvedTarget.descriptor);
    }
    // Context outside the fingerprint can change while a dialog is open.
    pressStep = classifyPersonalBrowserStep("press", resolvedTarget.descriptor, { key, pageUrl: pressPageUrl });
    this.assertStepNotRefused(pressStep);
    this.assertControlEpoch(operationEpoch);
    if (isPersonalBrowserActivationKey(key)) {
      this.withholdIfSecretRevealing(pressStep, resolvedTarget.descriptor, true);
    }
    if (keyApproved) {
      this.approveNavigation(resolvedTarget.descriptor.href);
      this.approveNavigation(resolvedTarget.descriptor.formActionUrl, { anyQuery: true });
    }
    const pressResult = await pressPersonalBrowserTarget(
      contents,
      target,
      key,
      this.expectedMutationTarget(resolvedTarget),
    );
    this.assertControlEpoch(operationEpoch);
    this.assertAtomicMutationTarget(
      pressResult,
      "The page or browser target changed immediately before the key press.",
    );
    if (!pressResult.pressed) {
      throw new PersonalBrowserControlError(
        409,
        "target_not_pressable",
        "Browser target no longer accepts key input.",
      );
    }
    return { pressed: key };
  }

  private async navigateActiveTab(url: string, operationEpoch: number): Promise<Record<string, unknown>> {
    const contents = this.requireWebContents();
    const origin = getPersonalBrowserOrigin(url);
    const originWasApproved = Boolean(origin && this.approvedOrigins.has(origin));
    if (origin && !(await this.requestOriginApproval(origin))) {
      throw new PersonalBrowserControlError(403, "origin_not_approved", "The user denied navigation to this origin.");
    }
    // Risky addresses (sign-out, downloads and exports, action links with
    // an id or one-time token) ask in every mode. In Ask mode the first
    // visit is covered by the origin prompt; once an origin is approved,
    // every explicit URL needs a one-shot decision so a state-changing
    // same-origin GET cannot bypass confirmation.
    const risky = classifyAddress(url);
    const navigationNeedsConfirmation = Boolean(risky) || (this.approvalMode === "ask" && originWasApproved);
    if (navigationNeedsConfirmation && !(await this.confirmAgentNavigation(url, risky?.category))) {
      throw new PersonalBrowserControlError(403, "navigation_denied", "The user denied browser navigation.");
    }
    this.assertControlEpoch(operationEpoch);
    if (this.getWebContents() !== contents) {
      throw new PersonalBrowserControlError(409, "page_changed", "The tab on screen changed while awaiting approval.");
    }
    if (risky) this.approveNavigation(url);
    this.invalidateAgentSnapshot();
    // An address the agent opens itself is not the page a credential step opened.
    this.withholdNextDocumentAfter = null;
    await contents.loadURL(url);
    return { status: this.getBrokerStatus() };
  }

  private async requirePublicAgentTabUrl(url: string, operationEpoch: number) {
    const check = await checkPersonalBrowserAgentTabUrl(url);
    this.assertControlEpoch(operationEpoch);
    if (!check.ok) {
      throw new PersonalBrowserControlError(
        403,
        "private_address_blocked",
        `Agent tabs open public web pages only: ${check.reason}. Ask the person to open this address in their own tab.`,
      );
    }
  }

  /**
   * open_tab: a new tab, on screen at once, that loads one public address.
   * The new tab starts with no site approvals of its own; in Ask mode the
   * person allows its site for that tab. A tab the person denied, or that a
   * Pause ended before it loaded anything, closes again.
   */
  private async openAgentTab(payload: Record<string, unknown>, operationEpoch: number): Promise<Record<string, unknown>> {
    const url = normalizePersonalBrowserUrl(payload.url);
    if (url === "about:blank") {
      throw new PersonalBrowserControlError(400, "invalid_url", "open_tab needs an absolute http(s) address.");
    }
    const assertCanOpen = () => {
      if (this.tabCapture.active) {
        throw new PersonalBrowserControlError(409, "tab_share_active", "The person is sharing the tab on screen. Agent tabs open once sharing stops.");
      }
      if (this.agentTabCount() >= MAX_PERSONAL_BROWSER_AGENT_TABS) {
        throw new PersonalBrowserControlError(
          409,
          "agent_tab_limit",
          `At most ${MAX_PERSONAL_BROWSER_AGENT_TABS} agent tabs can be open. Close one with close_tab, or reuse one with select_tab and navigate.`,
        );
      }
    };
    assertCanOpen();
    await this.requirePublicAgentTabUrl(url, operationEpoch);
    assertCanOpen();
    const partition = this.currentPartition;
    if (!partition || !this.ownerWindow || this.ownerWindow.isDestroyed()) {
      throw new PersonalBrowserControlError(409, "browser_not_ready", "Personal Browser is not ready.");
    }
    const previous = this.activeTab;
    const tab = this.addTab("agent");
    this.createTabView(partition, tab);
    this.activateTab(tab);
    try {
      const result = await this.navigateActiveTab(url, operationEpoch);
      return { tab: this.agentTabList().find((entry) => entry.tabId === tab.id), ...result };
    } catch (error) {
      const contents = tab.view?.webContents;
      const loadedNothing = !contents || contents.isDestroyed() || !contents.getURL() || contents.getURL() === "about:blank";
      if (this.tabs.includes(tab) && loadedNothing) {
        if (this.activeTab === tab && this.tabs.includes(previous)) this.activateTab(previous);
        this.removeTab(tab);
      }
      throw error;
    }
  }

  private requireAgentVisibleTab(value: unknown): PersonalBrowserTab {
    let tabId: string;
    try {
      tabId = requirePersonalBrowserTabId(value);
    } catch (error) {
      throw new PersonalBrowserControlError(400, "invalid_tab_id", error instanceof Error ? error.message : "Invalid tabId.");
    }
    const tab = this.findTab(tabId);
    if (!tab) {
      throw new PersonalBrowserControlError(404, "tab_not_found", "That tab is no longer open. Call list_tabs.");
    }
    return tab;
  }

  /**
   * The tabs as the agent sees them. A tab's address and title show only
   * when its site is allowed in that tab, masked like a status address.
   */
  private agentTabList(): Array<{ tabId: string; openedBy: PersonalBrowserTab["openedBy"]; active: boolean; url: string; title?: string }> {
    return this.tabs.map((tab) => {
      const { id, url, title, ...state } = this.tabStatus(tab);
      const rest = { tabId: id, ...state };
      try {
        const origin = getPersonalBrowserOrigin(url);
        const allowed = origin !== null && this.agentControlEnabled &&
          (this.siteSkipsPrompt(origin) || tab.approvedOrigins.has(origin));
        if (!allowed) return { ...rest, url: "" };
        return {
          ...rest,
          url: redactUrl(url).text,
          ...(title ? { title: redactText(title, { credentialContext: hasCredentialWord(title) }).text } : {}),
        };
      } catch {
        return { ...rest, url: "" };
      }
    });
  }

  private assertControlEpoch(epoch: number) {
    if (epoch !== this.controlEpoch) {
      throw new PersonalBrowserControlError(401, "stale_token", "Personal Browser control was rotated.");
    }
  }

  private emitStatus() {
    const status = this.getStatus();
    const serialized = JSON.stringify(status);
    if (serialized === this.lastEmittedStatus) {
      return;
    }
    this.lastEmittedStatus = serialized;
    this.onStatus(status);
  }
}
