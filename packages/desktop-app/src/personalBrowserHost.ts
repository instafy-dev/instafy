import { createBrowserTabExplorePage } from "./browserTabExplorePage";
import { dispatchBrowserTabInput } from "./browserTabInput";
import {
  BrowserWindow,
  WebContentsView,
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
import { BrowserTabCapture } from "./browserTabCapture";
import {
  PersonalBrowserControlError,
  PersonalBrowserControlServer,
  type PersonalBrowserControlCredentials,
  type PersonalBrowserControlOperation,
} from "./personalBrowserControlServer";
import {
  derivePersonalBrowserPartition,
  getPersonalBrowserOrigin,
  isHighImpactPersonalBrowserAction,
  isSensitivePersonalBrowserEditable,
  normalizePersonalBrowserApprovalMode,
  normalizePersonalBrowserBounds,
  normalizePersonalBrowserPressKey,
  normalizePersonalBrowserScroll,
  normalizePersonalBrowserText,
  normalizePersonalBrowserUrl,
  personalBrowserTargetSecurityFingerprint,
  personalBrowserActivationTargetsMatch,
  personalBrowserActivationRequiresConfirmation,
  personalBrowserKeyRequiresConfirmation,
  personalBrowserKeyMutatesSensitiveField,
  requirePersonalBrowserTarget,
  sanitizePersonalBrowserBrokerStatus,
  type PersonalBrowserBounds,
  type PersonalBrowserApprovalMode,
} from "./personalBrowserSecurity";

export type PersonalBrowserState = "closed" | "opening" | "ready" | "error";
const HUMAN_CONTROL_DRAIN_TIMEOUT_MS = 15_000;
const HUMAN_CONTROL_DRAIN_ERROR = "A previous browser operation is still stopping. Input remains locked until it finishes; close the browser if it does not recover.";

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
  humanInputRequest?: PersonalBrowserHumanInputRequest;
  approvalMode: PersonalBrowserApprovalMode;
  approvalModes: PersonalBrowserApprovalMode[];
  sharing?: boolean;
  tabControlActive?: boolean;
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

type PersonalBrowserSnapshotState = {
  controlEpoch: number;
  url: string;
  origin: string | null;
  documentToken: string;
  targets: Map<number, PersonalBrowserResolvedTarget>;
};

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

export class PersonalBrowserHost {
  private readonly enabled: boolean;
  private readonly supported: boolean;
  private readonly onReleaseExpiry: PersonalBrowserHostOptions["onReleaseExpiry"];
  private readonly onEmergencyPause: NonNullable<PersonalBrowserHostOptions["onEmergencyPause"]>;
  private readonly onStatus: NonNullable<PersonalBrowserHostOptions["onStatus"]>;
  private readonly logger: NonNullable<PersonalBrowserHostOptions["logger"]>;
  private readonly controlServer: PersonalBrowserControlServer;
  private readonly inputShield: PersonalBrowserInputShield;
  private ownerWindow: BrowserWindow | null = null;
  private view: WebContentsView | null = null;
  private humanInputRequest: PersonalBrowserHumanInputRequest | null = null;
  private currentState: PersonalBrowserState = "closed";
  private currentVisible = false;
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
  private approvedOrigins = new Set<string>();
  private pendingOriginApprovals = new Map<string, Promise<boolean>>();
  private controlEpoch = 0;
  private latestAgentSnapshot: PersonalBrowserSnapshotState | null = null;
  private lastEmittedStatus = "";
  private releaseCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly tabCapture = new BrowserTabCapture(() => {
    const contents = this.getWebContents();
    return contents && this.currentOwnerId && this.currentProjectId && this.currentVisible
      ? { contents, ownerId: this.currentOwnerId, projectId: this.currentProjectId,
          canControl: !this.agentControlEnabled && this.activeControlOperations === 0,
          createExplore: viewport => createBrowserTabExplorePage(contents.session, contents.getURL(), viewport),
          dispatchInput: (input, current) => this.inputShield.withInjectedInput(() => dispatchBrowserTabInput(contents,this.fitBoundsToOwner(this.currentBounds),input,current)),
        } : null;
  }, () => { this.syncInputShield(); this.emitStatus(); });

  startTabShare(ownerId: string) {
    const result = this.tabCapture.start(ownerId);
    this.emitStatus();
    return result;
  }
  controlSharedTab(ownerId: string, captureId: string, grantId: string | null) { this.tabCapture.setControl(ownerId,captureId,grantId); }
  renewSharedTabControl(ownerId: string, captureId: string, grantId: string) { return this.tabCapture.renewControl(ownerId,captureId,grantId); }
  inputSharedTab(ownerId: string, captureId: string, grantId: string, input: unknown) { return this.tabCapture.input(ownerId,captureId,grantId,input); }
  openTabExplore(ownerId: string, captureId: string, viewport: unknown) { return this.tabCapture.openExplore(ownerId, captureId, viewport); }
  operateTabExplore(ownerId: string, captureId: string, viewId: string, operation: "renew" | "frame" | "input" | "resize" | "navigate" | "close", value?: unknown) { return this.tabCapture.operateExplore(ownerId, captureId, viewId, operation, value); }
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
    this.logger = options.logger ?? (() => undefined);
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
    });
  }

  attachWindow(window: BrowserWindow) {
    if (this.ownerWindow === window) {
      return;
    }
    if (this.view && this.ownerWindow && !this.ownerWindow.isDestroyed()) {
      this.ownerWindow.contentView.removeChildView(this.view);
    }
    this.ownerWindow = window;
    if (this.view) {
      window.contentView.addChildView(this.view);
      this.view.setBounds(this.fitBoundsToOwner(this.currentBounds));
      this.inputShield.attach(window.contentView, this.view.webContents);
      this.applyVisibility();
    }
    this.emitStatus();
  }

  detachWindow(window: BrowserWindow) {
    if (this.ownerWindow !== window) {
      return;
    }
    if (this.view && !window.isDestroyed()) {
      window.contentView.removeChildView(this.view);
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
      humanControlReady: this.currentState === "ready" && contents !== null && !this.agentControlEnabled && this.activeControlOperations === 0 && !this.tabCapture.controlActive,
      ...(this.humanInputRequest ? { humanInputRequest: this.humanInputRequest } : {}),
      approvalMode: this.approvalMode,
      approvalModes: ["ask", "routine"],
      sharing: this.tabCapture.active,
      tabControlActive: this.tabCapture.controlActive,
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
      this.setAgentControlState(false);
      this.clearHumanNavigationAllowance();
      this.currentRuntimeId = null;
      this.approvedOrigins.clear();
      this.pendingOriginApprovals.clear();
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
    if (typeof bounds.visible === "boolean") {
      this.currentVisible = bounds.visible;
    }
    if (this.view) {
      this.view.setBounds(this.fitBoundsToOwner(bounds));
      this.applyVisibility();
    }
    this.emitStatus();
    return this.getStatus();
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
    this.approvedOrigins.clear();
    this.pendingOriginApprovals.clear();
    this.setAgentControlState(false);
    this.emitStatus();
    return this.getStatus();
  }

  async prepareAgentControl(requestedApprovalMode?: unknown): Promise<number> {
    if (this.tabCapture.controlActive) throw new Error("Take back tab control before enabling the agent.");
    if (!this.agentControlEnabled && this.activeControlOperations > 0) {
      throw new Error("The previous Personal Browser operation is still stopping. Wait for control to return before resuming.");
    }
    const approvalMode = requestedApprovalMode === undefined && this.agentControlEnabled
      ? this.approvalMode
      : normalizePersonalBrowserApprovalMode(requestedApprovalMode);
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
    if (approvalMode === "routine" && !this.agentControlEnabled) {
      const epoch = this.controlEpoch;
      const owner = this.ownerWindow;
      if (!owner || owner.isDestroyed() || !owner.isVisible()) {
        throw new Error("Personal Browser requires a visible window to approve routine browsing.");
      }
      const result = await dialog.showMessageBox(owner, {
        type: "warning",
        title: "Allow routine browsing for this session?",
        message: "Always allow routine browsing in this project while agent control is resumed?",
        detail: "The agent may read sites, navigate, click ordinary controls and fill non-sensitive fields without asking each time. Recognized consequential actions and form submissions still ask; password, verification-code and payment fields remain blocked. Websites can attach unexpected side effects to ordinary controls. Pause or Escape ends this permission.",
        buttons: ["Cancel", "Allow routine browsing"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response !== 1 || !this.isOpenOwnerCurrent(epoch, projectId, partition, ownerId)) {
        throw new Error("Routine browsing was not approved or the browser session changed.");
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
      this.approvedOrigins.clear();
      this.pendingOriginApprovals.clear();
      await this.controlServer.bindProject(projectId);
      if (!this.isOpenOwnerCurrent(preparedEpoch, projectId, partition, ownerId)) {
        this.controlServer.clearBinding();
        throw new Error("Personal Browser control changed while Resume was starting.");
      }
    }
    this.approvalMode = approvalMode;
    return this.controlEpoch;
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
    this.setAgentControlState(false);
    this.clearHumanNavigationAllowance();
    this.approvedOrigins.clear();
    this.pendingOriginApprovals.clear();
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
    this.setAgentControlState(false);
    this.stopInFlightNavigation();
    this.clearHumanNavigationAllowance();
    this.approvedOrigins.clear();
    this.pendingOriginApprovals.clear();
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
    const contents = this.requireWebContents();
    this.setAgentControlState(false);
    this.controlEpoch += 1;
    this.invalidateAgentSnapshot();
    this.controlServer.clearBinding();
    this.approvedOrigins.clear();
    this.pendingOriginApprovals.clear();
    await this.runHumanNavigation(() => contents.loadURL("about:blank"));
    contents.navigationHistory.clear();
    await contents.session.clearStorageData();
    await contents.session.clearCache();
    await contents.session.clearAuthCache();
    contents.session.flushStorageData();
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
    this.currentError = null;
    this.setAgentControlState(false);
    this.clearHumanNavigationAllowance();
    this.approvedOrigins.clear();
    this.pendingOriginApprovals.clear();
    this.emitStatus();
    return this.getStatus();
  }

  async stop(): Promise<void> {
    await this.close();
    await this.controlServer.stop();
  }

  private createView(partition: string) {
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
    view.webContents.on("will-navigate", (event, url) => this.guardPageNavigation(event, url));
    view.webContents.on("will-redirect", (event, url) => this.guardPageNavigation(event, url));
    view.webContents.on("did-navigate", () => {
      this.humanInputRequest = null;
      this.invalidateAgentSnapshot();
      this.emitStatus();
    });
    view.webContents.on("did-navigate-in-page", () => {
      this.humanInputRequest = null;
      // Same-document navigation keeps the DOM alive; remove cosmetic guidance
      // while invalidating the observation that selected those fields.
      void clearPersonalBrowserHumanInput(view.webContents).catch(() => undefined);
      this.invalidateAgentSnapshot();
      this.emitStatus();
    });
    view.webContents.on("page-title-updated", () => this.emitStatus());
    view.webContents.on("did-stop-loading", () => {
      this.emitStatus();
    });
    view.webContents.on("did-finish-load", () => {
      this.invalidateAgentSnapshot();
      this.currentState = "ready";
      this.currentError = null;
      this.emitStatus();
    });
    view.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
      if (errorCode === -3) {
        return;
      }
      this.currentState = "error";
      this.currentError = errorDescription;
      this.emitStatus();
    });
    view.webContents.on("render-process-gone", (_event, details) => {
      this.currentState = "error";
      this.currentError = `Browser renderer stopped (${details.reason}).`;
      this.setAgentControlState(false);
      this.invalidateAgentSnapshot();
      this.emitStatus();
    });
    this.view = view;
    this.ownerWindow!.contentView.addChildView(view);
    view.setBounds(this.fitBoundsToOwner(this.currentBounds));
    this.inputShield.attach(this.ownerWindow!.contentView, view.webContents);
    this.applyVisibility();
  }

  private configureSession(session: Session) {
    if (configuredPersonalBrowserSessions.has(session)) {
      return;
    }
    configuredPersonalBrowserSessions.add(session);
    session.setPermissionCheckHandler(() => false);
    session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.on("will-download", (event) => event.preventDefault());
  }

  private closeView() {
    const view = this.view;
    this.view = null;
    this.inputShield.destroy();
    if (!view) {
      return;
    }
    if (this.ownerWindow && !this.ownerWindow.isDestroyed()) {
      this.ownerWindow.contentView.removeChildView(view);
    }
    if (!view.webContents.isDestroyed()) {
      view.webContents.close({ waitForBeforeUnload: false });
    }
    if (this.ownerWindow && !this.ownerWindow.isDestroyed()) {
      this.ownerWindow.webContents.focus();
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
    this.view?.setVisible(this.currentVisible);
    this.syncInputShield();
    if (!this.currentVisible && this.ownerWindow && !this.ownerWindow.isDestroyed()) {
      this.ownerWindow.webContents.focus();
    }
  }

  private setAgentControlState(enabled: boolean) {
    if (!enabled) this.approvalMode = "ask";
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
      this.currentVisible,
      this.fitBoundsToOwner(this.currentBounds),
    );
  }

  private emergencyPauseAgentControl() {
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
    if (!targetOrigin || targetOrigin === currentOrigin || this.approvalMode === "routine" || this.approvedOrigins.has(targetOrigin)) {
      return;
    }
    event.preventDefault();
    void this.requestOriginApproval(targetOrigin).then((approved) => {
      if (approved && this.getWebContents()) {
        void this.requireWebContents().loadURL(targetUrl).catch((error) => {
          this.logger("warn", "[instafy-desktop] personal-browser-approved-navigation-failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    });
  }

  private async requestOriginApproval(origin: string): Promise<boolean> {
    if (this.approvalMode === "routine" || this.approvedOrigins.has(origin)) {
      return true;
    }
    const pending = this.pendingOriginApprovals.get(origin);
    if (pending) {
      return pending;
    }
    const epoch = this.controlEpoch;
    const approval = this.promptForOriginApproval(origin).then((approved) => {
      if (!approved || epoch !== this.controlEpoch) {
        return false;
      }
      this.approvedOrigins.add(origin);
      return true;
    });
    const finalizedApproval = approval.finally(() => {
      if (this.pendingOriginApprovals.get(origin) === finalizedApproval) {
        this.pendingOriginApprovals.delete(origin);
      }
    });
    this.pendingOriginApprovals.set(origin, finalizedApproval);
    return finalizedApproval;
  }

  private async promptForOriginApproval(origin: string): Promise<boolean> {
    const owner = this.ownerWindow;
    if (!owner || owner.isDestroyed() || !owner.isVisible()) {
      return false;
    }
    const host = new URL(origin).host;
    const result = await dialog.showMessageBox(owner, {
      type: "question",
      title: "Allow agent browser access?",
      message: `Allow the agent to use ${host}?`,
      detail:
        "This lets the current project read and interact with this site in your Personal Browser for this session. Password, verification-code, and payment fields remain blocked.",
      buttons: ["Deny", "Allow for this session"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1;
  }

  private async confirmAgentActivation(
    descriptor: PersonalBrowserTargetDescriptor,
    options: { formSubmission?: boolean } = {},
  ): Promise<boolean> {
    const owner = this.ownerWindow;
    if (!owner || owner.isDestroyed() || !owner.isVisible()) {
      return false;
    }
    const epoch = this.controlEpoch;
    const result = await dialog.showMessageBox(owner, {
      type: "warning",
      title: options.formSubmission ? "Confirm form submission" : "Confirm agent action",
      message: options.formSubmission
        ? `Allow the agent to submit ${formSubmissionDescription(descriptor)}?`
        : `Allow the agent to activate “${pageLabel(descriptor)}”?`,
      detail: options.formSubmission
        ? "This sends the form to the site and may navigate or change site state. Review it before allowing once."
        : "This activates the selected page control and may navigate or change site state. Review it before allowing once.",
      buttons: ["Deny", "Allow once"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1 && epoch === this.controlEpoch;
  }

  private async confirmAgentNavigation(url: string): Promise<boolean> {
    const owner = this.ownerWindow;
    if (!owner || owner.isDestroyed() || !owner.isVisible()) {
      return false;
    }
    const epoch = this.controlEpoch;
    const parsed = new URL(url);
    const label = `${parsed.host}${parsed.pathname}${parsed.search}`.slice(0, 240);
    const result = await dialog.showMessageBox(owner, {
      type: "question",
      title: "Confirm agent navigation",
      message: `Allow the agent to open “${label}”?`,
      detail:
        "This is a one-time navigation in your Personal Browser. Review the destination before allowing it.",
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
    const status = this.getStatus();
    let originApproved = false;
    if (this.agentControlEnabled) {
      try {
        const origin = getPersonalBrowserOrigin(status.url || "about:blank");
        originApproved = !origin || this.approvalMode === "routine" || this.approvedOrigins.has(origin);
      } catch {
        originApproved = false;
      }
    }
    if (originApproved) {
      return status;
    }
    return sanitizePersonalBrowserBrokerStatus(status, false);
  }

  private invalidateAgentSnapshot() {
    this.latestAgentSnapshot = null;
  }

  private clearHumanInputGuidance() {
    this.humanInputRequest = null;
    const contents = this.getWebContents();
    if (contents) void clearPersonalBrowserHumanInput(contents).catch(() => undefined);
  }

  private rememberAgentSnapshot(
    snapshot: PersonalBrowserPageSnapshot,
  ): Omit<PersonalBrowserPageSnapshot, "documentToken" | "interactive"> & {
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
    return {
      url: snapshot.url,
      title: snapshot.title,
      text: snapshot.text,
      capturedAt: snapshot.capturedAt,
      interactive: snapshot.interactive.map(({ index, tag, role, name, type, disabled }) => ({
        index,
        tag,
        ...(role ? { role } : {}),
        ...(name ? { name } : {}),
        ...(type ? { type } : {}),
        disabled,
      })),
    };
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

    if (operation === "navigate") {
      const payload = payloadRecord(rawPayload);
      const url = normalizePersonalBrowserUrl(payload.url);
      const origin = getPersonalBrowserOrigin(url);
      const originWasApproved = Boolean(origin && this.approvedOrigins.has(origin));
      if (origin && !(await this.requestOriginApproval(origin))) {
        throw new PersonalBrowserControlError(403, "origin_not_approved", "The user denied navigation to this origin.");
      }
      // The first visit is covered by the origin prompt. Once an origin is
      // approved, require a one-shot decision for every explicit URL so a
      // state-changing same-origin GET cannot bypass confirmation.
      const navigationNeedsConfirmation = this.approvalMode === "routine"
        ? isHighImpactPersonalBrowserAction({ href: url })
        : originWasApproved;
      if (navigationNeedsConfirmation && !(await this.confirmAgentNavigation(url))) {
        throw new PersonalBrowserControlError(403, "navigation_denied", "The user denied browser navigation.");
      }
      this.assertControlEpoch(operationEpoch);
      this.invalidateAgentSnapshot();
      await contents.loadURL(url);
      return { status: this.getBrokerStatus() };
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
      this.humanInputRequest = {
        version: 1, handoffId: randomUUID(), origin, createdAtMs,
        expiresAtMs: createdAtMs + 600_000,
        fields: indices.map((_, index) => ({ label: `Highlighted field ${index + 1}` })),
      };
      this.pauseAgentControl();
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
      if (personalBrowserActivationRequiresConfirmation(resolvedTarget.descriptor, this.approvalMode)) {
        if (!(await this.confirmAgentActivation(resolvedTarget.descriptor))) {
          throw new PersonalBrowserControlError(403, "activation_denied", "The user denied the browser activation.");
        }
        this.assertControlEpoch(operationEpoch);
        resolvedTarget = await this.revalidateControlTarget(contents, target, resolvedTarget);
      } else {
        resolvedTarget = await this.revalidateControlTarget(contents, target, resolvedTarget);
      }
      this.assertControlEpoch(operationEpoch);
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
      const text = normalizePersonalBrowserText(payload.text);
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
        if (!(await this.confirmAgentActivation(submitTarget.descriptor, { formSubmission: true }))) {
          throw new PersonalBrowserControlError(403, "form_submission_denied", "The user denied form submission.");
        }
        this.assertControlEpoch(operationEpoch);
        submitTarget = await this.revalidateControlTarget(contents, target, submitTarget);
        this.assertNonSensitiveActivation(submitTarget.descriptor);
        this.assertControlEpoch(operationEpoch);
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
    const isImplicitFormSubmission =
      key === "Enter" && Boolean(resolvedTarget.descriptor.formActionText?.trim());
    if (
      personalBrowserKeyMutatesSensitiveField(key) &&
      isSensitivePersonalBrowserEditable(resolvedTarget.descriptor)
    ) {
      this.assertNonSensitiveActivation(resolvedTarget.descriptor);
    }
    if (personalBrowserKeyRequiresConfirmation(key, resolvedTarget.descriptor, this.approvalMode)) {
      if (
        !(await this.confirmAgentActivation(resolvedTarget.descriptor, {
          formSubmission: isImplicitFormSubmission,
        }))
      ) {
        throw new PersonalBrowserControlError(403, "activation_denied", "The user denied browser activation.");
      }
      this.assertControlEpoch(operationEpoch);
    }
    resolvedTarget = await this.revalidateControlTarget(contents, target, resolvedTarget);
    if (
      personalBrowserKeyMutatesSensitiveField(key) &&
      isSensitivePersonalBrowserEditable(resolvedTarget.descriptor)
    ) {
      this.assertNonSensitiveActivation(resolvedTarget.descriptor);
    }
    this.assertControlEpoch(operationEpoch);
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
