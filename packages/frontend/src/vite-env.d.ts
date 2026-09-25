/// <reference types="vite/client" />
/// <reference types="wicg-file-system-access" />

interface ImportMetaEnv {
  // Dev-only: true when the vite dev server exposes the local Codex-seed
  // endpoint (INSTAFY_DEV_CODEX_SEED=1). Statically replaced at build time.
  readonly INSTAFY_DEV_CODEX_SEED_ENABLED?: boolean;
  readonly VITE_USE_WEBCONTAINERS?: string;
  readonly VITE_CONTROLLER_URL?: string;
  readonly VITE_DOWNLOADS_BASE_URL?: string;
  readonly VITE_DESKTOP_DOWNLOADS_PREFIX?: string;
  readonly VITE_INSTAFY_SHARED_BROWSER_CDP_SCREENCAST?: string;
  readonly VITE_INSTAFY_SHARED_BROWSER_WEBRTC?: string;
  readonly VITE_OTA_CHANNEL?: string;
  readonly VITE_INSTAFY_SPEECH_BASE_URL?: string;
  readonly VITE_INSTAFY_SPEECH_TOKEN?: string;
  readonly VITE_INSTAFY_TRANSCRIPTION_URL?: string;
  readonly VITE_INSTAFY_TRANSCRIPTION_TOKEN?: string;
  readonly VITE_INSTAFY_TRANSCRIPTION_MODEL?: string;
  readonly VITE_INSTAFY_TRANSCRIPTION_LANGUAGE?: string;
  readonly VITE_INSTAFY_SYNTHESIS_URL?: string;
  readonly VITE_INSTAFY_SYNTHESIS_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

type InstafyBuildInfo = {
  app: string;
  packageVersion: string;
  gitCommit: string | null;
  gitCommitShort: string | null;
  gitBranch: string | null;
  builtAt: string;
  releaseId: string;
};

declare const __INSTAFY_BUILD_INFO__: InstafyBuildInfo;
declare const __INSTAFY_NATIVE_OTA_CHANNEL__: string;

type InstafyDesktopNotificationPayload = {
  title: string;
  body?: string;
  url?: string;
  eventId?: string;
  accountId?: string;
};

type InstafyDesktopExtensionInvokeOptions = {
  extensionId: string;
  method: string;
  payload?: unknown;
};

type InstafyDesktopCodexAuthJsonStatus = {
  exists: boolean;
};

type InstafyDesktopCodexCredentialConnectRequest = {
  controllerUrl: string;
  label?: string;
  makeDefault?: boolean;
};

type InstafyDesktopCodexCredentialConnectResult = {
  credentialId: string;
  kind: "codex_auth_json";
  isDefault: boolean;
};

type InstafyDesktopRuntimeStartOptions = {
  projectId: string;
  controllerUrl: string;
  controllerAccessToken: string;
  controllerCredentialMode?: "ambient" | "fixed";
  proxyBaseUrl?: string;
  displayName?: string;
  workspaceDir?: string;
  runtimeBinaryPath?: string;
  enablePersonalBrowser?: boolean;
  personalBrowserOwnerId?: string;
};

type InstafyDesktopRuntimeStatus = {
  running: boolean;
  pid?: number;
  projectId?: string;
  controllerUrl?: string;
  logFilePath?: string;
  runtimeId?: string;
};

type InstafyDesktopLocalHardwareHostStatus = {
  runtimeHostId: string;
  runtimeHostLabel: string;
  platform: string;
  providerIds: string[];
  supportedCapabilities: string[];
};

type InstafyDesktopSerialPortDescriptor = {
  path: string;
  displayName: string;
  kind: "usb_serial" | "bluetooth_serial" | "serial" | "unknown";
  source: "host";
  available: boolean;
  isCharacterDevice?: boolean;
  stableId?: string | null;
  detail?: string | null;
};

type InstafyDesktopSerialPortListResult = {
  providerId: "hardware.serial";
  platform: string;
  ports: InstafyDesktopSerialPortDescriptor[];
};

type InstafyDesktopSerialPortProbeResult = {
  providerId: "hardware.serial";
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  isCharacterDevice: boolean;
  available: boolean;
  error?: string | null;
};

type InstafyDesktopLocalHardwareIoAction = {
  id: string;
  label: string;
  status: "available" | "planned";
  source?: "runtime";
  description?: string | null;
};

type InstafyDesktopLocalHardwareIoOpportunity = {
  id: string;
  providerId: "hardware.serial";
  kind: string;
  title: string;
  detail?: string | null;
  resource: {
    kind: "serial_device";
    id: string;
    path: string;
    displayName?: string | null;
  };
  available: boolean;
  actions: InstafyDesktopLocalHardwareIoAction[];
};

type InstafyDesktopLocalHardwareIoOpportunityListResult = {
  providerId: "hardware.serial";
  platform: string;
  opportunities: InstafyDesktopLocalHardwareIoOpportunity[];
};

type InstafyDesktopLocalHardwareIoActionRunRequest = {
  actionId: InstafyDesktopLocalHardwareIoAction["id"];
  resource: InstafyDesktopLocalHardwareIoOpportunity["resource"];
};

type InstafyDesktopLocalHardwareHostProcessResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
};

type InstafyDesktopLocalHardwareIoActionRunResult = {
  providerId: "hardware.serial";
  actionId: InstafyDesktopLocalHardwareIoAction["id"];
  ok: boolean;
  message: string;
  startedAt: string;
  finishedAt: string;
  serialProbe?: InstafyDesktopSerialPortProbeResult | null;
  process?: InstafyDesktopLocalHardwareHostProcessResult | null;
  error?: string | null;
};

type InstafyDesktopUpdaterStatus = {
  isEnabled: boolean;
  channel: string;
  currentVersion: string;
  feedUrl: string;
  phase: "idle" | "checking" | "update_available" | "downloading" | "downloaded" | "up_to_date" | "error";
  availableVersion?: string;
  lastCheckedAt?: string;
  lastDownloadedAt?: string;
  lastError?: string;
  lastInstallRequestAccepted?: boolean;
};

type InstafyDesktopVoiceHostServiceStatus = {
  state: "stopped" | "starting" | "running" | "external" | "error";
  managed: boolean;
  reachable: boolean;
  pid?: number;
  healthUrl: string;
  scriptPath: string;
  lastCheckedAt?: string;
  lastStartedAt?: string;
  lastError?: string;
  statusCode?: number;
};

type InstafyDesktopVoiceHostBootstrapStatus = {
  state: "idle" | "checking" | "installing" | "removing" | "error";
  automatic: boolean;
  action?: "check" | "install_transcription" | "remove_transcription";
  detail?: string;
  lastUpdatedAt?: string;
};

type InstafyDesktopVoiceHostLanStatus = {
  state: "available" | "unavailable";
  bindHost: string;
  healthHost: string;
  port: number;
  healthUrl: string;
  publicHost?: string;
  baseUrl?: string;
  authRequired: boolean;
  authToken?: string;
  tokenHint?: string;
  reason?: string;
};

type InstafyDesktopVoiceHostStatus = {
  enabled: boolean;
  hostMode?: "desktop";
  scriptRoot?: string;
  providerConfigPath?: string;
  speechAuthToken?: string;
  bootstrap?: InstafyDesktopVoiceHostBootstrapStatus;
  lan?: InstafyDesktopVoiceHostLanStatus;
  speechService?: InstafyDesktopVoiceHostServiceStatus;
  providerHost?: InstafyDesktopVoiceHostServiceStatus;
};

type InstafyDesktopVoiceHostDependencyAction = {
  id: string;
  label: string;
  command: string;
  available?: boolean;
  required?: boolean;
  installed?: boolean;
  detail?: string | null;
};

type InstafyDesktopVoiceHostDependencyStatus = {
  supported?: boolean;
  platform?: string;
  arch?: string;
  localService?: {
    command?: string | null;
    scriptPath?: string | null;
    scriptExists?: boolean;
    health?: {
      configured?: boolean;
      reachable?: boolean;
      url?: string | null;
      detail?: string | null;
      statusCode?: number;
      payload?: Record<string, unknown> | null;
    } | null;
  } | null;
  transcription?: {
    configured?: boolean;
    ready?: boolean;
    engine?: string | null;
    model?: string | null;
    deviceId?: string | null;
    installState?: string | null;
    url?: string | null;
  } | null;
  synthesis?: {
    configured?: boolean;
    ready?: boolean;
    engine?: string | null;
    defaultVoice?: string | null;
    installState?: string | null;
    strictRoundtripSupported?: boolean;
    strictRoundtripReason?: string | null;
    url?: string | null;
  } | null;
  nextSteps?: string[];
  actions?: InstafyDesktopVoiceHostDependencyAction[];
};

type InstafyDesktopVoiceHostBootstrapResult = {
  ok: boolean;
  action?: string;
  dryRun?: boolean;
  commandsRun?: string[];
  error?: string;
  status?: InstafyDesktopVoiceHostDependencyStatus | null;
  hostStatus: InstafyDesktopVoiceHostStatus;
};

type InstafyDesktopSpeechTunnelStatus = {
  enabled: boolean;
  hostMode?: "desktop";
  state: "idle" | "starting" | "active" | "error";
  managed: boolean;
  projectId?: string;
  controllerUrl?: string;
  controllerCredentialMode?: "ambient" | "fixed";
  controllerBindingId?: string;
  tunnelId?: string;
  publicUrl?: string;
  hostname?: string | null;
  localPort: number;
  readyPath: string;
  pid?: number;
  lastCheckedAt?: string;
  lastStartedAt?: string;
  lastError?: string;
};

type InstafyDesktopPersonalBrowserState = "closed" | "opening" | "ready" | "error";

type InstafyDesktopPersonalBrowserStatus = {
  supported: boolean;
  enabled: boolean;
  state: InstafyDesktopPersonalBrowserState;
  visible: boolean;
  url: string;
  title?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  agentControlEnabled: boolean;
  approvalMode?: "ask" | "routine";
  approvalModes?: Array<"ask" | "routine">;
  humanInputRequest?: import("./screens/studio/components/useBrowserHumanInput").BrowserHumanInputRequest;
  humanControlReady?: boolean;
  takeoverRequestId?: string;
  sharing?: boolean;
  tabControlActive?: boolean;
  ownerId?: string;
  projectId?: string;
  runtimeId?: string;
  error?: string;
};

type InstafyDesktopPersonalBrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  visible?: boolean;
  occluded?: boolean;
  agentWorking?: boolean;
  ownerId?: string;
};

interface Window {
  instafyDesktop?: {
    windowChrome?: "hiddenInset" | "system";
    notify: (payload: InstafyDesktopNotificationPayload) => Promise<boolean | void>;
    invokeDesktopExtension?: (
      options: InstafyDesktopExtensionInvokeOptions,
    ) => Promise<unknown>;
    codexAuthJsonStatus?: () => Promise<InstafyDesktopCodexAuthJsonStatus>;
    connectDefaultCodexAuthJson?: (
      request: InstafyDesktopCodexCredentialConnectRequest,
    ) => Promise<InstafyDesktopCodexCredentialConnectResult>;
    selectWorkspaceDir?: () => Promise<{ workspaceDir: string } | null>;
    selectProjectWorkspaceFolder?: (options: {
      projectId: string;
      controllerUrl?: string;
    }) => Promise<
      | { ok: true; path: string; state: "empty" | "linked"; runtimeRestartRequired: boolean }
      | { ok: false; path: string; reason: string }
      | null
    >;
    getProjectWorkspaceBinding?: (options: {
      projectId: string;
    }) => Promise<{ path: string | null; defaultPath: string }>;
    clearProjectWorkspaceBinding?: (options: { projectId: string }) => Promise<{ ok: true }>;
    selectRuntimeBinary?: () => Promise<{ runtimeBinaryPath: string } | null>;
    desktopRuntimeStatus?: () => Promise<InstafyDesktopRuntimeStatus>;
    localHardwareHostStatus?: () => Promise<InstafyDesktopLocalHardwareHostStatus>;
    localHardwareSerialList?: () => Promise<InstafyDesktopSerialPortListResult>;
    localHardwareIoOpportunities?: () => Promise<InstafyDesktopLocalHardwareIoOpportunityListResult>;
    localHardwareIoRunAction?: (
      options: InstafyDesktopLocalHardwareIoActionRunRequest,
    ) => Promise<InstafyDesktopLocalHardwareIoActionRunResult>;
    localHardwareSerialProbe?: (options: {
      path: string;
    }) => Promise<InstafyDesktopSerialPortProbeResult>;
    desktopUpdaterStatus?: () => Promise<InstafyDesktopUpdaterStatus>;
    desktopUpdaterCheck?: () => Promise<InstafyDesktopUpdaterStatus>;
    desktopUpdaterDownload?: () => Promise<InstafyDesktopUpdaterStatus>;
    desktopUpdaterInstall?: () => Promise<InstafyDesktopUpdaterStatus>;
    desktopVoiceHostStatus?: () => Promise<InstafyDesktopVoiceHostStatus>;
    desktopVoiceHostRestart?: () => Promise<InstafyDesktopVoiceHostStatus>;
    desktopVoiceHostSetEnabled?: (options: {
      enabled: boolean;
    }) => Promise<InstafyDesktopVoiceHostStatus>;
    desktopVoiceHostBootstrap?: (options?: {
      action?: "check" | "install_transcription" | "remove_transcription";
      dryRun?: boolean;
    }) => Promise<InstafyDesktopVoiceHostBootstrapResult>;
    desktopSpeechTunnelStatus?: () => Promise<InstafyDesktopSpeechTunnelStatus>;
    desktopSpeechTunnelStart?: (options: {
      projectId: string;
      controllerUrl: string;
      controllerAccessToken: string;
      controllerCredentialMode?: "ambient" | "fixed";
      forceRestart?: boolean;
      waitForReady?: boolean;
    }) => Promise<InstafyDesktopSpeechTunnelStatus>;
    desktopSpeechTunnelStop?: () => Promise<InstafyDesktopSpeechTunnelStatus>;
    personalBrowserStatus?: () => Promise<InstafyDesktopPersonalBrowserStatus>;
    personalBrowserOpen?: (options: {
      projectId: string;
      controllerUrl: string;
      controllerAccessToken: string;
      /** UI identity scope only; Electron uses a server-attested identity. */
      profileUserId: string;
      ownerId: string;
      url?: string;
    }) => Promise<InstafyDesktopPersonalBrowserStatus>;
    personalBrowserRelease?: (options: {
      ownerId: string;
    }) => Promise<InstafyDesktopPersonalBrowserStatus>;
    personalBrowserSetBounds?: (
      bounds: InstafyDesktopPersonalBrowserBounds & { ownerId: string },
    ) => Promise<InstafyDesktopPersonalBrowserStatus & { previewDataUrl?: string }>;
    personalBrowserShow?: (options: {
      visible: boolean;
      ownerId: string;
    }) => Promise<InstafyDesktopPersonalBrowserStatus>;
    browserTabVideo?: (options: {ownerId:string;captureId:string;operation:"open"|"answer"|"sync"|"viewport"|"close"|"stats";value:unknown}) => Promise<unknown>;
    browserTabExploreOpen?: (options: { ownerId: string; captureId: string; viewport: { width: number; height: number; dpr: number } }) => Promise<{ viewId: string }>;
    browserTabExploreRenew?: (options: { ownerId: string; captureId: string; viewId: string }) => Promise<boolean>;
    browserTabExploreFrame?: (options: { ownerId: string; captureId: string; viewId: string }) => Promise<Uint8Array | null>;
    browserTabExploreResize?: (options: { ownerId: string; captureId: string; viewId: string; value: { width: number; height: number; dpr: number } }) => Promise<void>;
    browserTabExploreInput?: (options: { ownerId: string; captureId: string; viewId: string; value: unknown }) => Promise<void>;
    browserTabExploreNavigate?: (options: { ownerId: string; captureId: string; viewId: string; value: "back" | "forward" | "reload" }) => Promise<void>;
    browserTabExploreClose?: (options: { ownerId: string; captureId: string; viewId: string }) => Promise<void>;
    browserTabShareControl?: (options: { ownerId: string; captureId: string; grantId: string | null }) => Promise<void>;
    browserTabShareRenew?: (options: { ownerId: string; captureId: string; grantId: string }) => Promise<boolean>;
    browserTabShareInput?: (options: { ownerId: string; captureId: string; grantId: string; input: unknown }) => Promise<void>;
    browserTabShareStart?: (options: { ownerId: string }) => Promise<{ captureId: string }>;
    browserTabShareFrame?: (options: { ownerId: string; captureId: string }) => Promise<Uint8Array>;
    browserTabShareStop?: (options: { ownerId: string; captureId: string }) => Promise<void>;
    personalBrowserNavigate?: (options: {
      url: string;
      ownerId: string;
    }) => Promise<InstafyDesktopPersonalBrowserStatus>;
    personalBrowserGoBack?: (options: {
      ownerId: string;
    }) => Promise<InstafyDesktopPersonalBrowserStatus>;
    personalBrowserGoForward?: (options: {
      ownerId: string;
    }) => Promise<InstafyDesktopPersonalBrowserStatus>;
    personalBrowserReload?: (options: {
      ownerId: string;
    }) => Promise<InstafyDesktopPersonalBrowserStatus>;
    personalBrowserSetAgentControlEnabled?: (options: {
      enabled: boolean;
      ownerId: string;
      approvalMode?: "ask" | "routine";
    }) => Promise<InstafyDesktopPersonalBrowserStatus>;
    personalBrowserClearData?: (options: {
      ownerId: string;
    }) => Promise<InstafyDesktopPersonalBrowserStatus>;
    personalBrowserClose?: (options: {
      ownerId: string;
    }) => Promise<InstafyDesktopPersonalBrowserStatus>;
    onPersonalBrowserStatus?: (
      listener: (status: InstafyDesktopPersonalBrowserStatus) => void,
    ) => () => void;
    startDesktopRuntime?: (options: InstafyDesktopRuntimeStartOptions) => Promise<{
      pid: number;
      logFilePath?: string;
      runtimeId?: string;
    }>;
    stopDesktopRuntime?: () => Promise<void>;
  };
}
