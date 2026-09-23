import { contextBridge, ipcRenderer } from "electron";
import type {
  LocalHardwareIoActionRunRequest,
  LocalHardwareIoActionRunResult,
  LocalHardwareIoOpportunityListResult,
  SerialPortListResult,
  SerialPortProbeResult,
} from "@instafy/sdk/hardware-provider";

type DesktopNotificationPayload = {
  title: string;
  body?: string;
  url?: string;
  eventId?: string;
  accountId?: string;
};

export type DesktopExtensionInvokeOptions = {
  extensionId: string;
  method: string;
  payload?: unknown;
};

export type DesktopCodexAuthJsonStatus = {
  exists: boolean;
};

export type DesktopCodexCredentialConnectRequest = {
  controllerUrl: string;
  label?: string;
  makeDefault?: boolean;
};

export type DesktopCodexCredentialConnectResult = {
  credentialId: string;
  kind: "codex_auth_json";
  isDefault: boolean;
};

export type DesktopRuntimeStartOptions = {
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

export type PersonalBrowserStatus = {
  supported: boolean;
  enabled: boolean;
  state: "closed" | "opening" | "ready" | "error";
  visible: boolean;
  url: string;
  title?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  agentControlEnabled: boolean;
  takeoverRequestId?: string;
  sharing?: boolean;
  ownerId?: string;
  projectId?: string;
  runtimeId?: string;
  error?: string;
};

export type DesktopRuntimeStatus = {
  running: boolean;
  pid?: number;
  runtimeId?: string;
  projectId?: string;
  controllerUrl?: string;
  logFilePath?: string;
};

export type DesktopLocalHardwareHostStatus = {
  runtimeHostId: string;
  runtimeHostLabel: string;
  platform: string;
  providerIds: string[];
  supportedCapabilities: string[];
};

export type DesktopUpdaterStatus = {
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
  downloadProgress?: {
    percent: number;
    transferredBytes: number;
    totalBytes: number;
    bytesPerSecond: number;
  };
};

export type DesktopVoiceHostServiceStatus = {
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

export type DesktopVoiceHostBootstrapStatus = {
  state: "idle" | "checking" | "installing" | "removing" | "error";
  automatic: boolean;
  action?: "check" | "install_transcription" | "remove_transcription";
  detail?: string;
  lastUpdatedAt?: string;
};

export type DesktopVoiceHostLanStatus = {
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

export type DesktopVoiceHostStatus = {
  enabled: boolean;
  hostMode?: "desktop";
  scriptRoot?: string;
  providerConfigPath?: string;
  speechAuthToken?: string;
  bootstrap?: DesktopVoiceHostBootstrapStatus;
  lan?: DesktopVoiceHostLanStatus;
  speechService?: DesktopVoiceHostServiceStatus;
  providerHost?: DesktopVoiceHostServiceStatus;
};

export type DesktopVoiceHostDependencyAction = {
  id: string;
  label: string;
  command: string;
  available?: boolean;
  required?: boolean;
  installed?: boolean;
  detail?: string | null;
};

export type DesktopVoiceHostDependencyStatus = {
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
    url?: string | null;
  } | null;
  nextSteps?: string[];
  actions?: DesktopVoiceHostDependencyAction[];
};

export type DesktopVoiceHostBootstrapResult = {
  ok: boolean;
  action?: string;
  dryRun?: boolean;
  commandsRun?: string[];
  error?: string;
  status?: DesktopVoiceHostDependencyStatus | null;
  hostStatus: DesktopVoiceHostStatus;
};

export type DesktopSpeechTunnelStatus = {
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

contextBridge.exposeInMainWorld("instafyDesktop", {
  consumePendingAuthCallback: async (): Promise<string | null> => {
    return (await ipcRenderer.invoke("instafy:consumePendingAuthCallback")) as string | null;
  },
  onAuthCallback: (listener: (url: string) => void): (() => void) => {
    const handler = (_event: unknown, url: string) => listener(url);
    ipcRenderer.on("instafy:authCallback", handler);
    return () => ipcRenderer.removeListener("instafy:authCallback", handler);
  },
  openExternalUrl: async (url: string): Promise<boolean> => {
    return (await ipcRenderer.invoke("instafy:openExternalUrl", url)) as boolean;
  },
  // Static because it cannot change at runtime, and versioned on purpose:
  // frontends older than this property see undefined and keep the layout
  // that suits the stock title bar; apps older than the integrated layout
  // never expose it, so the frontend keeps the stock spacing there too.
  windowChrome: process.platform === "darwin" ? "hiddenInset" : "system",
  // Declares that this shell has vacated the title bar: its drag fallback is
  // confined to the top-left corner beside the window buttons, so the frontend
  // may put interactive chrome (the tab strip) at y=0 and own dragging for the
  // rest of that row. Absent on every shell before this one -- which is the
  // point. The frontend ships over the web and reaches installed apps
  // immediately, so a new frontend meeting an old shell must keep the old
  // layout: raising the tabs there would slide them under that shell's
  // full-width drag strip and turn every tab click into a window drag.
  titleBarFree: process.platform === "darwin",
  notify: async (payload: DesktopNotificationPayload) => {
    return (await ipcRenderer.invoke("instafy:notify", payload)) as boolean;
  },
  invokeDesktopExtension: async (
    options: DesktopExtensionInvokeOptions,
  ): Promise<unknown> => {
    return await ipcRenderer.invoke("instafy:desktopExtensionInvoke", options);
  },
  codexAuthJsonStatus: async (): Promise<DesktopCodexAuthJsonStatus> => {
    return (await ipcRenderer.invoke("instafy:codexAuthJsonStatus")) as DesktopCodexAuthJsonStatus;
  },
  connectDefaultCodexAuthJson: async (
    request: DesktopCodexCredentialConnectRequest,
  ): Promise<DesktopCodexCredentialConnectResult> => {
    return (await ipcRenderer.invoke(
      "instafy:connectDefaultCodexAuthJson",
      request,
    )) as DesktopCodexCredentialConnectResult;
  },
  selectWorkspaceDir: async (): Promise<{ workspaceDir: string } | null> => {
    return (await ipcRenderer.invoke("instafy:selectWorkspaceDir")) as { workspaceDir: string } | null;
  },
  selectProjectWorkspaceFolder: async (options: {
    projectId: string;
    controllerUrl?: string;
  }): Promise<
    | { ok: true; path: string; state: "empty" | "linked"; runtimeRestartRequired: boolean }
    | { ok: false; path: string; reason: string }
    | null
  > => {
    return (await ipcRenderer.invoke("instafy:selectProjectWorkspaceFolder", options)) as
      | { ok: true; path: string; state: "empty" | "linked"; runtimeRestartRequired: boolean }
      | { ok: false; path: string; reason: string }
      | null;
  },
  getProjectWorkspaceBinding: async (options: {
    projectId: string;
  }): Promise<{ path: string | null; defaultPath: string }> => {
    return (await ipcRenderer.invoke("instafy:getProjectWorkspaceBinding", options)) as {
      path: string | null;
      defaultPath: string;
    };
  },
  clearProjectWorkspaceBinding: async (options: { projectId: string }): Promise<{ ok: true }> => {
    return (await ipcRenderer.invoke("instafy:clearProjectWorkspaceBinding", options)) as {
      ok: true;
    };
  },
  selectRuntimeBinary: async (): Promise<{ runtimeBinaryPath: string } | null> => {
    return (await ipcRenderer.invoke("instafy:selectRuntimeBinary")) as { runtimeBinaryPath: string } | null;
  },
  desktopRuntimeStatus: async (): Promise<DesktopRuntimeStatus> => {
    return (await ipcRenderer.invoke("instafy:desktopRuntimeStatus")) as DesktopRuntimeStatus;
  },
  localHardwareHostStatus: async (): Promise<DesktopLocalHardwareHostStatus> => {
    return (await ipcRenderer.invoke("instafy:localHardwareHostStatus")) as DesktopLocalHardwareHostStatus;
  },
  localHardwareSerialList: async (): Promise<SerialPortListResult> => {
    return (await ipcRenderer.invoke("instafy:localHardwareSerialList")) as SerialPortListResult;
  },
  localHardwareIoOpportunities: async (): Promise<LocalHardwareIoOpportunityListResult> => {
    return (await ipcRenderer.invoke(
      "instafy:localHardwareIoOpportunities",
    )) as LocalHardwareIoOpportunityListResult;
  },
  localHardwareIoRunAction: async (
    options: LocalHardwareIoActionRunRequest,
  ): Promise<LocalHardwareIoActionRunResult> => {
    return (await ipcRenderer.invoke(
      "instafy:localHardwareIoRunAction",
      options,
    )) as LocalHardwareIoActionRunResult;
  },
  localHardwareSerialProbe: async (options: { path: string }): Promise<SerialPortProbeResult> => {
    return (await ipcRenderer.invoke("instafy:localHardwareSerialProbe", options)) as SerialPortProbeResult;
  },
  desktopUpdaterStatus: async (): Promise<DesktopUpdaterStatus> => {
    return (await ipcRenderer.invoke("instafy:desktopUpdaterStatus")) as DesktopUpdaterStatus;
  },
  desktopUpdaterCheck: async (): Promise<DesktopUpdaterStatus> => {
    return (await ipcRenderer.invoke("instafy:desktopUpdaterCheck")) as DesktopUpdaterStatus;
  },
  desktopUpdaterDownload: async (): Promise<DesktopUpdaterStatus> => {
    return (await ipcRenderer.invoke("instafy:desktopUpdaterDownload")) as DesktopUpdaterStatus;
  },
  desktopUpdaterInstall: async (): Promise<DesktopUpdaterStatus> => {
    return (await ipcRenderer.invoke("instafy:desktopUpdaterInstall")) as DesktopUpdaterStatus;
  },
  desktopVoiceHostStatus: async (): Promise<DesktopVoiceHostStatus> => {
    return (await ipcRenderer.invoke("instafy:desktopVoiceHostStatus")) as DesktopVoiceHostStatus;
  },
  desktopVoiceHostRestart: async (): Promise<DesktopVoiceHostStatus> => {
    return (await ipcRenderer.invoke("instafy:desktopVoiceHostRestart")) as DesktopVoiceHostStatus;
  },
  desktopVoiceHostSetEnabled: async (options: {
    enabled: boolean;
  }): Promise<DesktopVoiceHostStatus> => {
    return (await ipcRenderer.invoke("instafy:desktopVoiceHostSetEnabled", options)) as DesktopVoiceHostStatus;
  },
  desktopVoiceHostBootstrap: async (options?: {
    action?: "check" | "install_transcription" | "remove_transcription";
    dryRun?: boolean;
  }): Promise<DesktopVoiceHostBootstrapResult> => {
    return (await ipcRenderer.invoke("instafy:desktopVoiceHostBootstrap", options ?? {})) as DesktopVoiceHostBootstrapResult;
  },
  desktopSpeechTunnelStatus: async (): Promise<DesktopSpeechTunnelStatus> => {
    return (await ipcRenderer.invoke("instafy:desktopSpeechTunnelStatus")) as DesktopSpeechTunnelStatus;
  },
  desktopSpeechTunnelStart: async (options: {
    projectId: string;
    controllerUrl: string;
    controllerAccessToken: string;
    controllerCredentialMode?: "ambient" | "fixed";
    forceRestart?: boolean;
    waitForReady?: boolean;
  }): Promise<DesktopSpeechTunnelStatus> => {
    return (await ipcRenderer.invoke("instafy:desktopSpeechTunnelStart", options)) as DesktopSpeechTunnelStatus;
  },
  desktopSpeechTunnelStop: async (): Promise<DesktopSpeechTunnelStatus> => {
    return (await ipcRenderer.invoke("instafy:desktopSpeechTunnelStop")) as DesktopSpeechTunnelStatus;
  },
  personalBrowserStatus: async (): Promise<PersonalBrowserStatus> => {
    return (await ipcRenderer.invoke("instafy:personalBrowserStatus")) as PersonalBrowserStatus;
  },
  personalBrowserOpen: async (options: {
    projectId: string;
    controllerUrl: string;
    controllerAccessToken: string;
    /** UI identity scope only; the main process never trusts this for profile selection. */
    profileUserId: string;
    ownerId: string;
    url?: string;
  }): Promise<PersonalBrowserStatus> => {
    return (await ipcRenderer.invoke("instafy:personalBrowserOpen", options)) as PersonalBrowserStatus;
  },
  personalBrowserRelease: async (options: {
    ownerId: string;
  }): Promise<PersonalBrowserStatus> => {
    return (await ipcRenderer.invoke("instafy:personalBrowserRelease", options)) as PersonalBrowserStatus;
  },
  personalBrowserSetBounds: async (options: {
    occluded?: boolean;
    agentWorking?: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    visible?: boolean;
    ownerId: string;
  }): Promise<PersonalBrowserStatus & { previewDataUrl?: string }> => {
    return (await ipcRenderer.invoke("instafy:personalBrowserSetBounds", options)) as PersonalBrowserStatus & { previewDataUrl?: string };
  },
  personalBrowserShow: async (options: {
    visible: boolean;
    ownerId: string;
  }): Promise<PersonalBrowserStatus> => {
    return (await ipcRenderer.invoke("instafy:personalBrowserShow", options)) as PersonalBrowserStatus;
  },
  personalBrowserNavigate: async (options: {
    url: string;
    ownerId: string;
  }): Promise<PersonalBrowserStatus> => {
    return (await ipcRenderer.invoke("instafy:personalBrowserNavigate", options)) as PersonalBrowserStatus;
  },
  browserTabVideo: (options: {ownerId:string;captureId:string;operation:"open"|"answer"|"sync"|"viewport"|"close"|"stats";value:unknown}): Promise<unknown> => {
    if (!["open","answer","sync","viewport","close","stats"].includes(options.operation)) throw new Error("Invalid video operation.");
    return ipcRenderer.invoke(`instafy:browserTabVideo:${options.operation}`,options);
  },
  browserTabExploreOpen: (options: { ownerId: string; captureId: string; viewport: { width: number; height: number; dpr: number } }): Promise<{ viewId: string }> => ipcRenderer.invoke("instafy:browserTabExploreOpen", options),
  browserTabExploreRenew: (options: { ownerId: string; captureId: string; viewId: string }): Promise<boolean> => ipcRenderer.invoke("instafy:browserTabExplore:renew", options),
  browserTabExploreFrame: (options: { ownerId: string; captureId: string; viewId: string }): Promise<Uint8Array | null> => ipcRenderer.invoke("instafy:browserTabExplore:frame", options),
  browserTabExploreResize: (options: { ownerId: string; captureId: string; viewId: string; value: { width: number; height: number; dpr: number } }): Promise<void> => ipcRenderer.invoke("instafy:browserTabExplore:resize", options),
  browserTabExploreInput: (options: { ownerId: string; captureId: string; viewId: string; value: unknown }): Promise<void> => ipcRenderer.invoke("instafy:browserTabExplore:input", options),
  browserTabExploreNavigate: (options: { ownerId: string; captureId: string; viewId: string; value: "back" | "forward" | "reload" }): Promise<void> => ipcRenderer.invoke("instafy:browserTabExplore:navigate", options),
  browserTabExploreClose: (options: { ownerId: string; captureId: string; viewId: string }): Promise<void> => ipcRenderer.invoke("instafy:browserTabExplore:close", options),
  browserTabShareControl: (options: { ownerId: string; captureId: string; grantId: string | null }): Promise<void> => ipcRenderer.invoke("instafy:browserTabShareControl",options),
  browserTabShareRenew: (options: { ownerId: string; captureId: string; grantId: string }): Promise<boolean> => ipcRenderer.invoke("instafy:browserTabShareRenew",options),
  browserTabShareInput: (options: { ownerId: string; captureId: string; grantId: string; input: unknown }): Promise<void> => ipcRenderer.invoke("instafy:browserTabShareInput",options),
  browserTabShareStart: (options: { ownerId: string }): Promise<{ captureId: string }> =>
    ipcRenderer.invoke("instafy:browserTabShareStart", options),
  browserTabShareFrame: (options: { ownerId: string; captureId: string }): Promise<Uint8Array> =>
    ipcRenderer.invoke("instafy:browserTabShareFrame", options),
  browserTabShareStop: (options: { ownerId: string; captureId: string }): Promise<void> =>
    ipcRenderer.invoke("instafy:browserTabShareStop", options),
  personalBrowserGoBack: async (options: { ownerId: string }): Promise<PersonalBrowserStatus> => {
    return (await ipcRenderer.invoke("instafy:personalBrowserGoBack", options)) as PersonalBrowserStatus;
  },
  personalBrowserGoForward: async (options: { ownerId: string }): Promise<PersonalBrowserStatus> => {
    return (await ipcRenderer.invoke("instafy:personalBrowserGoForward", options)) as PersonalBrowserStatus;
  },
  personalBrowserReload: async (options: { ownerId: string }): Promise<PersonalBrowserStatus> => {
    return (await ipcRenderer.invoke("instafy:personalBrowserReload", options)) as PersonalBrowserStatus;
  },
  personalBrowserSetAgentControlEnabled: async (options: {
    enabled: boolean;
    ownerId: string;
    approvalMode?: "ask" | "routine";
  }): Promise<PersonalBrowserStatus> => {
    return (await ipcRenderer.invoke(
      "instafy:personalBrowserSetAgentControlEnabled",
      options,
    )) as PersonalBrowserStatus;
  },
  personalBrowserClearData: async (options: {
    ownerId: string;
  }): Promise<PersonalBrowserStatus> => {
    return (await ipcRenderer.invoke(
      "instafy:personalBrowserClearData",
      options,
    )) as PersonalBrowserStatus;
  },
  personalBrowserClose: async (options: {
    ownerId: string;
  }): Promise<PersonalBrowserStatus> => {
    return (await ipcRenderer.invoke("instafy:personalBrowserClose", options)) as PersonalBrowserStatus;
  },
  onPersonalBrowserStatus: (listener: (status: PersonalBrowserStatus) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: PersonalBrowserStatus) => listener(status);
    ipcRenderer.on("instafy:personalBrowserStatus", handler);
    return () => ipcRenderer.removeListener("instafy:personalBrowserStatus", handler);
  },
  startDesktopRuntime: async (
    options: DesktopRuntimeStartOptions,
  ): Promise<{ pid: number; logFilePath?: string; runtimeId?: string }> => {
    return (await ipcRenderer.invoke("instafy:startDesktopRuntime", options)) as {
      pid: number;
      logFilePath?: string;
      runtimeId?: string;
    };
  },
  stopDesktopRuntime: async (): Promise<void> => {
    await ipcRenderer.invoke("instafy:stopDesktopRuntime");
  },
});
