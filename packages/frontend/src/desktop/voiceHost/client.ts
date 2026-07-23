export interface DesktopVoiceHostBridgeServiceStatus {
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
}

export interface DesktopVoiceHostBridgeBootstrapStatus {
  state: "idle" | "checking" | "installing" | "removing" | "error";
  automatic: boolean;
  action?: "check" | "install_transcription" | "remove_transcription";
  detail?: string;
  lastUpdatedAt?: string;
}

export interface DesktopVoiceHostBridgeLanStatus {
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
}

export interface DesktopVoiceHostBridgeStatus {
  enabled: boolean;
  hostMode?: "desktop";
  scriptRoot?: string;
  providerConfigPath?: string;
  speechAuthToken?: string;
  bootstrap?: DesktopVoiceHostBridgeBootstrapStatus;
  lan?: DesktopVoiceHostBridgeLanStatus;
  speechService?: DesktopVoiceHostBridgeServiceStatus;
  providerHost?: DesktopVoiceHostBridgeServiceStatus;
}

export interface DesktopVoiceHostBootstrapBridgeResult {
  ok: boolean;
  action?: string;
  dryRun?: boolean;
  commandsRun?: string[];
  error?: string;
  status?: InstafyDesktopVoiceHostDependencyStatus | null;
  hostStatus: DesktopVoiceHostBridgeStatus | null;
}

export interface DesktopVoiceHostLifecycleSummary {
  badgeLabel: string;
  badgeTone: "success" | "warning" | "neutral";
  detail: string;
  actionLabel: string;
}

function normalizeDesktopVoiceHostServiceStatus(
  value: InstafyDesktopVoiceHostServiceStatus | null | undefined,
): DesktopVoiceHostBridgeServiceStatus | null {
  if (!value || typeof value.healthUrl !== "string" || typeof value.scriptPath !== "string") {
    return null;
  }
  return {
    state: value.state,
    managed: value.managed === true,
    reachable: value.reachable === true,
    pid: typeof value.pid === "number" ? value.pid : undefined,
    healthUrl: value.healthUrl,
    scriptPath: value.scriptPath,
    lastCheckedAt: value.lastCheckedAt?.trim() || undefined,
    lastStartedAt: value.lastStartedAt?.trim() || undefined,
    lastError: value.lastError?.trim() || undefined,
    statusCode: typeof value.statusCode === "number" ? value.statusCode : undefined,
  };
}

function normalizeDesktopVoiceHostBootstrapStatus(
  value: InstafyDesktopVoiceHostBootstrapStatus | null | undefined,
): DesktopVoiceHostBridgeBootstrapStatus | null {
  if (!value) {
    return null;
  }
  return {
    state: value.state,
    automatic: value.automatic === true,
    action:
      value.action === "install_transcription"
        ? "install_transcription"
        : value.action === "remove_transcription"
          ? "remove_transcription"
          : value.action === "check"
            ? "check"
            : undefined,
    detail: value.detail?.trim() || undefined,
    lastUpdatedAt: value.lastUpdatedAt?.trim() || undefined,
  };
}

function normalizeDesktopVoiceHostLanStatus(
  value: InstafyDesktopVoiceHostLanStatus | null | undefined,
): DesktopVoiceHostBridgeLanStatus | null {
  if (
    !value ||
    (value.state !== "available" && value.state !== "unavailable") ||
    typeof value.bindHost !== "string" ||
    typeof value.healthHost !== "string" ||
    typeof value.healthUrl !== "string" ||
    typeof value.port !== "number"
  ) {
    return null;
  }
  return {
    state: value.state,
    bindHost: value.bindHost,
    healthHost: value.healthHost,
    port: value.port,
    healthUrl: value.healthUrl,
    publicHost: value.publicHost?.trim() || undefined,
    baseUrl: value.baseUrl?.trim() || undefined,
    authRequired: value.authRequired === true,
    authToken: value.authToken?.trim() || undefined,
    tokenHint: value.tokenHint?.trim() || undefined,
    reason: value.reason?.trim() || undefined,
  };
}

export function desktopVoiceHostBridgeAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.instafyDesktop?.desktopVoiceHostStatus === "function";
}

export async function readDesktopVoiceHostStatus(): Promise<DesktopVoiceHostBridgeStatus | null> {
  if (!desktopVoiceHostBridgeAvailable()) {
    return null;
  }
  const bridge = window.instafyDesktop;
  if (!bridge?.desktopVoiceHostStatus) {
    return null;
  }
  const status = await bridge.desktopVoiceHostStatus();
  return {
    enabled: status.enabled === true,
    hostMode: status.hostMode,
    scriptRoot: status.scriptRoot?.trim() || undefined,
    providerConfigPath: status.providerConfigPath?.trim() || undefined,
    speechAuthToken: status.speechAuthToken?.trim() || undefined,
    bootstrap: normalizeDesktopVoiceHostBootstrapStatus(status.bootstrap) ?? undefined,
    lan: normalizeDesktopVoiceHostLanStatus(status.lan) ?? undefined,
    speechService: normalizeDesktopVoiceHostServiceStatus(status.speechService) ?? undefined,
    providerHost: normalizeDesktopVoiceHostServiceStatus(status.providerHost) ?? undefined,
  };
}

export async function restartDesktopVoiceHost(): Promise<DesktopVoiceHostBridgeStatus | null> {
  if (typeof window === "undefined" || typeof window.instafyDesktop?.desktopVoiceHostRestart !== "function") {
    return null;
  }
  const status = await window.instafyDesktop.desktopVoiceHostRestart();
  return {
    enabled: status.enabled === true,
    hostMode: status.hostMode,
    scriptRoot: status.scriptRoot?.trim() || undefined,
    providerConfigPath: status.providerConfigPath?.trim() || undefined,
    speechAuthToken: status.speechAuthToken?.trim() || undefined,
    bootstrap: normalizeDesktopVoiceHostBootstrapStatus(status.bootstrap) ?? undefined,
    lan: normalizeDesktopVoiceHostLanStatus(status.lan) ?? undefined,
    speechService: normalizeDesktopVoiceHostServiceStatus(status.speechService) ?? undefined,
    providerHost: normalizeDesktopVoiceHostServiceStatus(status.providerHost) ?? undefined,
  };
}

export async function setDesktopVoiceHostEnabled(enabled: boolean): Promise<DesktopVoiceHostBridgeStatus | null> {
  if (typeof window === "undefined" || typeof window.instafyDesktop?.desktopVoiceHostSetEnabled !== "function") {
    return null;
  }
  const status = await window.instafyDesktop.desktopVoiceHostSetEnabled({ enabled });
  return {
    enabled: status.enabled === true,
    hostMode: status.hostMode,
    scriptRoot: status.scriptRoot?.trim() || undefined,
    providerConfigPath: status.providerConfigPath?.trim() || undefined,
    speechAuthToken: status.speechAuthToken?.trim() || undefined,
    bootstrap: normalizeDesktopVoiceHostBootstrapStatus(status.bootstrap) ?? undefined,
    lan: normalizeDesktopVoiceHostLanStatus(status.lan) ?? undefined,
    speechService: normalizeDesktopVoiceHostServiceStatus(status.speechService) ?? undefined,
    providerHost: normalizeDesktopVoiceHostServiceStatus(status.providerHost) ?? undefined,
  };
}

export async function bootstrapDesktopVoiceHost(options?: {
  action?: "check" | "install_transcription" | "remove_transcription";
  dryRun?: boolean;
}): Promise<DesktopVoiceHostBootstrapBridgeResult | null> {
  if (typeof window === "undefined" || typeof window.instafyDesktop?.desktopVoiceHostBootstrap !== "function") {
    return null;
  }
  const result = await window.instafyDesktop.desktopVoiceHostBootstrap(options ?? {});
  return {
    ok: result.ok === true,
    action: result.action?.trim() || undefined,
    dryRun: result.dryRun === true,
    commandsRun: Array.isArray(result.commandsRun)
      ? result.commandsRun.filter((command): command is string => typeof command === "string" && command.trim().length > 0)
      : [],
    error: result.error?.trim() || undefined,
    status: result.status ?? null,
    hostStatus: result.hostStatus ? {
      enabled: result.hostStatus.enabled === true,
      hostMode: result.hostStatus.hostMode,
      scriptRoot: result.hostStatus.scriptRoot?.trim() || undefined,
      providerConfigPath: result.hostStatus.providerConfigPath?.trim() || undefined,
      speechAuthToken: result.hostStatus.speechAuthToken?.trim() || undefined,
      bootstrap: normalizeDesktopVoiceHostBootstrapStatus(result.hostStatus.bootstrap) ?? undefined,
      lan: normalizeDesktopVoiceHostLanStatus(result.hostStatus.lan) ?? undefined,
      speechService: normalizeDesktopVoiceHostServiceStatus(result.hostStatus.speechService) ?? undefined,
      providerHost: normalizeDesktopVoiceHostServiceStatus(result.hostStatus.providerHost) ?? undefined,
    } : null,
  };
}

function describeSingleService(
  label: string,
  service: DesktopVoiceHostBridgeServiceStatus | null | undefined,
) {
  if (!service) {
    return `${label} status unavailable`;
  }
  switch (service.state) {
    case "running":
      return `${label} running`;
    case "starting":
      return `${label} starting`;
    case "external":
      return `${label} already running outside Desktop`;
    case "error":
      return `${label} failed`;
    default:
      return `${label} stopped`;
  }
}

export function describeDesktopVoiceHostLifecycle(
  status: DesktopVoiceHostBridgeStatus | null,
): DesktopVoiceHostLifecycleSummary | null {
  if (!status) {
    return null;
  }
  if (!status.enabled) {
    return {
      badgeLabel: "Desktop host off",
      badgeTone: "neutral",
      detail:
        "Desktop voice hosting is off on this Mac. Enable it only if you want Instafy Desktop to download the managed speech runtime and share this Mac with your other devices.",
      actionLabel: "Enable on this Mac",
    };
  }

  const speechState = status.speechService?.state ?? "stopped";
  const providerState = status.providerHost?.state ?? "stopped";
  const bothReachable =
    status.speechService?.reachable === true && status.providerHost?.reachable === true;
  const anyManaged =
    status.speechService?.managed === true || status.providerHost?.managed === true;
  const anyStarting = speechState === "starting" || providerState === "starting";
  const anyError = speechState === "error" || providerState === "error";
  const allExternal = speechState === "external" && providerState === "external";
  const anyStopped = speechState === "stopped" || providerState === "stopped";
  const bootstrapState = status.bootstrap?.state ?? "idle";
  const detailParts = [
    describeSingleService("Speech service", status.speechService),
    describeSingleService("Provider host", status.providerHost),
  ];

  if (bothReachable && anyManaged) {
    const lanDetail =
      status.lan?.state === "available" && status.lan.baseUrl
        ? ` Direct LAN route ${status.lan.baseUrl}${status.lan.authRequired ? " is protected by the Desktop pairing token." : " is available for same-network devices."}`
        : "";
    return {
      badgeLabel: "Desktop host running",
      badgeTone: "success",
      detail: `${detailParts.join(". ")}. Instafy Desktop is managing the local voice host for this machine.${lanDetail}`,
      actionLabel: "Restart Desktop host",
    };
  }

  if (bothReachable && allExternal) {
    return {
      badgeLabel: "External host active",
      badgeTone: "neutral",
      detail: `${detailParts.join(". ")}. Desktop is using the already-running local voice host instead of starting another copy.`,
      actionLabel: "Restart through Desktop",
    };
  }

  if (anyStarting) {
    return {
      badgeLabel: "Desktop host starting",
      badgeTone: "warning",
      detail: `${detailParts.join(". ")}. Voice may still fall back to this device until the Desktop-managed host finishes warming up.`,
      actionLabel: "Restart Desktop host",
    };
  }

  if (bootstrapState === "checking" || bootstrapState === "installing" || bootstrapState === "removing") {
    return {
      badgeLabel:
        bootstrapState === "installing"
          ? "Desktop host installing voice"
          : bootstrapState === "removing"
            ? "Desktop host removing voice"
            : "Desktop host checking voice",
      badgeTone: "neutral",
      detail:
        status.bootstrap?.detail?.trim() ||
        (bootstrapState === "removing"
          ? `${detailParts.join(". ")}. Instafy Desktop is removing the managed speech runtime from this machine.`
          : `${detailParts.join(". ")}. Instafy Desktop is preparing the managed speech runtime for this machine.`),
      actionLabel: "Restart Desktop host",
    };
  }

  if (anyError || anyStopped) {
    const lastError =
      (status.bootstrap?.state === "error" ? status.bootstrap.detail?.trim() : null) ||
      status.providerHost?.lastError?.trim() ||
      status.speechService?.lastError?.trim() ||
      "Desktop has not brought the local voice host online yet.";
    return {
      badgeLabel: "Desktop host unavailable",
      badgeTone: "warning",
      detail: `${detailParts.join(". ")}. ${lastError}`,
      actionLabel: "Restart Desktop host",
    };
  }

  return {
    badgeLabel: "Desktop host status",
    badgeTone: "neutral",
    detail: `${detailParts.join(". ")}.`,
    actionLabel: "Restart Desktop host",
  };
}
