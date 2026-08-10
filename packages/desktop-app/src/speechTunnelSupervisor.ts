import { randomUUID } from "node:crypto";
import type {
  DesktopSpeechTunnelHandle,
  StartSpeechTunnelOptions,
} from "@instafy/desktop-runtime-agent";
import { startSpeechTunnel } from "@instafy/desktop-runtime-agent";

export type DesktopSpeechTunnelState = "idle" | "starting" | "active" | "error";
export type DesktopSpeechTunnelControllerCredentialMode = "ambient" | "fixed";

export type DesktopSpeechTunnelStatus = {
  enabled: boolean;
  hostMode?: "desktop";
  state: DesktopSpeechTunnelState;
  managed: boolean;
  projectId?: string;
  controllerUrl?: string;
  controllerCredentialMode?: DesktopSpeechTunnelControllerCredentialMode;
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

type DesktopSpeechTunnelLogger = (
  level: "info" | "warn" | "error",
  message: string,
  payload?: Record<string, unknown>,
) => void;

type DesktopSpeechTunnelSupervisorOptions = {
  enabled?: boolean;
  localPort?: number;
  readyPath?: string;
  readyTimeoutMs?: number;
  logger?: DesktopSpeechTunnelLogger;
  ensureVoiceHostRunning?: () => Promise<unknown>;
  startTunnelImpl?: (options: StartSpeechTunnelOptions) => Promise<DesktopSpeechTunnelHandle>;
};

type DesktopSpeechTunnelStartOptions = {
  projectId: string;
  controllerUrl: string;
  controllerAccessToken: string;
  controllerCredentialMode?: DesktopSpeechTunnelControllerCredentialMode;
  forceRestart?: boolean;
};

type DesktopSpeechTunnelControllerBinding = {
  id: string;
  controllerUrl: string;
  controllerAccessToken: string;
  credentialMode: DesktopSpeechTunnelControllerCredentialMode;
};

const DEFAULT_LOCAL_PORT = 8796;
const DEFAULT_READY_PATH = "/health";

function normalizeOptionalString(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveLocalPort(value: string | null | undefined) {
  const candidate = Number(normalizeOptionalString(value) ?? String(DEFAULT_LOCAL_PORT));
  return Number.isFinite(candidate) && candidate > 0 ? candidate : DEFAULT_LOCAL_PORT;
}

export class DesktopSpeechTunnelSupervisor {
  private readonly enabled: boolean;
  private readonly localPort: number;
  private readonly readyPath: string;
  private readonly readyTimeoutMs: number;
  private readonly logger: DesktopSpeechTunnelLogger;
  private readonly ensureVoiceHostRunning: (() => Promise<unknown>) | null;
  private readonly startTunnelImpl: (options: StartSpeechTunnelOptions) => Promise<DesktopSpeechTunnelHandle>;
  private currentHandle: DesktopSpeechTunnelHandle | null = null;
  private currentControllerBinding: DesktopSpeechTunnelControllerBinding | null = null;
  private currentStatus: DesktopSpeechTunnelStatus;
  private ensurePromise: Promise<DesktopSpeechTunnelStatus> | null = null;
  private stopPromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private shuttingDown = false;

  constructor(options: DesktopSpeechTunnelSupervisorOptions = {}) {
    this.enabled = options.enabled !== false;
    this.localPort = options.localPort ?? resolveLocalPort(process.env.LOCAL_SPEECH_PORT);
    this.readyPath = normalizeOptionalString(options.readyPath) ?? DEFAULT_READY_PATH;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
    this.logger =
      options.logger ??
      ((level, message, payload) => {
        const args = payload ? [message, payload] : [message];
        if (level === "error") {
          console.error(...args);
          return;
        }
        if (level === "warn") {
          console.warn(...args);
          return;
        }
        console.log(...args);
      });
    this.ensureVoiceHostRunning = options.ensureVoiceHostRunning ?? null;
    this.startTunnelImpl = options.startTunnelImpl ?? startSpeechTunnel;
    this.currentStatus = {
      enabled: this.enabled,
      hostMode: this.enabled ? "desktop" : undefined,
      state: "idle",
      managed: false,
      localPort: this.localPort,
      readyPath: this.readyPath,
    };
  }

  async getStatus() {
    this.currentStatus = {
      ...this.currentStatus,
      lastCheckedAt: new Date().toISOString(),
    };
    return { ...this.currentStatus };
  }

  async ensureRunning(options: DesktopSpeechTunnelStartOptions) {
    if (!this.enabled) {
      return { ...this.currentStatus };
    }
    if (this.stopPromise) {
      await this.stopPromise;
      return await this.ensureRunning(options);
    }
    if (this.ensurePromise) {
      await this.ensurePromise;
      return await this.ensureRunning(options);
    }
    const ensurePromise = this.ensureRunningInternal(options);
    this.ensurePromise = ensurePromise;
    try {
      return await ensurePromise;
    } finally {
      if (this.ensurePromise === ensurePromise) {
        this.ensurePromise = null;
      }
    }
  }

  startInBackground(options: DesktopSpeechTunnelStartOptions) {
    if (!this.enabled) {
      return { ...this.currentStatus };
    }
    void this.ensureRunning(options).catch((error) => {
      this.logger("warn", "[instafy-desktop] desktop speech tunnel background start failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.currentStatus = {
      ...this.currentStatus,
      lastCheckedAt: new Date().toISOString(),
    };
    return { ...this.currentStatus };
  }

  async restart(options: {
    projectId: string;
    controllerUrl: string;
    controllerAccessToken: string;
    controllerCredentialMode?: DesktopSpeechTunnelControllerCredentialMode;
  }) {
    return await this.ensureRunning({
      ...options,
      forceRestart: true,
    });
  }

  async stop() {
    if (this.stopPromise) {
      return await this.stopPromise;
    }
    const stopPromise = this.stopInternal();
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = null;
      }
    }
  }

  private async stopInternal() {
    this.lifecycleGeneration += 1;
    this.shuttingDown = true;
    const handle = this.currentHandle;
    this.currentHandle = null;
    this.currentControllerBinding = null;
    if (handle) {
      await handle.stop().catch(() => undefined);
    }
    this.currentStatus = {
      ...this.currentStatus,
      state: "idle",
      managed: false,
      projectId: undefined,
      controllerUrl: undefined,
      controllerCredentialMode: undefined,
      controllerBindingId: undefined,
      pid: undefined,
      tunnelId: undefined,
      publicUrl: undefined,
      hostname: undefined,
      lastCheckedAt: new Date().toISOString(),
    };
    this.shuttingDown = false;
  }

  private async ensureRunningInternal(options: DesktopSpeechTunnelStartOptions) {
    const lifecycleGeneration = this.lifecycleGeneration;
    const startupIsCurrent = () => lifecycleGeneration === this.lifecycleGeneration;
    const projectId = normalizeOptionalString(options.projectId);
    const controllerUrl = normalizeOptionalString(options.controllerUrl);
    const controllerAccessToken = normalizeOptionalString(options.controllerAccessToken);
    const controllerCredentialMode =
      options.controllerCredentialMode === "ambient" ? "ambient" : "fixed";
    if (!projectId) {
      throw new Error("Desktop speech tunnel requires projectId.");
    }
    if (!controllerUrl) {
      throw new Error("Desktop speech tunnel requires controllerUrl.");
    }
    if (!controllerAccessToken) {
      throw new Error("Desktop speech tunnel requires controllerAccessToken.");
    }

    if (
      this.currentHandle &&
      this.currentControllerBinding &&
      !options.forceRestart &&
      this.currentHandle.projectId === projectId &&
      this.currentControllerBinding.controllerUrl === controllerUrl &&
      this.currentControllerBinding.controllerAccessToken === controllerAccessToken &&
      this.currentControllerBinding.credentialMode === controllerCredentialMode &&
      this.currentHandle.process.exitCode === null
    ) {
      this.currentStatus = {
        ...this.currentStatus,
        state: "active",
        managed: true,
        projectId,
        controllerUrl,
        controllerCredentialMode,
        controllerBindingId: this.currentControllerBinding.id,
        pid: this.currentHandle.pid,
        tunnelId: this.currentHandle.tunnelId,
        publicUrl: this.currentHandle.publicUrl,
        hostname: this.currentHandle.hostname,
        lastCheckedAt: new Date().toISOString(),
      };
      return { ...this.currentStatus };
    }

    const previousHandle = this.currentHandle;
    this.currentHandle = null;
    this.currentControllerBinding = null;

    this.currentStatus = {
      ...this.currentStatus,
      state: "starting",
      managed: false,
      projectId,
      controllerUrl,
      controllerCredentialMode,
      controllerBindingId: undefined,
      pid: undefined,
      tunnelId: undefined,
      publicUrl: undefined,
      hostname: undefined,
      lastCheckedAt: new Date().toISOString(),
      lastError: undefined,
    };

    if (previousHandle) {
      await previousHandle.stop().catch(() => undefined);
    }
    if (!startupIsCurrent()) {
      return { ...this.currentStatus };
    }

    try {
      await this.ensureVoiceHostRunning?.();
      if (!startupIsCurrent()) {
        return { ...this.currentStatus };
      }
      const handle = await this.startTunnelImpl({
        controllerUrl,
        projectId,
        controllerAccessToken,
        localPort: this.localPort,
        readyPath: this.readyPath,
        readyTimeoutMs: this.readyTimeoutMs,
        logger: (message) => {
          this.logger("info", message);
        },
      });
      if (!startupIsCurrent()) {
        await handle.stop().catch((error) => {
          this.logger(
            "warn",
            "[instafy-desktop] failed to stop a late desktop speech tunnel startup",
            {
              message: error instanceof Error ? error.message : String(error),
              projectId,
            },
          );
        });
        return { ...this.currentStatus };
      }
      const controllerBinding: DesktopSpeechTunnelControllerBinding = {
        id: randomUUID(),
        controllerUrl,
        controllerAccessToken,
        credentialMode: controllerCredentialMode,
      };
      this.currentHandle = handle;
      this.currentControllerBinding = controllerBinding;
      this.currentStatus = {
        enabled: true,
        hostMode: "desktop",
        state: "active",
        managed: true,
        projectId,
        controllerUrl,
        controllerCredentialMode,
        controllerBindingId: controllerBinding.id,
        tunnelId: handle.tunnelId,
        publicUrl: handle.publicUrl,
        hostname: handle.hostname,
        localPort: this.localPort,
        readyPath: this.readyPath,
        pid: handle.pid,
        lastCheckedAt: new Date().toISOString(),
        lastStartedAt: new Date().toISOString(),
      };
      void handle.exited.then(({ code, signal }) => {
        if (this.currentHandle !== handle) {
          return;
        }
        this.currentHandle = null;
        this.currentControllerBinding = null;
        this.currentStatus = {
          ...this.currentStatus,
          state: this.shuttingDown ? "idle" : "error",
          managed: false,
          controllerBindingId: undefined,
          pid: undefined,
          lastCheckedAt: new Date().toISOString(),
          lastError:
            this.shuttingDown || (code === 0 && !signal)
              ? undefined
              : `Desktop speech tunnel exited${typeof code === "number" ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}.`,
        };
      });
      return { ...this.currentStatus };
    } catch (error) {
      if (!startupIsCurrent()) {
        return { ...this.currentStatus };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger("warn", "[instafy-desktop] desktop speech tunnel startup failed", {
        message,
        projectId,
      });
      this.currentStatus = {
        ...this.currentStatus,
        state: "error",
        managed: false,
        lastCheckedAt: new Date().toISOString(),
        lastError: message,
      };
      return { ...this.currentStatus };
    }
  }
}

export function createDesktopSpeechTunnelSupervisor(options: DesktopSpeechTunnelSupervisorOptions = {}) {
  return new DesktopSpeechTunnelSupervisor(options);
}
